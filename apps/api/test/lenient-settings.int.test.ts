import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

let h: ApiHarness;
let admin: TestUser;
beforeAll(async () => {
  h = await createApiHarness({
    env: {
      PROVIDER_MASTER_KEY_ID: 'k1',
      PROVIDER_MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') }),
    },
  });
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});
afterAll(async () => {
  await h?.close();
});
const put = (key: string, value: unknown) =>
  h.owner.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)],
  );

it('reads future nested settings in the API and preserves them after an admin edit', async () => {
  await put('ranker.thresholds', { model: { historyDays: 90, future: 2 }, future: 1 });
  await put('engine.laya', { enrich: ['en'], future: 3 });
  await put('fetch.limits', { timeoutMs: 2000, maxBytes: 65536, future: 4 });
  const read = await apiClient(h.server, admin).get('/admin/settings');
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().values['ranker.thresholds']).toEqual({ model: { historyDays: 90 } });
  expect(read.json().values['fetch.limits']).toEqual({ timeoutMs: 2000, maxBytes: 65536 });
  const changed = await apiClient(h.server, admin).patch('/admin/settings', {
    'ranker.thresholds': { model: { historyDays: 120 } },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  const stored = await h.owner.query('SELECT value FROM settings WHERE key = $1', [
    'ranker.thresholds',
  ]);
  expect(stored.rows[0].value).toEqual({ model: { historyDays: 120, future: 2 }, future: 1 });
  const invalid = await apiClient(h.server, admin).patch('/admin/settings', {
    'engine.laya': { enrich: ['en'], future: 3 },
  });
  expect(invalid.statusCode).toBe(400);
});

it('reads future model rows and requests a breaker reset without dropping nested future fields', async () => {
  const at = new Date().toISOString();
  await put('engine.model_pin', {
    model: 'jev-1.2.3',
    since: at,
    llm: { fast: 'a', strong: 'b', future: 1 },
    future: 2,
  });
  await put('engine.model_resolution', {
    alias: 'jev-latest',
    model: 'jev-1.2.3',
    resolvedAt: at,
    checkedAt: at,
    previous: { model: 'jev-1.2.2', until: at, future: 1 },
    future: 2,
  });
  await put('engine.model_probe', {
    'jev-1.2.3': { requested: 'jev-1.2.3', answered: 'jev-1.2.3', ok: true, at, future: 1 },
  });
  await put('engine.model_watch', { lastCheck: { at, ok: true, future: 1 }, future: 2 });
  await put('engine.model_impact', { at, activeModels: 7, future: 1 });
  const model = await apiClient(h.server, admin).get('/admin/engine/model');
  expect(model.statusCode, model.body).toBe(200);
  expect(model.json().pin.model).toBe('jev-1.2.3');
  expect(model.json().resolution.previous).toEqual({ model: 'jev-1.2.2', until: at });
  expect(model.json().probes['jev-1.2.3'].ok).toBe(true);
  expect(model.json().impact.activeModels).toBe(7);
  const closed = { state: 'closed', reopenCount: 0 };
  const circuit = {
    typesafe: { ...closed, future: 1 },
    llm: closed,
    resetRequested: { future: 2 },
    future: 3,
  };
  await put('engine.circuit', circuit);
  const reset = await apiClient(h.server, admin).post('/admin/engine/reset-breaker', {
    engine: 'typesafe',
  });
  expect(reset.statusCode, reset.body).toBe(200);
  const stored = await h.owner.query('SELECT value FROM settings WHERE key = $1', [
    'engine.circuit',
  ]);
  expect(stored.rows[0].value).toEqual({
    ...circuit,
    resetRequested: { future: 2, typesafe: reset.json().resetRequestedAt },
  });
});

it.each(['existing', 'missing'] as const)(
  'preserves concurrent future breaker fields during API credential activation and duplicate replay (%s row)',
  async (initial) => {
    const client = apiClient(h.server, admin);
    await h.owner.query('DELETE FROM provider_credentials');
    const staged = await client.put('/admin/engine/credentials/typesafe', {
      apiKey: 'lenient-test-provider-key-0001',
      expectedRevision: '0',
    });
    expect(staged.statusCode, staged.body).toBe(200);
    await h.owner.query(
      "UPDATE provider_credentials SET candidate_status = 'valid', validated_at = now() WHERE provider = 'typesafe'",
    );
    const circuit = {
      typesafe: { state: 'auth', reopenCount: 1, future: 1 },
      llm: { state: 'closed', reopenCount: 0 },
      resetRequested: {},
      future: 2,
    };
    if (initial === 'existing') await put('engine.circuit', circuit);
    else await h.owner.query("DELETE FROM settings WHERE key = 'engine.circuit'");
    const blocker = await h.owner.connect();
    const key = randomUUID();
    const body = { candidateVersion: '1', expectedRevision: '1' };
    let pending: ReturnType<typeof client.post>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL statement_timeout = '3000ms'");
      await blocker.query(
        "SELECT 1 FROM provider_credentials WHERE provider = 'typesafe' FOR UPDATE",
      );
      const xid = (await blocker.query<{ xid: string }>('SELECT txid_current()::text AS xid'))
        .rows[0]!.xid;
      pending = [
        client.post('/admin/engine/credentials/typesafe/activate', body, { idempotencyKey: key }),
        client.post('/admin/engine/credentials/typesafe/activate', body, { idempotencyKey: key }),
      ];
      await vi.waitFor(
        async () => {
          const locks = await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND transactionid = $1::xid AND NOT granted",
            [xid],
          );
          expect(locks.rows[0]?.n).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 },
      );
      if (initial === 'existing') {
        await blocker.query(
          "UPDATE settings SET value = jsonb_set(value, '{typesafe,future}', '9'::jsonb) WHERE key = 'engine.circuit'",
        );
      } else {
        await blocker.query(
          "INSERT INTO settings (key, value) VALUES ('engine.circuit', $1::jsonb)",
          [JSON.stringify({ ...circuit, typesafe: { ...circuit.typesafe, future: 9 } })],
        );
      }
      await blocker.query('COMMIT');
      const responses = await Promise.all(pending);
      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      expect(responses[1]!.json()).toEqual(responses[0]!.json());
      const row = await h.owner.query('SELECT value FROM settings WHERE key = $1', [
        'engine.circuit',
      ]);
      expect(row.rows[0].value).toEqual({
        ...circuit,
        typesafe: { state: 'closed', reopenCount: 0, future: 9 },
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await Promise.allSettled(pending);
    }
  },
);
