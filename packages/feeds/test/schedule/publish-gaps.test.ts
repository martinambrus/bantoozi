import { describe, expect, it } from 'vitest';

import { recentGapsS } from '../../src/schedule/index.js';
import { median } from '../../src/schedule/publish-gaps.js';
import { HOUR_MS } from './schedule-fixtures.js';

const T = new Date('2026-03-10T09:00:00.000Z');

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

describe('recentGapsS (spec 03 §7, §9)', () => {
  it('returns the gaps between consecutive instants, newest first, in seconds', () => {
    expect(recentGapsS([T, at(60_000), at(3 * HOUR_MS + 60_000)])).toEqual([10_800, 60]);
  });

  it('accepts any input order', () => {
    expect(recentGapsS([at(3 * HOUR_MS + 60_000), T, at(60_000)])).toEqual([10_800, 60]);
  });

  it('needs two distinct valid instants', () => {
    expect(recentGapsS([])).toEqual([]);
    expect(recentGapsS([T])).toEqual([]);
    expect(recentGapsS([T, new Date(T)])).toEqual([]);
    expect(recentGapsS([null, null])).toEqual([]);
  });

  it('skips null and invalid dates', () => {
    expect(recentGapsS([null, T, new Date(Number.NaN), at(HOUR_MS), null])).toEqual([3600]);
  });

  it('counts each instant once, so no gap is zero', () => {
    expect(recentGapsS([T, T, at(HOUR_MS), at(HOUR_MS), at(3 * HOUR_MS), T])).toEqual([7200, 3600]);
  });

  it('compares whole seconds', () => {
    expect(recentGapsS([at(100), at(900)])).toEqual([]);
    expect(recentGapsS([at(900), at(1100)])).toEqual([1]);
    expect(recentGapsS([at(1100), at(HOUR_MS + 400)])).toEqual([3599]);
  });

  it('uses only the newest 20 distinct instants', () => {
    const hourly = Array.from({ length: 20 }, (_, i) => at(100 * HOUR_MS + i * HOUR_MS));
    const older = Array.from({ length: 5 }, (_, i) => at(i * 24 * HOUR_MS));
    const gaps = recentGapsS([...older, ...hourly]);
    expect(gaps).toHaveLength(19);
    expect(new Set(gaps)).toEqual(new Set([3600]));
  });

  it('does not let duplicates crowd out distinct instants', () => {
    const hourly = Array.from({ length: 21 }, (_, i) => at(i * HOUR_MS));
    const newest = hourly[20] ?? T;
    const gaps = recentGapsS([...hourly, ...Array.from({ length: 10 }, () => new Date(newest))]);
    expect(gaps).toEqual(new Array<number>(19).fill(3600));
  });
});

describe('median', () => {
  it.each([
    [[], Number.NaN],
    [[3], 3],
    [[1, 3], 2],
    [[5, 1, 3], 3],
    [[4, 1, 3, 2], 2.5],
    [[86_400, 86_400, 90_000, 3600, 86_400], 86_400],
  ])('of %j is %d', (values, expected) => {
    expect(median(values)).toBe(expected);
  });
});
