import type { MetricsRatingEvent } from '@bantoozi/db';
import { describe, expect, it } from 'vitest';

import {
  EffectiveRatingFold,
  METRIC_LANES,
  METRIC_SOURCES,
  WindowTally,
  effectiveRatings,
  laneStats,
  ratingSplits,
  type EffectiveRating,
} from '../src/metrics/compute.js';

const PAGE = 500;

function event(over: Partial<MetricsRatingEvent> & { n: number }): MetricsRatingEvent {
  const { n, ...rest } = over;
  return {
    userId: 'u1',
    articleId: 'a1',
    kind: 'rate',
    rating: n % 2 === 0 ? 1 : -1,
    lane: 'for_you',
    source: 'cards',
    lang: 'en',
    prompted: false,
    at: new Date(1_700_000_000_000 + n * 1000),
    ...rest,
  };
}

function inPages<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

describe('EffectiveRatingFold (M8-F10 review)', () => {
  it('a pair whose 1,200 events span 3 pages yields the in-memory effective rating', () => {
    // rate/undo/rate/unrate noise ending in an effective rating; undo chains cross the page edges.
    const events: MetricsRatingEvent[] = [];
    for (let n = 0; n < 1200; n += 1) {
      const kind = n % 7 === 3 ? 'undo' : n % 11 === 5 ? 'unrate' : 'rate';
      events.push(event({ n, kind, rating: kind === 'rate' ? (n % 3 === 0 ? 1 : -1) : null }));
    }
    const expected = effectiveRatings(events);
    expect(expected.length).toBeLessThanOrEqual(1);

    const got: EffectiveRating[] = [];
    const fold = new EffectiveRatingFold((r) => got.push(r));
    const pages = inPages(events, PAGE);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      fold.push(page);
      expect(got, 'the open pair is not emitted before it completes').toEqual([]);
      expect(fold.retained().openPair).toBe('u1:a1');
    }
    fold.finish();
    expect(got).toEqual(expected);
  });

  it('keeps the same ratings for many pairs cut at arbitrary page edges', () => {
    const events: MetricsRatingEvent[] = [];
    for (let p = 0; p < 40; p += 1) {
      for (let k = 0; k < 1 + (p % 6); k += 1) {
        events.push(
          event({
            n: p * 10 + k,
            userId: `u${p % 5}`,
            articleId: `a${p}`,
            lang: p % 3 ? 'cs' : 'en',
          }),
        );
      }
      if (p % 4 === 0)
        events.push(
          event({
            n: p * 10 + 9,
            userId: `u${p % 5}`,
            articleId: `a${p}`,
            kind: 'undo',
            rating: null,
          }),
        );
    }
    events.sort((a, b) =>
      a.userId === b.userId
        ? a.articleId === b.articleId
          ? a.at.getTime() - b.at.getTime()
          : a.articleId < b.articleId
            ? -1
            : 1
        : a.userId < b.userId
          ? -1
          : 1,
    );
    const expected = effectiveRatings(events);
    for (const size of [1, 2, 3, 7, 500]) {
      const got: EffectiveRating[] = [];
      const fold = new EffectiveRatingFold((r) => got.push(r));
      for (const page of inPages(events, size)) fold.push(page);
      fold.finish();
      expect(got, `page size ${size}`).toEqual(expected);
    }
  });

  it('retains only the open pair after N completed pairs, never events or emitted ratings', () => {
    let emitted = 0;
    const fold = new EffectiveRatingFold(() => {
      emitted += 1;
    });
    const N = 5000;
    for (const page of inPages(
      Array.from({ length: N }, (_, i) =>
        event({ n: i, articleId: `a${String(i).padStart(5, '0')}` }),
      ),
      PAGE,
    )) {
      fold.push(page);
      // The shape of the retained state: one pair id and a state count of that pair alone.
      expect(Object.keys(fold.retained()).sort()).toEqual(['openPair', 'states']);
      expect(fold.retained().states).toBe(1);
    }
    fold.finish();
    expect(emitted).toBe(N);
    expect(fold.retained()).toEqual({ openPair: undefined, states: 0 });
  });
});

describe('WindowTally (M8-F10 review)', () => {
  const ratings: EffectiveRating[] = Array.from({ length: 3000 }, (_, i) => ({
    at: 1_000 + i * 10,
    lane: METRIC_LANES[i % 4] ?? 'for_you',
    liked: i % 3 === 0,
    source: i % 5 === 0 ? null : (METRIC_SOURCES[i % 3] ?? null),
    lang: i % 29 === 0 ? 'unknown' : `l${String(i % 31).padStart(2, 'x')}`.slice(0, 3),
    prompted: i % 4 === 0,
  }));

  it('equals the filter-based reference over the same ratings', () => {
    const [from, to] = [5_000, 25_000];
    const inWin = ratings.filter((r) => r.at >= from && r.at < to);
    // Reference: count by hand per lane.
    const lanes = laneStats(ratings, from, to);
    for (const lane of METRIC_LANES) {
      const sel = inWin.filter((r) => r.lane === lane);
      expect(lanes[lane]).toEqual({
        likeRate: sel.length === 0 ? null : sel.filter((r) => r.liked).length / sel.length,
        rated: sel.length,
      });
    }
    const splits = ratingSplits(ratings, from, to);
    const origin = splits.byOrigin;
    expect(Object.keys(origin)).toEqual(['prompt', 'voluntary']);
    const total = (s: Record<string, { rated: number }>): number =>
      Object.values(s).reduce((n, l) => n + l.rated, 0);
    expect(total(origin['prompt'] ?? {}) + total(origin['voluntary'] ?? {})).toBe(inWin.length);
    expect(total(splits.byLanguage['other'] ?? {}) + 0).toBeGreaterThan(0);
    expect(Object.keys(splits.byLanguage).length).toBeLessThanOrEqual(22);
    expect(Object.keys(splits.bySource)).toEqual(['cards', 'degraded', 'model']);
  });

  it('keeps counters only: its size does not grow with the ratings added', () => {
    const tally = new WindowTally(0, Number.MAX_SAFE_INTEGER);
    const sizeAfter = (count: number): number => {
      for (const r of ratings.slice(0, count)) tally.add(r);
      return tally.size();
    };
    const small = sizeAfter(1500);
    const large = sizeAfter(3000);
    // Cells exist per distinct lane/source/language/origin, so repeating the same buckets adds none.
    expect(large).toBe(small);
    for (let i = 0; i < 20_000; i += 1) tally.add(ratings[i % 100] as EffectiveRating);
    expect(tally.size()).toBe(small);
  });
});
