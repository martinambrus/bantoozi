import type { RankerThresholds } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { applyG1Settings } from '../src/eval/g1.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;
let active: string;
const now = new Date();
beforeAll(async () => {
  ctx = await setupDbTest();
  active = (await createUser(ctx.owner, { lastActiveAt: now })).id;
  await createUser(ctx.owner, { lastActiveAt: new Date(now.getTime() - 30 * 86_400_000) });
  await createUser(ctx.owner, { lastActiveAt: now, deletedAt: now });
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  await ctx.owner.query('DELETE FROM job_outbox');
  await ctx.owner.query(
    `DELETE FROM settings WHERE key IN ('ranker.thresholds', 'ranker.settings_version')`,
  );
});

const apply = (rankerThresholds: RankerThresholds) =>
  ctx.worker.transaction((tx) =>
    applyG1Settings(
      tx,
      {
        languageModes: {},
        cardTextMode: 'as_written',
        rankerThresholds,
        dailyBudgetUsd: 10,
        tier2DailyCap: 300,
      },
      { env: { dailyBudgetUsd: 10, languageModes: {}, signupMode: 'invite' }, now },
    ),
  );
async function estimates() {
  const res = await ctx.owner.query<{ user_id: string }>(
    `SELECT payload->>'userId' AS user_id FROM job_outbox WHERE queue = 'user.estimate' ORDER BY payload->>'userId'`,
  );
  return res.rows.map((r) => r.user_id);
}

it.each([
  { estimate: { minRatings: 12 } },
  { estimate: { minEachClass: 4 } },
  { model: { historyDays: 90 } },
])('G1 estimates active users when training inputs change: %j', async (thresholds) => {
  const result = await apply(thresholds);
  expect(await estimates()).toEqual([active]);
  expect(result.intents['user.estimate']).toBe(1);
  await ctx.owner.query('DELETE FROM job_outbox');
  await apply(thresholds);
  expect(await estimates()).toEqual([]);
});

it.each([
  { model: { minExplicit: 60 } },
  { estimate: { minRatings: 10, minEachClass: 3 } },
  { model: { historyDays: 180 } },
])('G1 skips estimates for unrelated or unchanged effective inputs: %j', async (thresholds) => {
  const result = await apply(thresholds);
  expect(await estimates()).toEqual([]);
  expect(result.intents['user.estimate']).toBeUndefined();
});

it('G1 can repair a stored partial that fails merged validation', async () => {
  await ctx.owner.query(
    `INSERT INTO settings (key, value) VALUES ('ranker.thresholds', '{"lanes":{"maybe":0.9,"forYou":0.1}}')`,
  );
  await apply({});
  expect(await estimates()).toEqual([active]);
});
