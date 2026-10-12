import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY, MINUTE } from './support/classify.js';
import { RankWorld, type WorldSpec } from './support/s22-world.js';

/**
 * S22 race tests (the `beforeWrite` seam of `user.rank`, run on the first batch only) and the
 * seen-story expiry. Every race ends with: drain whatever intents the committed action enqueued,
 * then the stored ranking must equal a full-rank oracle (nothing may be lost to the run's stale
 * batch overwriting a newer mark).
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

/** Every article a strong match, so a read story visibly demotes its siblings (seen_story). */
const spec = (rankedInitially: boolean): WorldSpec => ({
  p: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
  labelP: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
  flags: ['none', 'none', 'none', 'none', 'none', 'none'],
  markReadOnRate: true,
  rankedInitially,
});

/** Make these rows due now, as an elapsed deadline would. */
async function makeDue(world: RankWorld, ...indexes: number[]): Promise<void> {
  await world.h.owner.query(
    `UPDATE user_article SET next_rank_at = now() - interval '1 second'
      WHERE user_id = $1 AND article_id = ANY($2::bigint[])`,
    [world.userId, indexes.map((i) => world.articles[i])],
  );
}

/** Run one incremental rank whose first batch is interrupted by `during`. */
async function raceRun(world: RankWorld, during: () => Promise<unknown>): Promise<void> {
  let fired = false;
  await world.rankRun(
    { userId: world.userId, reason: 'race' },
    {
      beforeWrite: async () => {
        if (fired) return;
        fired = true;
        await during();
      },
    },
  );
  expect(fired, 'the run reached a write').toBe(true);
}

describe('S22 race: an action commits while a run is between ranking and writing', () => {
  it('a read on a clustered sibling committed mid-run', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      await makeDue(world, 0, 1);
      await raceRun(world, () => world.perform({ k: 'read', a: 0 }));
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });

  it('a read whose cluster sibling has no user_article row yet', async () => {
    const world = await RankWorld.create(h, spec(false));
    try {
      await makeDue(world, 0);
      await raceRun(world, () => world.perform({ k: 'read', a: 0 }));
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });

  it('an unhide committed mid-run, after a sibling was read while the article was hidden', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      await world.perform({ k: 'rate', a: 2, rating: -1, reason: null, hide: true });
      await world.drain();
      await world.perform({ k: 'read', a: 3 });
      await world.drain();
      await makeDue(world, 0);
      await raceRun(world, () => world.perform({ k: 'unhide', a: 2 }));
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });
});

describe('S22 race: the run DOES write the sibling a read just marked (write fence)', () => {
  /** The sibling's stored deadline right after the run, before any drain. */
  async function siblingDeadline(world: RankWorld): Promise<number | null> {
    return (await world.snapshot()).get(world.articles[1]!)?.nextRankAt ?? null;
  }

  it('an incremental run with the sibling already dirty keeps the mark of a read committed before its write', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      await makeDue(world, 0, 1);
      await raceRun(world, () => world.perform({ k: 'read', a: 0 }));
      const commitTime = world.t.getTime();
      // The run wrote the sibling from a context that predates the read: it must still be due.
      const deadline = await siblingDeadline(world);
      expect(deadline, 'the sibling is still due after the run wrote it').not.toBeNull();
      expect(deadline).toBeLessThanOrEqual(commitTime);
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });

  it('an incremental run with the sibling outdated (old score version) keeps the mark', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      await h.owner.query(
        `UPDATE user_article SET score_version = 'outdated'
          WHERE user_id = $1 AND article_id = ANY($2::bigint[])`,
        [world.userId, [world.articles[0], world.articles[1]]],
      );
      await raceRun(world, () => world.perform({ k: 'read', a: 0 }));
      const commitTime = world.t.getTime();
      const deadline = await siblingDeadline(world);
      expect(deadline).not.toBeNull();
      expect(deadline).toBeLessThanOrEqual(commitTime);
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });

  it('a full run in flight keeps the mark of a read committed before its write', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      let fired = false;
      await world.rankRun(
        {
          userId: world.userId,
          reason: 'race-full',
          full: true,
          snapshotAt: new Date(world.t.getTime() + 1000).toISOString(),
        },
        {
          beforeWrite: async () => {
            if (fired) return;
            fired = true;
            await world.perform({ k: 'read', a: 0 });
          },
        },
      );
      expect(fired, 'the run reached a write').toBe(true);
      const commitTime = world.t.getTime();
      const deadline = await siblingDeadline(world);
      expect(deadline, 'the sibling is still due after the full run wrote it').not.toBeNull();
      expect(deadline).toBeLessThanOrEqual(commitTime);
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });
});

describe('S22 seen_story expiry (a read stops hiding its story after 14 days)', () => {
  it('a sibling that arrived after the read is re-ranked by an incremental run at read + 14 d', async () => {
    const world = await RankWorld.create(h, spec(true));
    try {
      expect(await world.perform({ k: 'read', a: 0 })).toBe(true);
      await world.drain();
      const read = await h.owner.query<{ read_at: Date }>(
        `SELECT read_at FROM user_article WHERE user_id = $1 AND article_id = $2`,
        [world.userId, world.articles[0]],
      );
      const readAt = read.rows[0]!.read_at.getTime();

      // A new member of the read story arrives a day later and is ranked as seen.
      world.t = new Date(world.t.getTime() + DAY);
      expect(await world.perform({ k: 'arrive', cluster: 0, p: 0.9, flag: 'none' })).toBe(true);
      const arrived = world.articles[world.articles.length - 1]!;
      const seen = (await world.snapshot()).get(arrived);
      expect(seen?.rules).toContain('seen_story');
      expect(seen?.lane).toBe('everything');
      // The seen state ends 14 days after the read: that is when the row is due.
      expect(seen?.nextRankAt).toBe(readAt + 14 * DAY);

      // Just past the deadline an incremental run (no full intent) re-ranks the row.
      const before = seen!.scoredAt;
      const outbox = await world.counters();
      await world.perform({ k: 'jump', ms: readAt + 14 * DAY + MINUTE - world.t.getTime() });
      const after = (await world.snapshot()).get(arrived);
      expect(after?.rules).not.toContain('seen_story');
      expect(after?.scoredAt).toBeGreaterThan(before ?? 0);
      expect((await world.counters()).fullIntents).toBe(outbox.fullIntents);
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });
});
