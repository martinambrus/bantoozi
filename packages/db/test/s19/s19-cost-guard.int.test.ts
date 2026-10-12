import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listArticlePage, type ArticleListInput } from '../../src/api/articles.js';
import { buildCostWorld, COST_SCORE_VERSION, type CostWorld } from '../support/s19-cost-world.js';
import { explainBuffers, captureStatements } from '../support/s19-explain.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * S19 cost guard: the list query must stay cheap on a realistic reader (64 subscriptions, 2,400
 * window articles, active carriage). The bound is on shared buffers (hit + read) per call, planning
 * included, measured with EXPLAIN (ANALYZE, BUFFERS) of the exact statement `listArticlePage` issues.
 * Baseline: 27k-82k+ buffers (S18); the rewritten projection is expected near a fifth of the bound.
 */

export const BUFFER_BOUND = 5_000;

let ctx: DbTestContext;
let world: CostWorld;

beforeAll(async () => {
  ctx = await setupDbTest();
  world = await buildCostWorld(ctx.owner);
});

afterAll(async () => {
  await ctx.close();
});

function input(lane: ArticleListInput['lane'], sort: ArticleListInput['sort']): ArticleListInput {
  return {
    scope: {},
    lane,
    status: 'unread',
    minTier: 0,
    asOf: world.asOf,
    scoreVersion: COST_SCORE_VERSION,
    sort,
    limit: 50,
    after: null,
  };
}

describe('listArticlePage cost on a 64-feed, 2,400-article reader', () => {
  it('has the shape the bound is meant for', async () => {
    const count = await ctx.owner.query<{ feeds: number; window: number }>(
      `SELECT (SELECT count(*) FROM subscriptions WHERE user_id = $1)::int AS feeds,
              (SELECT count(DISTINCT fi.article_id) FROM feed_items fi
                 JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = $1
                WHERE fi.first_seen_at >= $2::timestamptz - interval '14 days')::int AS window`,
      [world.userId, world.asOf.toISOString()],
    );
    expect(count.rows[0]?.feeds).toBeGreaterThanOrEqual(50);
    expect(count.rows[0]?.window).toBeGreaterThanOrEqual(2_000);
    const active = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1 AND inference_mode = 'active'`,
      [world.userId],
    );
    expect(active.rows[0]?.n).toBeGreaterThan(0);
  });

  it.each([
    ['for_you', 'score'],
    ['maybe', 'uncertainty'],
    ['all', 'date'],
  ] as const)('the %s lane stays under the buffer bound', async (lane, sort) => {
    const statements = await captureStatements(ctx.app, world.userId, (tx) =>
      listArticlePage(tx, input(lane, sort)),
    );
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    // Warm once, then measure: buffers are hit + read, so cache state does not change the total.
    await explainBuffers(ctx.appPool, world.userId, statement.text, statement.params);
    const report = await explainBuffers(
      ctx.appPool,
      world.userId,
      statement.text,
      statement.params,
    );
    console.info(`S19 buffers ${lane}: ${JSON.stringify(report)}`);
    expect(report.total).toBeLessThan(BUFFER_BOUND);
  });
});
