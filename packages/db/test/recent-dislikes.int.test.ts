import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rateArticle } from '../src/index.js';
import { loadRecentDislikes } from '../src/rank/context.js';
import { Scenario } from './learn/fixtures.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

/**
 * DPF-2: `loadRecentDislikes` reports the reason and stale flag of the EFFECTIVE rating, through the
 * real rate and undo paths: -1 clickbait, re-rated -1 shallow, undone -> clickbait again.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

describe('loadRecentDislikes (DPF-2)', () => {
  it('R1 reports the reason of the effective rating after a re-rate and its undo', async () => {
    const s = await Scenario.create(ctx);
    const article = await s.article();
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);

    const first = await s.rate(article, -1, 'clickbait');
    const second = await s.run(article, (tx, base) =>
      rateArticle(tx, { ...base, rating: -1, reason: 'shallow', hide: false }),
    );
    expect(second.key).not.toBeNull();

    const before = await loadRecentDislikes(ctx.worker, s.userId, since);
    expect(before.map((d) => d.reason)).toEqual(['shallow']);

    await s.undo(second.key as string);
    const after = await loadRecentDislikes(ctx.worker, s.userId, since);
    expect(after).toHaveLength(1);
    expect(after[0]?.reason).toBe('clickbait');
    expect(after[0]?.ratedAt.getTime()).toBe(first.now.getTime());
  });

  it('R2 reports the stale flag of the effective rating, not of the undone re-rate', async () => {
    const s = await Scenario.create(ctx);
    const article = await s.article();
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000);

    const first = await s.rate(article, -1, 'clickbait');
    const second = await s.run(article, (tx, base) =>
      rateArticle(tx, { ...base, rating: -1, reason: 'shallow', hide: false }),
    );
    await s.undo(second.key as string);
    // The effective rating was stale when given; the undone re-rate was not.
    await ctx.owner.query(
      `UPDATE feedback_events
          SET value = value || jsonb_build_object('staleAtFeedback', created_at = $3::timestamptz)
        WHERE user_id = $1 AND article_id = $2 AND kind = 'rate'`,
      [s.userId, article, first.now],
    );

    const after = await loadRecentDislikes(ctx.worker, s.userId, since);
    expect(after).toHaveLength(1);
    expect(after[0]?.staleAtFeedback).toBe(true);
  });
});
