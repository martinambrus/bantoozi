import multipart from '@fastify/multipart';
import {
  MIGRATIONS_FOLDER,
  createPgOriginLimiter,
  readMigrationJournal,
  type Database,
} from '@bantoozi/db';
import { decodeBody, parseFeed, safeFetch, type DiscoverDeps } from '@bantoozi/feeds';
import { systemClock, type Clock } from '@bantoozi/shared';
import { createMailer, type Logger, type Mailer } from '@bantoozi/shared/server';
import { createLibreTranslateClient, type LibreTranslateClient } from '@bantoozi/translate';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { ApiConfig, ApiServices } from './context.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { registerErrorHandlers } from './plugins/errors.js';
import { registerMetrics } from './plugins/metrics.js';
import { createRateLimiter, registerRateLimits } from './plugins/rate-limit.js';
import { openApiRoute, registerSwagger } from './plugins/swagger.js';
import { registerTenant } from './plugins/tenant.js';
import { adminRoutes } from './routes/admin/index.js';
import { articleRoutes } from './routes/articles.js';
import { authRoutes } from './routes/auth.js';
import { cardRoutes } from './routes/cards.js';
import { feedMarkReadRoutes } from './routes/feed-mark-read.js';
import { healthRoutes } from './routes/health.js';
import { inviteRoutes } from './routes/invites.js';
import { labelRoutes } from './routes/labels.js';
import { libraryRoutes } from './routes/library.js';
import { meRoutes } from './routes/me.js';
import { opsRoutes } from './routes/ops.js';
import { ruleRoutes } from './routes/rules.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { createCursorCodec } from './services/cursor.js';
import './types.js';

export const API_PREFIX = '/api/v1';
/** JSON bodies are limited to 1 MiB (spec 08 §1). */
export const BODY_LIMIT_BYTES = 1024 * 1024;
/** Multipart OPML uploads have their own cap (spec 08 §4, spec 03 §11). */
export const OPML_UPLOAD_LIMIT_BYTES = 1024 * 1024;

/**
 * Proxy addresses whose forwarded headers are trusted: loopback and the private networks the
 * compose stack's Caddy reaches the API from (spec 08 §11: never `trustProxy: true`). The API port
 * is not published outside that network (spec 11).
 */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
];

export interface BuildServerOptions {
  /** Drizzle over the `bantoozi_app` pool (RLS enforced). */
  db: Database;
  config: ApiConfig;
  /** A pino logger; omitted in tests. */
  logger?: Logger;
  /** Default: from `MAIL_TRANSPORT`/`SMTP_URL`/`MAIL_FROM`. */
  mailer?: Mailer;
  clock?: Clock;
  /** Default: `safeFetch` with the fetch configuration and the shared origin limiter. */
  discoverDeps?: DiscoverDeps;
  /** Default: a client for `LIBRETRANSLATE_URL`; `null` disables card-text translation. */
  libreTranslate?: LibreTranslateClient | null;
  /** The bundled migrations whose newest entry `/readyz` expects (default: packages/db/drizzle). */
  migrationsFolder?: string;
  trustedProxies?: readonly string[];
}

function defaultDiscoverDeps(db: Database, config: ApiConfig, clock: Clock): DiscoverDeps {
  const limiter = createPgOriginLimiter(db);
  return {
    fetch: (url, options) =>
      safeFetch(url, {
        purpose: 'discovery',
        userAgent: config.fetchUserAgent,
        maxBytes: config.fetchMaxBytes,
        allowPrivate: config.fetchAllowPrivate,
        limiter,
        timeoutMs: Math.min(options.timeoutMs ?? config.fetchTimeoutMs, config.fetchTimeoutMs),
        ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        now: () => clock.now().getTime(),
      }),
    parse: parseFeed,
    decode: decodeBody,
    allowPrivate: config.fetchAllowPrivate,
    now: () => clock.now().getTime(),
  };
}

/** Registers plugins and routes; never listens (spec 01 §2). */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const clock = options.clock ?? systemClock;
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: [...(options.trustedProxies ?? DEFAULT_TRUSTED_PROXIES)],
    ...(options.logger === undefined
      ? { logger: false }
      : { loggerInstance: options.logger as FastifyBaseLogger }),
  }).withTypeProvider<ZodTypeProvider>();

  const services: ApiServices = {
    db,
    config,
    clock,
    mailer:
      options.mailer ??
      createMailer({
        transport: config.mailTransport,
        from: config.mailFrom,
        smtpUrl: config.smtpUrl,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      }),
    cursors: createCursorCodec(config.sessionPepper, () => clock.now()),
    limiter: createRateLimiter(db, config.rateLimitsEnabled),
    discoverDeps: options.discoverDeps ?? defaultDiscoverDeps(db, config, clock),
    libreTranslate:
      options.libreTranslate === undefined
        ? createLibreTranslateClient({ baseUrl: config.libretranslateUrl, clock })
        : options.libreTranslate,
  };
  app.decorate('services', services);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  registerMetrics(app);

  // Hook order: the per-IP limit, CSRF and authentication run on every request before parsing;
  // per-user and route limits follow authentication (they need the user id).
  registerRateLimits(app, services.limiter);
  registerCsrf(app);
  registerAuth(app);
  registerTenant(app);

  // Authenticated responses are private and never cached (spec 08 §1 "Validation and privacy").
  app.addHook('onSend', async (request, reply) => {
    if (request.auth !== null && reply.getHeader('cache-control') === undefined) {
      void reply.header('cache-control', 'private, no-store');
    }
  });
  app.addHook('onClose', async () => {
    if (options.mailer === undefined) services.mailer.close();
    if (options.libreTranslate === undefined) await services.libreTranslate?.close();
  });

  await registerSwagger(app);
  await app.register(multipart, {
    limits: { fileSize: OPML_UPLOAD_LIMIT_BYTES, files: 1, fields: 0, parts: 1 },
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, {
        db,
        journal: readMigrationJournal(options.migrationsFolder ?? MIGRATIONS_FOLDER),
      });
      await api.register(openApiRoute);
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(inviteRoutes);
      await api.register(meRoutes, { prefix: '/me' });
      await api.register(subscriptionRoutes);
      await api.register(feedMarkReadRoutes);
      await api.register(articleRoutes, { prefix: '/articles' });
      await api.register(cardRoutes);
      await api.register(labelRoutes, { prefix: '/labels' });
      await api.register(libraryRoutes);
      await api.register(ruleRoutes, { prefix: '/rules' });
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(opsRoutes);
    },
    { prefix: API_PREFIX },
  );
  return app;
}
