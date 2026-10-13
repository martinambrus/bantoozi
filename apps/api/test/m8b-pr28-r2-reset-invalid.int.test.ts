import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PR #28 review round 2: a PATCH of `null` clears a stored runtime row even when that row no longer
 * validates (so it is not "overridden"): a stored row exists independently of it being valid.
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
  await h.owner.query(
    "DELETE FROM settings WHERE key IN ('worker.heartbeat', 'engine.concurrency', 'ingest.max_age_days')",
  );
});

const rowValue = async (key: string): Promise<{ exists: boolean; value: unknown }> => {
  const rows = (
    await h.owner.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key])
  ).rows;
  return { exists: rows.length > 0, value: rows[0]?.value };
};
const setRow = (key: string, value: unknown) =>
  h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
const patch = (body: unknown) => apiClient(h.server, admin).patch('/admin/settings', body);

describe('PATCH null over a stored row that no longer validates', () => {
  it('clears it, reports it in changed and reads the environment value again', async () => {
    await setRow('engine.concurrency', 'not a number');
    const res = await patch({ 'engine.concurrency': null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toContain('engine.concurrency');
    const after = await rowValue('engine.concurrency');
    expect(after.value ?? null).toBeNull();
    expect(res.json().sources['engine.concurrency']).toBe('env');
    expect(res.json().stored.map((s: { key: string }) => s.key)).not.toContain(
      'engine.concurrency',
    );
  });

  it('control: null over an absent row changes nothing', async () => {
    const res = await patch({ 'engine.concurrency': null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toEqual([]);
    expect((await rowValue('engine.concurrency')).exists).toBe(false);
  });

  it('control: null over a valid stored row still resets it', async () => {
    await setRow('ingest.max_age_days', 30);
    const res = await patch({ 'ingest.max_age_days': null });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toContain('ingest.max_age_days');
    expect((await rowValue('ingest.max_age_days')).value ?? null).toBeNull();
  });
});
