import { randomUUID } from 'node:crypto';

import { enqueueRank } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';
import {
  TEST_METRICS_TOKEN,
  TEST_ORIGIN,
  apiClient,
  createApiHarness,
  createCapturingMailer,
  createTestSession,
  createTestUser,
  testConfig,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T1 (spec 08 §1, §1.1, §11): authentication, lazy tenant transactions, CSRF, the shared rate
 * limiter and idempotent mutations, exercised through probe routes on a real server over the
 * `bantoozi_app` role.
 */

let h: ApiHarness;
let alice: TestUser;

/** Probe routes added under `/api/v1/probe` before the server is ready. */
async function probeServer(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const server = await buildServer({
    db: h.appDb,
    config: testConfig(env, h.db.urls.app),
    mailer: createCapturingMailer(),
    libreTranslate: null,
    ...(process.env.DEBUG_API === '1'
      ? {
          logger: (await import('@bantoozi/shared/server')).createLogger({
            name: 'test',
            level: 'error',
          }),
        }
      : {}),
  });
  await server.register(
    async (api) => {
      api.get('/public', { config: { auth: 'public' } }, async () => ({ ok: true }));
      api.get('/me', async (request) => ({ userId: request.auth?.userId ?? null }));
      api.get('/admin', { config: { auth: 'admin' } }, async () => ({ ok: true }));
      api.get('/tenant', async (request) =>
        request.withTx(async (tx) => {
          const result = await tx.execute<{ id: string }>(
            sql`SELECT current_setting('app.user_id', true) AS id`,
          );
          return { tenant: result.rows[0]?.id ?? null };
        }),
      );
      api.post('/bearer', { config: { auth: 'metrics' } }, async (request) => ({
        bearer: request.metricsBearer,
      }));
      api.post('/count', async (request, reply) => {
        const outcome = await request.mutate(async (tx, ctx) => {
          await tx.execute(sql`SELECT pg_sleep(0.05)`);
          await enqueueRank(ctx.outbox, {
            userId: request.auth!.userId,
            reason: `probe:${ctx.mutationId}`,
          });
          return { status: 201, body: { mutationId: ctx.mutationId, body: request.body } };
        });
        await reply.code(outcome.status).send(outcome.body);
      });
      api.post(
        '/limited',
        {
          config: {
            auth: 'public',
            rateLimits: [{ group: 'probe', max: 2, windowSeconds: 3600, per: 'ip' }],
          },
        },
        async () => ({ ok: true }),
      );
    },
    { prefix: '/api/v1/probe' },
  );
  await server.ready();
  return server;
}

let server: FastifyInstance;

beforeAll(async () => {
  h = await createApiHarness();
  alice = await createTestUser(h);
  server = await probeServer();
});

afterAll(async () => {
  await server.close();
  await h.close();
});

describe('authentication (spec 08 §1, §2.1)', () => {
  it('rejects a request without a session with 401', async () => {
    const res = await apiClient(server).get('/probe/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a live session and serves public routes without one', async () => {
    expect((await apiClient(server, alice).get('/probe/me')).json()).toEqual({ userId: alice.id });
    expect((await apiClient(server).get('/probe/public')).statusCode).toBe(200);
  });

  it('rejects revoked, expired and deleted-user sessions and malformed cookies', async () => {
    const bob = await createTestUser(h);
    await h.owner.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [bob.sessionId]);
    expect((await apiClient(server, bob).get('/probe/me')).statusCode).toBe(401);

    const carol = await createTestUser(h);
    await h.owner.query(
      "UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [carol.sessionId],
    );
    expect((await apiClient(server, carol).get('/probe/me')).statusCode).toBe(401);

    const dave = await createTestUser(h);
    await h.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [dave.id]);
    expect((await apiClient(server, dave).get('/probe/me')).statusCode).toBe(401);

    const bad = await server.inject({
      method: 'GET',
      url: '/api/v1/probe/me',
      headers: { cookie: 'bantoozi_sid=not-a-token' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('reads the admin role from the current users row on every request', async () => {
    const user = await createTestUser(h);
    expect((await apiClient(server, user).get('/probe/admin')).statusCode).toBe(403);
    await h.owner.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    expect((await apiClient(server, user).get('/probe/admin')).statusCode).toBe(200);
    await h.owner.query("UPDATE users SET role = 'user' WHERE id = $1", [user.id]);
    expect((await apiClient(server, user).get('/probe/admin')).statusCode).toBe(403);
  });

  it('slides the session at most every 5 minutes, re-issuing the cookie', async () => {
    const user = await createTestUser(h);
    const fresh = await apiClient(server, user).get('/probe/me');
    expect(fresh.headers['set-cookie']).toBeUndefined();

    await h.owner.query(
      "UPDATE sessions SET last_seen_at = now() - interval '6 minutes', expires_at = now() + interval '1 day' WHERE id = $1",
      [user.sessionId],
    );
    const slid = await apiClient(server, user).get('/probe/me');
    const cookie = String(slid.headers['set-cookie']);
    expect(cookie).toContain(`bantoozi_sid=${user.token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=(518[0-9]{4})/); // 60 days ≈ 5,184,000 s
    expect(cookie).not.toContain('Secure'); // only in production
    const row = await h.owner.query<{ fresh: boolean; active: boolean }>(
      `SELECT s.expires_at > now() + interval '59 days' AS fresh, u.last_active_at > now() - interval '1 minute' AS active
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
      [user.sessionId],
    );
    expect(row.rows[0]).toEqual({ fresh: true, active: true });
  });
});

describe('tenant transactions (spec 08 §1 "Tenancy")', () => {
  it('opens no transaction for a request that never touches per-user data', async () => {
    const spy = vi.spyOn(h.appDb, 'transaction');
    try {
      expect((await apiClient(server, alice).get('/probe/me')).statusCode).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      expect((await apiClient(server, alice).get('/probe/tenant')).statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('sets app.user_id to the session user inside withTx', async () => {
    const res = await apiClient(server, alice).get('/probe/tenant');
    expect(res.json()).toEqual({ tenant: alice.id });
  });
});

describe('CSRF (spec 08 §1)', () => {
  it('refuses a mutation without X-Bantoozi-Client with 403', async () => {
    const res = await apiClient(server, alice).post('/probe/count', {}, { client: null });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('refuses a foreign, null or malformed Origin and Sec-Fetch-Site: cross-site', async () => {
    const c = apiClient(server, alice);
    for (const origin of ['https://evil.example', 'null', 'not a url', `${TEST_ORIGIN}/path`]) {
      const res = await c.post('/probe/count', {}, { headers: { origin } });
      expect(res.statusCode, origin).toBe(403);
    }
    const cross = await c.post('/probe/count', {}, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.statusCode).toBe(403);
    const same = await c.post(
      '/probe/count',
      {},
      { headers: { origin: TEST_ORIGIN, 'sec-fetch-site': 'same-origin' } },
    );
    expect(same.statusCode).toBe(201);
  });

  it('exempts the METRICS_TOKEN bearer, which carries no cookie', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/probe/bearer',
      headers: { authorization: `Bearer ${TEST_METRICS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bearer: true });
    const wrong = await server.inject({
      method: 'POST',
      url: '/api/v1/probe/bearer',
      headers: { authorization: 'Bearer nope', 'x-bantoozi-client': 'web' },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('refuses CORS preflights', async () => {
    const res = await server.inject({ method: 'OPTIONS', url: '/api/v1/probe/count' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('idempotent mutations (spec 08 §1.1)', () => {
  it('requires a UUID Idempotency-Key', async () => {
    const c = apiClient(server, alice);
    expect((await c.post('/probe/count', {}, { idempotencyKey: null })).statusCode).toBe(400);
    expect((await c.post('/probe/count', {}, { idempotencyKey: 'abc' })).statusCode).toBe(400);
  });

  it('replays the saved response for a retry and refuses a reused key for another request', async () => {
    const c = apiClient(server, alice);
    const key = randomUUID();
    const first = await c.post('/probe/count', { n: 1 }, { idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    const retry = await c.post('/probe/count', { n: 1 }, { idempotencyKey: key });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    const other = await c.post('/probe/count', { n: 2 }, { idempotencyKey: key });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const intents = await h.owner.query("SELECT 1 FROM job_outbox WHERE payload->>'reason' = $1", [
      `probe:${key}`,
    ]);
    expect(intents.rowCount).toBe(1);
  });

  it('serializes concurrent duplicates into one mutation and one outbox intent', async () => {
    const c = apiClient(server, alice);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => c.post('/probe/count', { n: 3 }, { idempotencyKey: key })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const receipts = await h.owner.query('SELECT 1 FROM api_mutations WHERE id = $1', [key]);
    expect(receipts.rowCount).toBe(1);
    const intents = await h.owner.query("SELECT 1 FROM job_outbox WHERE payload->>'reason' = $1", [
      `probe:${key}`,
    ]);
    expect(intents.rowCount).toBe(1);
  });

  it('keys receipts per user, so another user may use the same key', async () => {
    const bob = await createTestUser(h);
    const key = randomUUID();
    expect(
      (await apiClient(server, alice).post('/probe/count', {}, { idempotencyKey: key })).statusCode,
    ).toBe(201);
    const res = await apiClient(server, bob).post('/probe/count', {}, { idempotencyKey: key });
    expect(res.statusCode).toBe(201);
    expect(res.json().mutationId).toBe(key);
  });

  it('writes outbox intents as the requester only (RLS job_outbox_requester)', async () => {
    const other = await createUser(h.owner);
    const insertAs = (requester: string) =>
      h.appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${alice.id}, true)`);
        await tx.execute(sql`
          INSERT INTO job_outbox (queue, payload, user_id)
          VALUES ('user.rank', ${JSON.stringify({ userId: alice.id, reason: 'rls' })}::jsonb,
                  ${requester}::uuid)`);
      });
    await expect(insertAs(other.id)).rejects.toThrow();
    await expect(insertAs(alice.id)).resolves.toBeUndefined();
  });
});

describe('rate limits (spec 08 §11)', () => {
  it('are off when RATE_LIMITS_ENABLED=false (test only)', async () => {
    const c = apiClient(server);
    for (let i = 0; i < 4; i += 1) expect((await c.post('/probe/limited')).statusCode).toBe(200);
  });

  it('refuses RATE_LIMITS_ENABLED=false in production', () => {
    expect(() =>
      testConfig({ NODE_ENV: 'production', RATE_LIMITS_ENABLED: 'false' }, 'postgres://x@db/x'),
    ).toThrow(/RATE_LIMITS_ENABLED/);
  });

  it('share one DB-backed bucket across two API instances and survive a restart', async () => {
    await h.owner.query('DELETE FROM rate_limit_buckets');
    const first = await probeServer({ RATE_LIMITS_ENABLED: 'true' });
    const second = await probeServer({ RATE_LIMITS_ENABLED: 'true' });
    try {
      const a = await apiClient(first).post('/probe/limited');
      expect(a.statusCode).toBe(200);
      expect(a.headers['x-ratelimit-limit']).toBe('2');
      expect((await apiClient(second).post('/probe/limited')).statusCode).toBe(200);
      const third = await apiClient(first).post('/probe/limited');
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await first.close();
    }
    // A "restarted" instance still sees the persisted count.
    try {
      expect((await apiClient(second).post('/probe/limited')).statusCode).toBe(429);
      const restarted = await probeServer({ RATE_LIMITS_ENABLED: 'true' });
      try {
        expect((await apiClient(restarted).post('/probe/limited')).statusCode).toBe(429);
      } finally {
        await restarted.close();
      }
    } finally {
      await second.close();
    }
  });

  it('limit authenticated mutations per user', async () => {
    await h.owner.query('DELETE FROM rate_limit_buckets');
    const limited = await probeServer({ RATE_LIMITS_ENABLED: 'true' });
    try {
      const user = await createTestSession(h, alice);
      const res = await apiClient(limited, user).post('/probe/count', {});
      expect(res.statusCode).toBe(201);
      expect(res.headers['x-ratelimit-limit']).toBe('120');
      const buckets = await h.owner.query<{ key: string }>(
        'SELECT key FROM rate_limit_buckets ORDER BY key',
      );
      expect(buckets.rows.map((r) => r.key)).toEqual(
        expect.arrayContaining([`mutation:user:${alice.id}`, expect.stringMatching(/^all:ip:/)]),
      );
    } finally {
      await limited.close();
    }
  });
});

describe('response privacy (spec 08 §1)', () => {
  it('marks authenticated responses private, no-store', async () => {
    const res = await apiClient(server, alice).get('/probe/me');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
