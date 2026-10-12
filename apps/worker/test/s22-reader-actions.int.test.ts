import { markArticlesRead, tenantOutbox, usersDueForRank, withTenant } from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY } from './support/classify.js';
import { RankWorld, type Step, type WorldSpec } from './support/s22-world.js';

/**
 * S22 action level (owner decision 2026-10-11): a reader action records NO full `user.rank` intent
 * and does NOT bump `users.rank_revision`, except when it flips an auto demotion flag; a bulk
 * mark-read of more than 2,000 targets records one full rank.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

const spec = (markReadOnRate = true): WorldSpec => ({
  p: [0.9, 0.9, 0.9, 0.9, 0.6, 0.4],
  labelP: [0.9, 0.3, 0.3, 0.3, 0.3, 0.3],
  flags: ['none', 'none', 'none', 'none', 'none', 'none'],
  markReadOnRate,
  rankedInitially: true,
});

interface Case {
  name: string;
  /** Steps applied (and drained) before the action under test. */
  setup?: Step[];
  step: Step;
  markReadOnRate?: boolean;
}

const rate = (
  a: number,
  rating: 1 | -1 | null,
  hide = false,
  reason: 'clickbait' | null = null,
): Step => ({ k: 'rate', a, rating, reason, hide });

const cases: Case[] = [
  { name: 'read', step: { k: 'read', a: 0 } },
  { name: 'open', step: { k: 'open', a: 0 } },
  { name: 'unread', setup: [{ k: 'read', a: 0 }], step: { k: 'unread', a: 0 } },
  { name: 'rate +1', step: rate(0, 1) },
  { name: 'rate +1 without markReadOnRate', step: rate(0, 1), markReadOnRate: false },
  { name: 'rate -1', step: rate(0, -1) },
  { name: 'rate -1 with hide', step: rate(0, -1, true) },
  { name: 'rate -1 with a reason', step: rate(0, -1, false, 'clickbait') },
  { name: 'rate null (un-rate)', setup: [rate(0, 1)], step: rate(0, null) },
  {
    name: 'rate null without markReadOnRate',
    setup: [rate(0, 1)],
    step: rate(0, null),
    markReadOnRate: false,
  },
  { name: 'prompt', step: { k: 'prompt', a: 0, liked: false } },
  { name: 'rate-bulk', step: { k: 'rateBulk', as: [0, 1, 2], rating: -1 } },
  {
    name: 'rate-bulk null',
    setup: [{ k: 'rateBulk', as: [0, 1], rating: 1 }],
    step: { k: 'rateBulk', as: [0, 1], rating: null },
  },
  { name: 'mark-read', step: { k: 'markRead', as: [0, 2] } },
  { name: 'unhide', setup: [rate(0, -1, true)], step: { k: 'unhide', a: 0 } },
  { name: 'label', step: { k: 'label', a: 0 } },
  { name: 'unlabel', setup: [{ k: 'label', a: 0 }], step: { k: 'unlabel', a: 0 } },
  { name: 'bookmark', step: { k: 'bookmark', a: 0 } },
  { name: 'undo of a rating', setup: [rate(0, -1)], step: { k: 'undo' } },
  { name: 'undo of a read', setup: [{ k: 'read', a: 0 }], step: { k: 'undo' } },
  { name: 'undo of a hiding rating', setup: [rate(0, -1, true)], step: { k: 'undo' } },
];

describe('S22 reader actions never record a full rank or bump the revision', () => {
  it.each(cases)('$name', async ({ setup = [], step, markReadOnRate }) => {
    const world = await RankWorld.create(h, spec(markReadOnRate ?? true));
    try {
      for (const prior of setup) await world.perform(prior);
      await world.drain();
      const before = await world.counters();
      expect(await world.perform(step), 'the action changed something').toBe(true);
      const after = await world.counters();
      expect(after.fullIntents - before.fullIntents, 'full user.rank intents').toBe(0);
      expect(after.rankRevision, 'users.rank_revision').toBe(before.rankRevision);
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
    }
  });
});

describe('S22 demotion activation flip (the one action that still ranks everything)', () => {
  it('the second dislike crossing autoMinDislikes records one full rank and bumps once', async () => {
    await h.setSetting('ranker.thresholds', { demotion: { autoMinDislikes: 2 } });
    const world = await RankWorld.create(h, spec());
    try {
      const first = await world.counters();
      await world.perform(rate(0, -1, false, 'clickbait'));
      const mid = await world.counters();
      expect(mid.fullIntents - first.fullIntents, 'first dislike: full intents').toBe(0);
      expect(mid.rankRevision).toBe(first.rankRevision);
      expect(mid.flags).toBe('');
      await world.drain();

      await world.perform(rate(1, -1, false, 'clickbait'));
      const last = await world.counters();
      expect(last.flags).toBe('clickbait');
      expect(last.fullIntents - mid.fullIntents, 'second dislike: full intents').toBe(1);
      expect(Number(last.rankRevision) - Number(mid.rankRevision)).toBe(1);
      await world.drain();
      expect(await world.compareToOracle()).toBeNull();
    } finally {
      await world.close();
      await h.deleteSetting('ranker.thresholds');
    }
  });
});

describe('S22 bulk mark-read', () => {
  async function bulkWorld(count: number) {
    const world = await RankWorld.create(h, spec());
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await h.article({
          feedIds: [world.feeds[0]],
          title: `S22 bulk ${i}`,
          firstSeenAt: new Date(Date.now() - DAY),
        }),
      );
    }
    // Story clusters of two, so a read always has a sibling to re-rank.
    for (let i = 0; i + 1 < ids.length; i += 2) {
      const created = await h.owner.query<{ id: string }>(
        `INSERT INTO story_clusters (representative_article_id, size) VALUES ($1, 2) RETURNING id::text AS id`,
        [ids[i]],
      );
      await h.owner.query(
        `UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`,
        [created.rows[0]!.id, [ids[i], ids[i + 1]]],
      );
    }
    return { world, ids };
  }

  async function markAll(world: RankWorld, ids: string[]) {
    await world.drain();
    const before = await world.counters();
    const result = await withTenant(world.appDb, world.userId, (tx) =>
      markArticlesRead(tx, {
        targets: ids.map((articleId) => ({ articleId, fence: null })),
        now: new Date(world.t.getTime() + 60_000),
        outbox: tenantOutbox(tx),
      }),
    );
    expect(result.count).toBe(ids.length);
    return { before, after: await world.counters() };
  }

  it('2,001 targets: one full rank', async () => {
    const { world, ids } = await bulkWorld(2001);
    try {
      const { before, after } = await markAll(world, ids);
      expect(after.fullIntents - before.fullIntents).toBe(1);
    } finally {
      await world.close();
    }
  }, 300_000);

  it('2,000 targets: still targeted, no full rank and no bump', async () => {
    const { world, ids } = await bulkWorld(2000);
    try {
      const { before, after } = await markAll(world, ids);
      expect(after.fullIntents - before.fullIntents).toBe(0);
      expect(after.rankRevision).toBe(before.rankRevision);
      expect(after.rankIntents - before.rankIntents, 'one incremental intent').toBe(1);
    } finally {
      await world.close();
    }
  }, 300_000);
});

describe('R4 marks and placeholders stay inside the rank window', () => {
  it('an old non-archived sibling from an unsubscribed feed is not marked and the user is not due', async () => {
    const world = await RankWorld.create(h, spec());
    try {
      const outside = await h.feed();
      const old = await h.article({
        feedIds: [outside],
        title: 'R4 old sibling',
        firstSeenAt: new Date(Date.now() - 100 * DAY),
      });
      const oldNoRow = await h.article({
        feedIds: [outside],
        title: 'R4 old sibling without a row',
        firstSeenAt: new Date(Date.now() - 100 * DAY),
      });
      await h.owner.query(
        `UPDATE articles SET story_cluster_id = $1 WHERE id = ANY($2::bigint[])`,
        [world.clusters[0], [old, oldNoRow]],
      );
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, scored_at) VALUES ($1, $2, now())`,
        [world.userId, old],
      );
      await world.drain();
      expect(await world.perform({ k: 'read', a: 0 }), 'the action changed something').toBe(true);
      await world.drain();
      const rows = await h.owner.query<{ article_id: string; next_rank_at: Date | null }>(
        `SELECT article_id::text AS article_id, next_rank_at FROM user_article
          WHERE user_id = $1 AND article_id = ANY($2::bigint[])`,
        [world.userId, [old, oldNoRow]],
      );
      expect(rows.rows, 'no placeholder for the old row without one').toHaveLength(1);
      expect(rows.rows[0]!.next_rank_at, 'the old row is not marked').toBeNull();
      const due = await h.ownerDb.transaction((tx) =>
        usersDueForRank(tx, { now: new Date(Date.now() + 60_000), after: null, limit: 1000 }),
      );
      expect(due).not.toContain(world.userId);
    } finally {
      await world.close();
    }
  });
});
