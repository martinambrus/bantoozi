import { randomUUID } from 'node:crypto';

import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  createPool,
  createSession,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import type { DiscoverDeps } from '@bantoozi/feeds';
import type { Clock } from '@bantoozi/shared';
import { loadConfig, type EmailMessage, type Mailer } from '@bantoozi/shared/server';
import {
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import type { LibreTranslateClient } from '@bantoozi/translate';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import type { ApiConfig } from '../../src/context.js';
import { newSessionToken } from '../../src/plugins/auth.js';
import { buildServer } from '../../src/server.js';

/**
 * The API integration harness (spec 08 §12): a per-file test database cloned from the migrated
 * template, the server built over a `bantoozi_app` pool (RLS and column grants apply exactly as in
 * production), owner/worker pools for fixtures and assertions, a capturing mailer and helpers for
 * authenticated requests. Fixtures written through `owner` bypass RLS and API grants.
 */

export const TEST_PEPPER = 'test-session-pepper-0123456789abcdef0123456789';
export const TEST_METRICS_TOKEN = 'test-metrics-token-0123456789abcdef0123456789';
export const TEST_PUBLIC_BASE_URL = 'http://localhost:5173';
export const TEST_ORIGIN = 'http://localhost:5173';

/** A mailer that records every message (and can be told to fail), like `MAIL_TRANSPORT=log`. */
export interface CapturingMailer extends Mailer {
  readonly sent: EmailMessage[];
  /** While true, `send` rejects (SMTP failure). */
  failing: boolean;
}

export function createCapturingMailer(): CapturingMailer {
  const sent: EmailMessage[] = [];
  const mailer: CapturingMailer = {
    transport: 'log',
    sent,
    failing: false,
    send(message) {
      if (mailer.failing) return Promise.reject(new Error('smtp unavailable'));
      sent.push({ ...message });
      return Promise.resolve();
    },
    lastEmail: () => {
      const last = sent.at(-1);
      return last === undefined ? undefined : { ...last };
    },
    close: () => undefined,
  };
  return mailer;
}

export interface HarnessOptions {
  /** Extra/overriding environment for `loadConfig({process: 'api'})`. */
  env?: Record<string, string>;
  clock?: Clock;
  discoverDeps?: DiscoverDeps;
  libreTranslate?: LibreTranslateClient | null;
}

export interface ApiHarness {
  db: TestDatabase;
  /** Drizzle over the `bantoozi_app` pool the server uses. */
  appDb: Database;
  appPool: ReturnType<typeof createPool>;
  /** Owner connection: fixtures and assertions that bypass RLS. */
  owner: ReturnType<typeof createPool>;
  /** Worker connection (BYPASSRLS), for worker-side fixtures. */
  worker: ReturnType<typeof createPool>;
  server: FastifyInstance;
  config: ApiConfig;
  mailer: CapturingMailer;
  /** Build another server over the same database (e.g. a second API instance). */
  buildAnother(options?: HarnessOptions): Promise<FastifyInstance>;
  close(): Promise<void>;
}

export function testConfig(env: Record<string, string> = {}, databaseUrl = ''): ApiConfig {
  return loadConfig({
    process: 'api',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl || 'postgres://unused@localhost/unused',
      SESSION_PEPPER: TEST_PEPPER,
      METRICS_TOKEN: TEST_METRICS_TOKEN,
      PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL,
      MAIL_TRANSPORT: 'log',
      RATE_LIMITS_ENABLED: 'false',
      LIBRETRANSLATE_URL: 'http://127.0.0.1:9',
      ...env,
    },
  });
}

/** Unused by default: tests that subscribe pass fakes (no network in tests, spec 01 §5). */
const offlineDiscoverDeps: DiscoverDeps = {
  fetch: () => Promise.reject(new Error('network disabled in tests')),
  parse: () => Promise.reject(new Error('network disabled in tests')),
  decode: () => {
    throw new Error('network disabled in tests');
  },
};

export async function createApiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const db = await setupTestDatabase({
    pkg: 'api',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  const appPool = createPool({ connectionString: db.urls.app, max: 8 });
  const owner = createPool({ connectionString: db.urls.owner, max: 4 });
  const worker = createPool({ connectionString: db.urls.worker, max: 4 });
  const appDb = createDatabase(appPool);
  const mailer = createCapturingMailer();
  const servers: FastifyInstance[] = [];
  const build = async (o: HarnessOptions) => {
    const config = testConfig(o.env, db.urls.app);
    const server = await buildServer({
      db: appDb,
      config,
      mailer,
      discoverDeps: o.discoverDeps ?? offlineDiscoverDeps,
      libreTranslate: o.libreTranslate ?? null,
      ...(o.clock === undefined ? {} : { clock: o.clock }),
    });
    await server.ready();
    servers.push(server);
    return { server, config };
  };
  const { server, config } = await build(options);
  return {
    db,
    appDb,
    appPool,
    owner,
    worker,
    server,
    config,
    mailer,
    buildAnother: async (o = {}) => (await build({ ...options, ...o })).server,
    async close() {
      for (const s of servers) await s.close();
      await appPool.end();
      await owner.end();
      await worker.end();
      await dropCreatedTestDatabases();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  sessionId: string;
  token: string;
  /** `Cookie` header value. */
  cookie: string;
}

/** A user row (via the owner) plus a live session, as after a successful verify. */
export async function createTestUser(
  h: ApiHarness,
  overrides: Parameters<typeof createUser>[1] = {},
): Promise<TestUser> {
  const user = await createUser(h.owner, overrides);
  return createTestSession(h, user);
}

/** A new session for an existing user. */
export async function createTestSession(
  h: ApiHarness,
  user: { id: string; email: string },
): Promise<TestUser> {
  const { token, tokenHash } = newSessionToken();
  const session = await createSession(createDatabase(h.owner), {
    userId: user.id,
    tokenHash,
    userAgent: 'vitest',
    ip: '127.0.0.1',
    ttlDays: h.config.sessionTtlDays,
  });
  return {
    id: user.id,
    email: user.email,
    sessionId: session.sessionId,
    token,
    cookie: `${h.config.sessionCookieName}=${token}`,
  };
}

export interface RequestOptions {
  /** Defaults to a fresh UUID for mutations; pass `null` to omit the header. */
  idempotencyKey?: string | null;
  /** Defaults to `web`; pass `null` to omit the CSRF header. */
  client?: string | null;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface ApiClient {
  get(url: string, options?: RequestOptions): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  put(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown, options?: RequestOptions): Promise<LightMyRequestResponse>;
  delete(
    url: string,
    options?: RequestOptions & { body?: unknown },
  ): Promise<LightMyRequestResponse>;
}

/**
 * Requests against `/api/v1` as `user` (anonymous when omitted). Mutations carry the CSRF header and
 * a fresh `Idempotency-Key` unless told otherwise.
 */
export function apiClient(server: FastifyInstance, user?: TestUser | null): ApiClient {
  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body: unknown,
    options: RequestOptions = {},
  ) => {
    const mutating = method !== 'GET';
    const headers: Record<string, string> = { ...options.headers };
    if (user) headers.cookie = user.cookie;
    if (mutating) {
      const client = options.client === undefined ? 'web' : options.client;
      if (client !== null) headers['x-bantoozi-client'] = client;
      const key = options.idempotencyKey === undefined ? randomUUID() : options.idempotencyKey;
      if (key !== null) headers['idempotency-key'] = key;
    }
    return server.inject({
      method,
      url: url.startsWith('/api/') ? url : `/api/v1${url}`,
      headers,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(body === undefined ? {} : { payload: body as NonNullable<InjectOptions['payload']> }),
    });
  };
  return {
    get: (url, options) => send('GET', url, undefined, options),
    post: (url, body, options) => send('POST', url, body ?? {}, options),
    put: (url, body, options) => send('PUT', url, body ?? {}, options),
    patch: (url, body, options) => send('PATCH', url, body ?? {}, options),
    delete: (url, options) => send('DELETE', url, options?.body, options),
  };
}
