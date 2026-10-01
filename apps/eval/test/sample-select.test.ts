import { describe, expect, it } from 'vitest';

import {
  feasibleSize,
  feedCap,
  selectLanguageSample,
  type SelectItem,
} from '../src/collection/select.js';

/** M3a-T2: the stratified per-language draw of `eval sample` (spec 10 §2.1). */

function items(feeds: Record<string, number>, days = 3): SelectItem[] {
  const out: SelectItem[] = [];
  let id = 1;
  for (const [feedId, n] of Object.entries(feeds)) {
    for (let i = 0; i < n; i += 1) {
      out.push({ articleId: String(id), feedId, day: `2026-09-${String(10 + (i % days))}` });
      id += 1;
    }
  }
  return out;
}

const count = (ids: string[], pool: SelectItem[]) => {
  const byId = new Map(pool.map((i) => [i.articleId, i]));
  const byFeed: Record<string, number> = {};
  for (const id of ids) {
    const feed = byId.get(id)?.feedId ?? '?';
    byFeed[feed] = (byFeed[feed] ?? 0) + 1;
  }
  return byFeed;
};

describe('selectLanguageSample', () => {
  it('fills the target with no feed above 10 % of the sample, spread evenly', () => {
    const feeds = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, 60]));
    const pool = items(feeds);
    const result = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 100,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(result.size).toBe(100);
    expect(result.cap).toBe(10);
    const byFeed = count(result.added, pool);
    expect(Math.max(...Object.values(byFeed))).toBeLessThanOrEqual(10);
    // 100 over 15 feeds: 6 or 7 each.
    expect(Math.min(...Object.values(byFeed))).toBeGreaterThanOrEqual(6);
    expect(new Set(result.added).size).toBe(100);
  });

  it('shrinks the sample instead of letting one prolific feed replace source diversity', () => {
    // One huge feed and nine small ones: at most 10 % per feed means the sample stays small.
    const pool = items({ big: 1000, a: 3, b: 3, c: 3, d: 3, e: 3, f: 3, g: 3, h: 3, i: 3 });
    const result = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 500,
      feedCapShare: 0.1,
      seed: 's',
    });
    // n = 30: cap 3, nine feeds × 3 + big × 3 = 30.
    expect(result.size).toBe(30);
    expect(result.cap).toBe(3);
    expect(count(result.added, pool)['big']).toBe(3);
    expect(result.available).toBe(1027);
    expect(result.feeds.find((f) => f.feedId === 'big')).toEqual({
      feedId: 'big',
      available: 1000,
      existing: 0,
      selected: 3,
    });
  });

  it('spreads a feed over collection days', () => {
    const pool = items(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 30])), 3);
    const result = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 60,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(result.size).toBe(60);
    expect(result.days).toEqual({ '2026-09-10': 20, '2026-09-11': 20, '2026-09-12': 20 });
  });

  it('is deterministic for a seed and differs for another seed', () => {
    const pool = items(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, 40])));
    const draw = (seed: string) =>
      selectLanguageSample({ fresh: pool, existing: [], target: 100, feedCapShare: 0.1, seed })
        .added;
    expect(draw('one')).toEqual(draw('one'));
    expect([...draw('one')].sort()).not.toEqual([...draw('two')].sort());
  });

  it('keeps existing rows and only adds; nothing to add when the target is met', () => {
    const pool = items(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 20])));
    const first = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 50,
      feedCapShare: 0.1,
      seed: 's',
    });
    const taken = new Set(first.added);
    const existing = pool.filter((i) => taken.has(i.articleId));
    const fresh = pool.filter((i) => !taken.has(i.articleId));
    const again = selectLanguageSample({
      fresh,
      existing,
      target: 50,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(again.added).toEqual([]);
    expect(again.size).toBe(50);
    const more = selectLanguageSample({
      fresh,
      existing,
      target: 80,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(more.size).toBe(80);
    expect(more.added.every((id) => !taken.has(id))).toBe(true);
  });

  it('caps every feed that carries a selected article, not only the first carrier', () => {
    // 20 feeds × 20 articles; the first 8 of each are also carried by one prolific hub feed.
    const pool: SelectItem[] = [];
    for (let f = 0; f < 20; f += 1) {
      for (let i = 0; i < 20; i += 1) {
        const feedId = `f${String(f).padStart(2, '0')}`;
        pool.push({
          articleId: `${feedId}-${i}`,
          feedId,
          carriers: i < 8 ? [feedId, 'hub'] : [feedId],
          day: `2026-09-${String(10 + (i % 3))}`,
        });
      }
    }
    const result = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 100,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(result.size).toBe(100);
    const hubCarried = result.added.filter((id) => Number(id.split('-')[1]) < 8).length;
    expect(hubCarried).toBeLessThanOrEqual(result.cap);
    expect(result.feeds.find((f) => f.feedId === 'hub')).toMatchObject({
      available: 160,
      selected: hubCarried,
    });
    for (const feed of result.feeds) expect(feed.selected).toBeLessThanOrEqual(result.cap);
  });

  it('shrinks the sample when a feed carrying every article would exceed the cap', () => {
    const pool = items(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 10]))).map(
      (item, index) => ({
        ...item,
        carriers: index % 2 === 0 ? [item.feedId, 'hub'] : [item.feedId],
      }),
    );
    const result = selectLanguageSample({
      fresh: pool,
      existing: [],
      target: 200,
      feedCapShare: 0.1,
      seed: 's',
    });
    const hub = result.feeds.find((f) => f.feedId === 'hub');
    expect(hub?.selected ?? 0).toBeLessThanOrEqual(result.cap);
    expect(result.size).toBeGreaterThan(0);
    expect(result.cap).toBe(Math.floor(result.size / 10));
  });

  it('keeps a feasible sample when a shared article competes with exclusive ones', () => {
    // Ten feeds with one exclusive article each (cap 1 at size 10); feed f0 also carries an article
    // f1 carries too. Taking it would leave f1 with no room and collapse the sample.
    const pool: SelectItem[] = Array.from({ length: 10 }, (_, f) => ({
      articleId: `e${f}`,
      feedId: `f${f}`,
      day: '2026-09-10',
    }));
    pool.push({ articleId: 'shared', feedId: 'f0', carriers: ['f0', 'f1'], day: '2026-09-10' });
    for (let i = 0; i < 20; i += 1) {
      const result = selectLanguageSample({
        fresh: pool,
        existing: [],
        target: 10,
        feedCapShare: 0.1,
        seed: `s${i}`,
      });
      expect(result.size).toBe(10);
      expect(result.added).not.toContain('shared');
    }
  });

  it('repairs a draw blocked by equally shared articles with an augmenting swap', () => {
    // Cap 1 at size 10: stratum A offers {A,X} and {A,Y}, stratum B only {B,X}, plus eight
    // exclusive strata. {A,Y} with {B,X} fills all ten whichever of A's articles comes first.
    const pool: SelectItem[] = [
      { articleId: 'ax', feedId: 'A', carriers: ['A', 'X'], day: '2026-09-10' },
      { articleId: 'ay', feedId: 'A', carriers: ['A', 'Y'], day: '2026-09-10' },
      { articleId: 'bx', feedId: 'B', carriers: ['B', 'X'], day: '2026-09-10' },
      ...Array.from({ length: 8 }, (_, f) => ({
        articleId: `e${f}`,
        feedId: `f${f}`,
        day: '2026-09-10',
      })),
    ];
    for (let i = 0; i < 20; i += 1) {
      const result = selectLanguageSample({
        fresh: pool,
        existing: [],
        target: 10,
        feedCapShare: 0.1,
        seed: `s${i}`,
      });
      expect(result.size).toBe(10);
      expect(result.added).toContain('bx');
      expect(result.added).toContain('ay');
      for (const feed of result.feeds) expect(feed.selected).toBeLessThanOrEqual(1);
    }
  });

  it('repairs a draw with an augmenting path of several swaps', () => {
    // Cap 1 at size 10: {A,X}/{A,Y}, {B,Y}/{B,Z}, {D,X} and seven exclusive strata. Only
    // {A,Y}, {B,Z} and {D,X} together fill all ten.
    const pool: SelectItem[] = [
      { articleId: 'ax', feedId: 'A', carriers: ['A', 'X'], day: '2026-09-10' },
      { articleId: 'ay', feedId: 'A', carriers: ['A', 'Y'], day: '2026-09-10' },
      { articleId: 'by', feedId: 'B', carriers: ['B', 'Y'], day: '2026-09-10' },
      { articleId: 'bz', feedId: 'B', carriers: ['B', 'Z'], day: '2026-09-10' },
      { articleId: 'dx', feedId: 'D', carriers: ['D', 'X'], day: '2026-09-10' },
      ...Array.from({ length: 7 }, (_, f) => ({
        articleId: `e${f}`,
        feedId: `f${f}`,
        day: '2026-09-10',
      })),
    ];
    for (let i = 0; i < 30; i += 1) {
      const result = selectLanguageSample({
        fresh: pool,
        existing: [],
        target: 10,
        feedCapShare: 0.1,
        seed: `s${i}`,
      });
      expect(result.size).toBe(10);
      expect([...result.added].sort()).toEqual(
        ['ay', 'bz', 'dx', 'e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'].sort(),
      );
    }
  });

  it('draws nothing when no language article is eligible', () => {
    const result = selectLanguageSample({
      fresh: [],
      existing: [],
      target: 500,
      feedCapShare: 0.1,
      seed: 's',
    });
    expect(result).toMatchObject({ added: [], size: 0, available: 0, feeds: [] });
  });
});

describe('feasibleSize and feedCap', () => {
  it('finds the largest size the feeds can fill under the cap of that size', () => {
    expect(feedCap(500, 0.1)).toBe(50);
    expect(feedCap(59, 0.1)).toBe(5);
    expect(feasibleSize([{ available: 100, existing: 0 }], 500, 0.1)).toBe(0);
    expect(
      feasibleSize(
        Array.from({ length: 20 }, () => ({ available: 100, existing: 0 })),
        500,
        0.1,
      ),
    ).toBe(500);
    expect(feasibleSize([{ available: 5, existing: 5 }], 500, 0.1)).toBe(5);
  });
});
