import { describe, expect, it } from 'vitest';

import {
  compareLanes,
  DEFAULT_RANKER_CONFIG,
  LANE_ORDER,
  laneFromP,
  maxLane,
  minLane,
  type OrderedLane,
  tierFromP,
} from '../src/index.js';

describe('laneFromP (spec 06 §6.1)', () => {
  it.each([
    [1, 'for_you'],
    [0.65, 'for_you'],
    [0.6499, 'maybe'],
    [0.35, 'maybe'],
    [0.3499, 'everything'],
    [0, 'everything'],
  ] as const)('puts P = %s in %s', (p, lane) => {
    expect(laneFromP(p, DEFAULT_RANKER_CONFIG)).toBe(lane);
  });

  it('takes both boundaries from the config', () => {
    const config = { lanes: { forYou: 0.8, maybe: 0.2 } };
    expect(laneFromP(0.8, config)).toBe('for_you');
    expect(laneFromP(0.79, config)).toBe('maybe');
    expect(laneFromP(0.2, config)).toBe('maybe');
    expect(laneFromP(0.19, config)).toBe('everything');
  });

  it.each([Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY])('rejects P = %s', (p) => {
    expect(() => laneFromP(p, DEFAULT_RANKER_CONFIG)).toThrow(RangeError);
  });
});

describe('tierFromP (spec 06 §6.1)', () => {
  it.each([
    [0, 1],
    [0.2499, 1],
    [0.25, 2],
    [0.4499, 2],
    [0.45, 3],
    [0.6499, 3],
    [0.65, 4],
    [0.8499, 4],
    [0.85, 5],
    [1, 5],
  ] as const)('gives P = %s tier %i', (p, tier) => {
    expect(tierFromP(p, DEFAULT_RANKER_CONFIG)).toBe(tier);
  });

  it('starts each tier exactly at a configured boundary', () => {
    DEFAULT_RANKER_CONFIG.tiers.forEach((boundary, index) => {
      expect(tierFromP(boundary, DEFAULT_RANKER_CONFIG)).toBe(index + 2);
      expect(tierFromP(boundary - 1e-9, DEFAULT_RANKER_CONFIG)).toBe(index + 1);
    });
  });

  it('takes the boundaries from the config', () => {
    const config = { tiers: [0.1, 0.2, 0.3, 0.4] as const };
    expect(tierFromP(0.05, config)).toBe(1);
    expect(tierFromP(0.35, config)).toBe(4);
    expect(tierFromP(0.4, config)).toBe(5);
  });

  it('has no tier without a P', () => {
    expect(tierFromP(null, DEFAULT_RANKER_CONFIG)).toBeNull();
  });

  it.each([Number.NaN, -0.5, 2])('rejects P = %s', (p) => {
    expect(() => tierFromP(p, DEFAULT_RANKER_CONFIG)).toThrow(RangeError);
  });
});

describe('lane order (spec 06 §2)', () => {
  it('is hidden < everything < maybe < for_you', () => {
    expect(LANE_ORDER).toEqual(['hidden', 'everything', 'maybe', 'for_you']);
    for (let i = 1; i < LANE_ORDER.length; i += 1) {
      const lower = LANE_ORDER[i - 1] as OrderedLane;
      const higher = LANE_ORDER[i] as OrderedLane;
      expect(compareLanes(lower, higher)).toBeLessThan(0);
      expect(compareLanes(higher, lower)).toBeGreaterThan(0);
      expect(compareLanes(higher, higher)).toBe(0);
    }
  });

  it('caps with minLane and raises with maxLane', () => {
    expect(minLane('for_you', 'maybe')).toBe('maybe');
    expect(minLane('everything', 'maybe')).toBe('everything');
    expect(minLane('for_you', 'everything')).toBe('everything');
    expect(minLane('hidden', 'for_you')).toBe('hidden');
    expect(minLane('maybe', 'maybe')).toBe('maybe');
    expect(maxLane('everything', 'maybe')).toBe('maybe');
    expect(maxLane('for_you', 'hidden')).toBe('for_you');
  });

  it('gives new, which has no score, no place in the order', () => {
    expect(() => compareLanes('new' as OrderedLane, 'maybe')).toThrow(RangeError);
  });
});
