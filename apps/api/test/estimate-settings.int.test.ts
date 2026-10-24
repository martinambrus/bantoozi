import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

let h: ApiHarness;
let admin: TestUser;
let reader: TestUser;
let inactive: TestUser;
let deleted: TestUser;

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  reader = await createTestUser(h);
  await h.owner.query('UPDATE users SET last_active_at = now() WHERE id = ANY($1::uuid[])', [
    [admin.id, reader.id],
  ]);
  inactive = await createTestUser(h);
  deleted = await createTestUser(h);
  await h.owner.query(
    `UPDATE users SET last_active_at = now() - interval '30 days' WHERE id = $1`,
    [inactive.id],
  );
  await h.owner.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted.id]);
});

afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.owner.query('DELETE FROM job_outbox');
  await h.owner.query(
    `DELETE FROM settings WHERE key IN ('ranker.thresholds', 'ranker.settings_version')`,
  );
});

async function patch(thresholds: unknown) {
  const res = await apiClient(h.server, admin).patch('/admin/settings', {
    'ranker.thresholds': thresholds,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function estimates() {
  const res = await h.owner.query<{ user_id: string }>(
    `SELECT payload->>'userId' AS user_id FROM job_outbox WHERE queue = 'user.estimate' AND delivered_at IS NULL ORDER BY payload->>'userId'`,
  );
  return res.rows.map((r) => r.user_id);
}

it.each([
  { estimate: { minRatings: 12 } },
  { estimate: { minEachClass: 4 } },
  { model: { historyDays: 90 } },
])('immediately estimates the same active users for %j', async (thresholds) => {
  await patch(thresholds);
  expect(await estimates()).toEqual([admin.id, reader.id].sort());
  const ranks = await h.owner.query<{ user_id: string }>(
    `SELECT payload->>'userId' AS user_id FROM job_outbox WHERE queue = 'user.rank' ORDER BY payload->>'userId'`,
  );
  expect(ranks.rows.map((r) => r.user_id)).toEqual(await estimates());
  await patch(thresholds);
  expect(await estimates()).toHaveLength(2);
});

it.each([{ model: { minExplicit: 60 } }, { estimate: { minRatings: 10, minEachClass: 3 } }])(
  'does not enqueue estimates for unrelated or unchanged inputs %j',
  async (thresholds) => {
    await patch(thresholds);
    expect(await estimates()).toEqual([]);
  },
);
