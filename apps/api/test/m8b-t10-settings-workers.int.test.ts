import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M8b-T10 (spec 08 §9): `GET /admin/settings` reports what the live workers applied, from the
 * `runtime` field of the fresh (≤ 90 s) worker heartbeats: pending restart and per-key problems.
 */

let h: ApiHarness;
let admin: TestUser;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.owner.query("DELETE FROM settings WHERE key = 'worker.heartbeat'");
});

const entry = (runtime: Record<string, unknown> | undefined, ageMs = 0) => ({
  at: new Date(Date.now() - ageMs).toISOString(),
  queues: ['article.enrich'],
  evalIngestOnly: false,
  envCredentials: [],
  ...(runtime === undefined ? {} : { runtime }),
});

async function heartbeats(value: Record<string, unknown>): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('worker.heartbeat', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

async function workers(): Promise<unknown> {
  const res = await apiClient(h.server, admin).get('/admin/settings');
  expect(res.statusCode, res.body).toBe(200);
  return res.json().workers;
}

describe('GET /admin/settings workers (M8b-T10)', () => {
  it('is empty without a heartbeat', async () => {
    expect(await workers()).toEqual([]);
  });

  it('lists each fresh worker with its pending restart and problems, sorted by process id', async () => {
    await heartbeats({
      'worker:b': entry({
        pendingRestart: true,
        problems: [{ key: 'engine.typesafe_model', message: 'not a pinned model' }],
      }),
      'worker:a': entry({ pendingRestart: false, problems: [] }),
    });
    const list = (await workers()) as Array<Record<string, unknown>>;
    expect(list.map((w) => w.processId)).toEqual(['worker:a', 'worker:b']);
    expect(list[0]).toMatchObject({ pendingRestart: false, problems: [] });
    expect(list[1]).toMatchObject({
      pendingRestart: true,
      problems: [{ key: 'engine.typesafe_model', message: 'not a pinned model' }],
    });
  });

  it('leaves out a stale worker and reads a worker without runtime as applied (negative controls)', async () => {
    await heartbeats({
      'worker:old': entry({ pendingRestart: true, problems: [] }, 5 * 60_000),
      'worker:plain': entry(undefined),
    });
    expect(await workers()).toEqual([
      expect.objectContaining({ processId: 'worker:plain', pendingRestart: false, problems: [] }),
    ]);
  });
});
