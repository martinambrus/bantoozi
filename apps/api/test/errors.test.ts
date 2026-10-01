import { AppError, type AppErrorCode } from '@bantoozi/shared';
import Fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { registerErrorHandlers } from '../src/plugins/errors.js';

async function app() {
  const server = Fastify({ logger: false });
  registerErrorHandlers(server);
  server.get('/app-error', async () => {
    throw new AppError('QUOTA_EXCEEDED', 'Quota feeds exceeded', { details: { limit: 'feeds' } });
  });
  server.get('/db-error', async () => {
    throw Object.assign(new Error('duplicate key value violates "users_email_unique" (x@y.z)'), {
      code: '23505',
    });
  });
  server.get('/crash', async () => {
    throw new Error('secret internal detail');
  });
  server.post('/json', async () => ({ ok: true }));
  return server;
}

describe('error envelope (spec 08 §1)', () => {
  it('maps an AppError to its status and envelope', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'Quota feeds exceeded',
        details: { limit: 'feeds' },
      },
    });
  });

  it('maps known database errors without passing their text through', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/db-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(res.body).not.toContain('x@y.z');
  });

  it('turns unknown errors into a generic 500 with the request id', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Internal error',
        details: { requestId: expect.any(String) },
      },
    });
    expect(res.body).not.toContain('secret');
  });

  it('answers unknown routes and malformed bodies with the envelope', async () => {
    const server = await app();
    const missing = await server.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    const malformed = await server.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('error mapping table (spec 08 §1)', () => {
  const table: Record<string, number> = {
    VALIDATION_FAILED: 400,
    INVALID_CODE: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    STALE_CURSOR: 409,
    STALE_STATE: 409,
    IDEMPOTENCY_CONFLICT: 409,
    QUOTA_EXCEEDED: 409,
    INVITE_REQUIRED: 403,
    RATE_LIMITED: 429,
    FEED_NOT_A_FEED: 422,
    FEED_TIMEOUT: 422,
    FEED_HTTP_404: 422,
    ENGINE_UNAVAILABLE: 503,
    INTERNAL: 500,
  };

  it.each(Object.entries(table))('%s → %i', async (code, status) => {
    const server = Fastify({ logger: false });
    registerErrorHandlers(server);
    server.get('/e', async () => {
      throw new AppError(code as AppErrorCode, 'x');
    });
    const res = await server.inject({ method: 'GET', url: '/e' });
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
  });

  it('reports where a body failed zod validation without echoing values', async () => {
    const server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    registerErrorHandlers(server);
    server.post(
      '/v',
      { schema: { body: z.object({ email: z.string().email() }).strict() } },
      async () => ({ ok: true }),
    );
    const res = await server.inject({
      method: 'POST',
      url: '/v',
      payload: { email: 'secret-value', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.details.issues.length).toBeGreaterThan(0);
    expect(res.body).not.toContain('secret-value');
  });
});
