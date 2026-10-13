import { AppError, EmailSchema, VerifyResponseSchema } from '@bantoozi/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { setSessionCookie } from '../plugins/auth.js';
import { preferredLocale } from '../services/auth.js';
import { completeSetup, ensureSetupToken, setupOpen } from '../services/setup.js';
import type { RateLimitRule } from '../types.js';

/** `POST /setup/complete`: 10 attempts per 15 minutes per IP (a wrong token counts like any other). */
export const SETUP_COMPLETE_IP_LIMIT: RateLimitRule = {
  group: 'setup-complete',
  max: 10,
  windowSeconds: 900,
  per: 'ip',
};

const SetupStateSchema = z.object({ open: z.boolean() }).strict();
const SetupCompleteBodySchema = z
  .object({ token: z.string().max(256), email: EmailSchema })
  .strict();

/**
 * First-run setup (M8b-T6): `GET /setup`, `POST /setup/complete`. Public routes; a wrong token and a
 * closed setup answer the same generic error. Every route uses the OpenAPI tag `setup`.
 */
export const setupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '',
    {
      config: { auth: 'public' },
      schema: {
        tags: ['setup'],
        summary: 'Whether first-run setup is open (no active admin exists)',
        response: { 200: SetupStateSchema },
      },
    },
    async (_request, reply) => {
      void reply.header('cache-control', 'no-store');
      await ensureSetupToken(app.services, app.log);
      return { open: await setupOpen(app.services) };
    },
  );

  app.post(
    '/complete',
    {
      config: { auth: 'public', rateLimits: [SETUP_COMPLETE_IP_LIMIT] },
      schema: {
        tags: ['setup'],
        summary: 'Redeem the setup token: create the first admin and sign in',
        body: SetupCompleteBodySchema,
        response: { 200: VerifyResponseSchema },
      },
    },
    async (request, reply) => {
      const { config, clock } = app.services;
      if (!app.services.setup.ready) {
        // The start-up rotation failed: retry it, but refuse this request (its token predates it).
        await ensureSetupToken(app.services, app.log);
        throw new AppError('INVALID_CODE', 'Invalid setup token');
      }
      const header = request.headers['accept-language'];
      const result = await completeSetup(app.services, {
        token: request.body.token,
        email: request.body.email,
        locale: preferredLocale(typeof header === 'string' ? header : undefined),
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        ip: request.ip,
      });
      if (!result.ok) throw new AppError('INVALID_CODE', 'Invalid setup token');
      setSessionCookie(reply, config, result.token, result.expiresAt, clock.now());
      await reply.header('cache-control', 'private, no-store').send({ user: result.me });
    },
  );
};
