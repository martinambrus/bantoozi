import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  TEST_METRICS_TOKEN,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T9 (spec 08 §9, §10; spec 11 §6.1): `POST /admin/ops-event` for host scripts with the
 * `METRICS_TOKEN` bearer, `GET /metrics` for an admin or the bearer, and `GET /dev/last-email`,
 * which exists only when `NODE_ENV=test`.
 */

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;

const bearer = { authorization: `Bearer ${TEST_METRICS_TOKEN}` };

function opsEvent(
  server: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = bearer,
) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/admin/ops-event',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

async function storedEvents(): Promise<{ kind: string; detail: string; at: string }[]> {
  const result = await h.owner.query<{ value: { kind: string; detail: string; at: string }[] }>(
    "SELECT value FROM settings WHERE key = 'ops.events'",
  );
  return result.rows[0]?.value ?? [];
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query("DELETE FROM settings WHERE key = 'ops.events'");
});

describe('POST /admin/ops-event (spec 08 §9)', () => {
  it('records a bearer event without CSRF or idempotency headers', async () => {
    const res = await opsEvent(h.server, { kind: 'backup_ok', detail: 'nightly dump 42 MB' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'backup_ok', stored: 1 });
    expect(res.json().at).toEqual(expect.any(String));
    expect(await storedEvents()).toEqual([
      { kind: 'backup_ok', detail: 'nightly dump 42 MB', at: res.json().at },
    ]);

    const bare = await opsEvent(h.server, { kind: 'restore_failed' });
    expect(bare.statusCode).toBe(201);
    expect((await storedEvents()).at(-1)).toMatchObject({ kind: 'restore_failed', detail: '' });
  });

  it('stores host_health as canonical structured JSON', async () => {
    const detail = {
      host: 'vps-1',
      filesystems: [{ mount: '/', usedPct: 81.5, freeBytes: 1024 }],
      heartbeats: { backup: new Date().toISOString() },
    };
    const res = await opsEvent(h.server, { kind: 'host_health', detail });
    expect(res.statusCode).toBe(201);
    const [stored] = await storedEvents();
    expect(stored?.kind).toBe('host_health');
    expect(JSON.parse(stored!.detail)).toEqual(detail);

    for (const bad of [
      { kind: 'host_health', detail: 'free text' },
      { kind: 'host_health', detail: { host: 'bad host!' } },
      { kind: 'host_health', detail: { unknown: 1 } },
      { kind: 'backup_ok', detail: { not: 'text' } },
      { kind: 'backup_ok', detail: 'bell\u0007' },
      { kind: 'backup_ok', detail: 'x'.repeat(2001) },
      { kind: 'disk_full' },
      {},
    ]) {
      const rejected = await opsEvent(h.server, bad);
      expect(rejected.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(rejected.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect(await storedEvents()).toHaveLength(1);
  });

  it('keeps only the last 50 events', async () => {
    for (let i = 0; i < 52; i += 1) {
      const res = await opsEvent(h.server, { kind: 'backup_ok', detail: `run ${i}` });
      expect(res.statusCode).toBe(201);
    }
    const events = await storedEvents();
    expect(events).toHaveLength(50);
    expect(events[0]?.detail).toBe('run 2');
    expect(events.at(-1)?.detail).toBe('run 51');
  });

  it('accepts only the bearer: no token, a wrong token or an admin session are refused', async () => {
    // Without the bearer the route is an ordinary cookie mutation: CSRF applies first.
    expect((await opsEvent(h.server, { kind: 'backup_ok' }, {})).statusCode).toBe(403);
    const web = { 'x-bantoozi-client': 'web' };
    expect((await opsEvent(h.server, { kind: 'backup_ok' }, web)).statusCode).toBe(401);
    expect(
      (
        await opsEvent(
          h.server,
          { kind: 'backup_ok' },
          {
            ...web,
            authorization: 'Bearer wrong-token',
          },
        )
      ).statusCode,
    ).toBe(401);
    const asAdmin = await apiClient(h.server, admin).post('/admin/ops-event', {
      kind: 'backup_ok',
    });
    expect(asAdmin.statusCode).toBe(401);
    expect(await storedEvents()).toEqual([]);
  });
});

describe('GET /metrics (spec 08 §10)', () => {
  it('serves Prometheus text to the bearer and to admins only', async () => {
    // Generate some traffic, including an error, so every family has samples.
    await apiClient(h.server, reader).get('/admin/overview');
    const res = await h.server.inject({ method: 'GET', url: '/api/v1/metrics', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('bantoozi_api_http_requests_total');
    expect(res.body).toContain('bantoozi_api_http_request_duration_seconds_bucket');
    expect(res.body).toMatch(/bantoozi_api_http_errors_total\{code="FORBIDDEN"\} [1-9]/);
    // Route patterns, never raw URLs with ids.
    expect(res.body).toContain('route="/api/v1/admin/overview"');

    expect((await apiClient(h.server, admin).get('/metrics')).statusCode).toBe(200);
    expect((await apiClient(h.server, reader).get('/metrics')).statusCode).toBe(403);
    expect((await apiClient(h.server).get('/metrics')).statusCode).toBe(401);
  });
});

describe('GET /dev/last-email (spec 08 §10)', () => {
  it('returns the last captured email in the test environment', async () => {
    h.mailer.sent.length = 0;
    const client = apiClient(h.server);
    expect((await client.get('/dev/last-email')).json()).toEqual({ email: null });
    await h.mailer.send({ to: 'a@example.test', subject: 'Hello', text: 'Code: 123456' });
    const res = await client.get('/dev/last-email');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: { to: 'a@example.test', subject: 'Hello', text: 'Code: 123456' },
    });
  });

  it('is not registered outside NODE_ENV=test', async () => {
    const dev = await h.buildAnother({
      env: { NODE_ENV: 'development', RATE_LIMITS_ENABLED: 'true' },
    });
    const res = await apiClient(dev).get('/dev/last-email');
    expect(res.statusCode).toBe(404);
  });
});
