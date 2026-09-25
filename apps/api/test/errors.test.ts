import { AppError } from '@bantoozi/shared';
import Fastify from 'fastify';
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
