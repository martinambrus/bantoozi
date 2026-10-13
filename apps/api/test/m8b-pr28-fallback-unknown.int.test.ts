import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PR #28 review: `engine.llm_fallback_enabled` has no API env default, so without a fresh worker
 * heartbeat its effective value is unknown (`null`). An explicit `false` must still be stored, or a
 * worker whose env says `true` would come back with the fallback on after a successful PATCH.
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
    "DELETE FROM settings WHERE key IN ('worker.heartbeat', 'engine.llm_fallback_enabled')",
  );
});

const stored = async (): Promise<unknown> =>
  (
    await h.owner.query<{ value: unknown }>(
      "SELECT value FROM settings WHERE key = 'engine.llm_fallback_enabled'",
    )
  ).rows[0]?.value;

describe('engine.llm_fallback_enabled while the worker default is unknown', () => {
  it('stores an explicit false without asking for an acknowledgement', async () => {
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.llm_fallback_enabled': false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toContain('engine.llm_fallback_enabled');
    expect(await stored()).toBe(false);
  });

  it('still asks for an acknowledgement to turn it on (control)', async () => {
    const res = await apiClient(h.server, admin).patch('/admin/settings', {
      'engine.llm_fallback_enabled': true,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(await stored()).toBeUndefined();
  });
});
