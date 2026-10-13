import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M8b-T9 (scope A4, spec 08 §9.1): `GET /admin/engine/credentials` also reports the keyring state.
 *
 * Shape chosen here (the web tests use it too):
 *   keyring: { api: {status, activeKeyId?}, workers: [{workerId, status, activeKeyId?}], mismatch }
 *   - status is ProviderKeyring.parse's verdict: ok | missing | malformed | active_key_missing.
 *   - activeKeyId only when status is ok (as in the T5 heartbeat); never any key material.
 *   - workers: one entry per FRESH (<= 90 s) heartbeat entry that has `runtime.keyring`, keyed by the
 *     heartbeat's process id; entries without it (an older worker) and stale ones are left out.
 *   - mismatch: true only when the API and at least one worker are both ok and their active key ids
 *     differ. A worker that is not ok is a status problem, not a mismatch.
 */

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const KEYS = JSON.stringify({ k1: K1, k2: K2 });

let h: ApiHarness;
let admin: TestUser;
let ok: FastifyInstance;

async function seedHeartbeat(entries: Record<string, unknown>): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(entries)],
  );
}

function beat(keyring: Record<string, unknown> | undefined, ageMs = 0) {
  return {
    at: new Date(Date.now() - ageMs).toISOString(),
    queues: ['provider.validate'],
    evalIngestOnly: false,
    envCredentials: [],
    ...(keyring === undefined ? {} : { runtime: { keyring } }),
  };
}

async function keyringOf(server: FastifyInstance) {
  const res = await apiClient(server, admin).get('/admin/engine/credentials');
  expect(res.statusCode).toBe(200);
  return { body: res.json(), raw: res.body };
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  ok = await h.buildAnother({ env: { PROVIDER_MASTER_KEY_ID: 'k1', PROVIDER_MASTER_KEYS: KEYS } });
}, 120_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query("DELETE FROM settings WHERE key = 'worker.heartbeat'");
});

describe('keyring status of the API (spec 08 §9.1)', () => {
  it('reports ok with the active key id and no workers', async () => {
    const { body } = await keyringOf(ok);
    expect(body.keyring).toEqual({
      api: { status: 'ok', activeKeyId: 'k1' },
      workers: [],
      mismatch: false,
    });
    expect(body.items).toHaveLength(2);
  });

  it.each([
    ['missing', {}],
    ['malformed', { PROVIDER_MASTER_KEY_ID: 'k1', PROVIDER_MASTER_KEYS: '{not json' }],
    ['active_key_missing', { PROVIDER_MASTER_KEY_ID: 'k9', PROVIDER_MASTER_KEYS: KEYS }],
  ] as const)('reports %s for the API own environment, without an id', async (status, env) => {
    const server = await h.buildAnother({ env });
    const { body, raw } = await keyringOf(server);
    expect(body.keyring.api).toEqual({ status });
    expect(raw).not.toContain(K1);
    expect(raw).not.toContain(K2);
    expect(raw).not.toContain('{not json');
  });
});

describe('keyring status of the workers (heartbeat runtime.keyring)', () => {
  it('lists each fresh worker with its status and active key id', async () => {
    await seedHeartbeat({
      'w:1': beat({ status: 'ok', activeKeyId: 'k1' }),
      'w:2': beat({ status: 'missing' }),
      'w:3': beat({ status: 'malformed' }),
      'w:4': beat({ status: 'active_key_missing' }),
    });
    const { body } = await keyringOf(ok);
    expect(body.keyring.workers).toEqual(
      expect.arrayContaining([
        { workerId: 'w:1', status: 'ok', activeKeyId: 'k1' },
        { workerId: 'w:2', status: 'missing' },
        { workerId: 'w:3', status: 'malformed' },
        { workerId: 'w:4', status: 'active_key_missing' },
      ]),
    );
    expect(body.keyring.workers).toHaveLength(4);
  });

  it('leaves out stale workers and workers that report no keyring', async () => {
    await seedHeartbeat({
      'fresh:1': beat({ status: 'ok', activeKeyId: 'k1' }),
      'stale:1': beat({ status: 'ok', activeKeyId: 'k1' }, 91_000),
      'old:1': beat(undefined),
    });
    const { body } = await keyringOf(ok);
    expect(body.keyring.workers).toEqual([
      { workerId: 'fresh:1', status: 'ok', activeKeyId: 'k1' },
    ]);
  });

  it('reports a mismatch when a worker active key id differs from the API one', async () => {
    await seedHeartbeat({
      'w:1': beat({ status: 'ok', activeKeyId: 'k1' }),
      'w:2': beat({ status: 'ok', activeKeyId: 'k2' }),
    });
    const { body, raw } = await keyringOf(ok);
    expect(body.keyring.mismatch).toBe(true);
    expect(body.keyring.api).toEqual({ status: 'ok', activeKeyId: 'k1' });
    expect(raw).not.toContain(K1);
    expect(raw).not.toContain(K2);
  });

  it('reports no mismatch when every id matches (negative control)', async () => {
    await seedHeartbeat({
      'w:1': beat({ status: 'ok', activeKeyId: 'k1' }),
      'w:2': beat({ status: 'ok', activeKeyId: 'k1' }),
    });
    expect((await keyringOf(ok)).body.keyring.mismatch).toBe(false);
  });

  it('does not call a worker that is not ok, or an API that is not ok, a mismatch', async () => {
    await seedHeartbeat({ 'w:1': beat({ status: 'missing' }) });
    expect((await keyringOf(ok)).body.keyring.mismatch).toBe(false);

    await seedHeartbeat({ 'w:1': beat({ status: 'ok', activeKeyId: 'k2' }) });
    const broken = await h.buildAnother({ env: {} });
    expect((await keyringOf(broken)).body.keyring.mismatch).toBe(false);
  });

  it('ignores a malformed runtime.keyring without failing the request', async () => {
    await seedHeartbeat({
      'w:1': beat({ status: 'bogus' }),
      'w:2': beat({ status: 'ok', activeKeyId: 'k1' }),
    });
    const { body } = await keyringOf(ok);
    expect(body.keyring.workers).toEqual([{ workerId: 'w:2', status: 'ok', activeKeyId: 'k1' }]);
  });
});
