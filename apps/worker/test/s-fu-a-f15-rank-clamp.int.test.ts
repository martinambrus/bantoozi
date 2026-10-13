import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { RankWorld, type WorldSpec } from './support/s22-world.js';

/**
 * M8-F15 (PLAN §14.1, spec 06 §7 step 5): the write fence keeps a stored `next_rank_at` that is
 * later than the run's `ctxAt` (a reader action marked the row after the run captured its context)
 * by writing the earlier of it and the computed one. When that stored value is nevertheless already
 * past at the run's `now` (clock skew: `RankWorld.t` is ahead of the database clock), keeping it
 * would leave the row due, so every run would rank it again. Rule: such a value is replaced by the
 * computed one; a stored value still in the future at the run's `now` is kept (the earlier wins).
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});
afterAll(async () => {
  await h?.close();
});

const spec: WorldSpec = {
  p: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
  labelP: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
  flags: ['none', 'none', 'none', 'none', 'none', 'none'],
  markReadOnRate: true,
  rankedInitially: true,
};

async function nextRankAt(world: RankWorld, index: number): Promise<Date | null> {
  const r = await world.h.owner.query<{ n: Date | null }>(
    `SELECT next_rank_at AS n FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [world.userId, world.articles[index]],
  );
  return r.rows[0]!.n;
}

describe('M8-F15 the next_rank_at fence under clock skew', () => {
  it('does not keep a mark that is later than ctxAt but already past at the run clock', async () => {
    const world = await RankWorld.create(h, spec);
    try {
      // The run clock (world.t) is at least a minute ahead of the database clock, so a mark 30 s
      // after the database now is later than the run's ctxAt and earlier than its `now`.
      await world.h.owner.query(
        `UPDATE user_article SET next_rank_at = clock_timestamp() + interval '30 seconds'
          WHERE user_id = $1 AND article_id = $2`,
        [world.userId, world.articles[0]],
      );
      await world.rankRun({ userId: world.userId, reason: 'skew' });
      const stored = await nextRankAt(world, 0);
      expect(
        stored === null || stored.getTime() > world.t.getTime(),
        `next_rank_at ${stored?.toISOString()} must be null or after the run clock ${world.t.toISOString()}`,
      ).toBe(true);
    } finally {
      await world.close();
    }
  });

  it('keeps a mark that is still in the future at the run clock (control)', async () => {
    const world = await RankWorld.create(h, spec);
    try {
      const mark = new Date(world.t.getTime() + 60 * 60_000);
      await world.h.owner.query(
        `UPDATE user_article SET next_rank_at = $3::timestamptz - interval '0 seconds'
          WHERE user_id = $1 AND article_id = $2`,
        [world.userId, world.articles[0], mark],
      );
      // Due rows are ranked by a full run; the mark is later than ctxAt and than `now`.
      await world.rankRun({ userId: world.userId, reason: 'skew', full: true });
      const stored = await nextRankAt(world, 0);
      expect(stored).not.toBeNull();
      expect(stored!.getTime()).toBeLessThanOrEqual(mark.getTime());
    } finally {
      await world.close();
    }
  });
});
