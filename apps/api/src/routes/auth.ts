import { listSessions, revokeSession } from '@bantoozi/db';
import {
  AppError,
  RequestCodeBodySchema,
  RequestCodeResponseSchema,
  SessionListSchema,
  SessionParamsSchema,
  VerifyBodySchema,
  VerifyResponseSchema,
} from '@bantoozi/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clearSessionCookie, setSessionCookie } from '../plugins/auth.js';
import { padResponse, requestLoginCode, verifyLoginCode } from '../services/auth.js';
import type { RateLimitRule } from '../types.js';

/** `POST /auth/request-code`: 20 per hour per IP; the per-email limit is applied in the handler. */
export const REQUEST_CODE_IP_LIMIT: RateLimitRule = {
  group: 'auth-request-code',
  max: 20,
  windowSeconds: 3600,
  per: 'ip',
};
/** `POST /auth/verify`: 10 per 10 minutes per IP (spec 08 §11). */
export const VERIFY_IP_LIMIT: RateLimitRule = {
  group: 'auth-verify',
  max: 10,
  windowSeconds: 600,
  per: 'ip',
};

const NoContentSchema = z.null().describe('No content');
const EmptyBodySchema = z.object({}).strict().optional();

const invalidCode = () => new AppError('INVALID_CODE', 'Invalid or expired code');

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Replace any cookie set earlier in this request (e.g. a sliding refresh) with `value`. */
function replaceCookie(reply: FastifyReply, value: string): void {
  reply.removeHeader('set-cookie');
  void reply.header('set-cookie', value);
}

/** Sign-in codes, verification, logout and sessions (spec 08 §2.1). Mounted under `/auth`. */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/request-code',
    {
      config: { auth: 'public', rateLimits: [REQUEST_CODE_IP_LIMIT] },
      schema: {
        tags: ['auth'],
        summary: 'Email a sign-in or signup code (always 202)',
        body: RequestCodeBodySchema,
        response: { 202: RequestCodeResponseSchema },
      },
    },
    async (request, reply) => {
      const startedAt = performance.now();
      try {
        await requestLoginCode(
          app.services,
          {
            email: request.body.email,
            inviteCode: request.body.inviteCode,
            locale: request.body.locale,
            acceptLanguage: header(request, 'accept-language'),
            ip: request.ip,
          },
          request.log,
        );
      } finally {
        await padResponse(startedAt);
      }
      await reply.code(202).header('cache-control', 'no-store').send({ next: 'check_email' });
    },
  );

  app.post(
    '/verify',
    {
      config: { auth: 'public', rateLimits: [VERIFY_IP_LIMIT] },
      schema: {
        tags: ['auth'],
        summary: 'Verify a code: sign in or sign up and set the session cookie',
        body: VerifyBodySchema,
        response: { 200: VerifyResponseSchema },
      },
    },
    async (request, reply) => {
      const { config, clock } = app.services;
      const result = await verifyLoginCode(
        app.services,
        {
          email: request.body.email,
          code: request.body.code,
          acceptLanguage: header(request, 'accept-language'),
          userAgent: header(request, 'user-agent') ?? null,
          ip: request.ip,
        },
        request.log,
      );
      // The attempt counter (or the consumption) has committed; now answer generically.
      if (!result.ok) throw invalidCode();
      setSessionCookie(reply, config, result.token, result.expiresAt, clock.now());
      await reply.header('cache-control', 'private, no-store').send({ user: result.me });
    },
  );

  app.post(
    '/logout',
    {
      config: { auth: 'user', authFlow: true },
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session and clear the cookie',
        body: EmptyBodySchema,
        response: { 204: NoContentSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      await revokeSession(app.services.db, { userId: auth.userId, sessionId: auth.sessionId });
      replaceCookie(reply, clearSessionCookie(app.services.config));
      await reply.code(204).send(null);
    },
  );

  app.get(
    '/sessions',
    {
      config: { auth: 'user' },
      schema: {
        tags: ['auth'],
        summary: "The caller's active sessions",
        response: { 200: SessionListSchema },
      },
    },
    async (request) => {
      const auth = request.auth!;
      const sessions = await listSessions(app.services.db, auth.userId);
      return sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        current: session.id === auth.sessionId,
      }));
    },
  );

  app.delete(
    '/sessions/:id',
    {
      config: { auth: 'user' },
      schema: {
        tags: ['auth'],
        summary: 'Revoke one of my sessions',
        params: SessionParamsSchema,
        response: { 204: NoContentSchema },
      },
    },
    async (request, reply) => {
      const auth = request.auth!;
      const { id } = request.params;
      await request.mutate(async (tx) => {
        const revoked = await revokeSession(tx, { userId: auth.userId, sessionId: id });
        // Another user's (or an ended) session: 404 without revealing which.
        if (!revoked) throw new AppError('NOT_FOUND', 'Session not found');
        return { status: 204, body: null };
      });
      if (id === auth.sessionId) replaceCookie(reply, clearSessionCookie(app.services.config));
      await reply.code(204).send(null);
    },
  );
};
