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
