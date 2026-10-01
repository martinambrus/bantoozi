import { describe, expect, it } from 'vitest';

import { mergeRunCost, priorRunCost } from '../src/experiments/runner.js';

/** D-122: a resumed run's cost covers every invocation. */
const cost = (billed: number, estimate: number, savings: number) => ({
  estimatedUsd: estimate,
  billedUsd: billed,
  cacheHits: 1,
  cacheMisses: 2,
  cacheSavingsUsd: savings,
  failedCallUsd: 0.001,
  tokens: { input: 10, output: 5 },
  byLang: { en: { estimatedUsd: estimate, billedUsd: billed, cacheSavingsUsd: savings } },
});

describe('resumed run cost', () => {
  it('sums billed, savings, tokens and cache counters; keeps the first whole-run estimate', () => {
    const merged = mergeRunCost(cost(0.3, 1, 0.02), cost(0.5, 0.6, 0.01), false);
    expect(merged).toMatchObject({
      billedUsd: 0.8,
      estimatedUsd: 1,
      cacheHits: 2,
      cacheMisses: 4,
      failedCallUsd: 0.002,
      tokens: { input: 20, output: 10 },
      invocations: 2,
    });
    expect(merged.cacheSavingsUsd).toBeCloseTo(0.03, 12);
    expect(merged.byLang['en']!.billedUsd).toBeCloseTo(0.8, 12);
    expect(merged.incomplete).toBeUndefined();
    expect(mergeRunCost(merged, cost(0.1, 0, 0), false).invocations).toBe(3);
  });

  it('marks the cost incomplete when an earlier invocation recorded none', () => {
    expect(priorRunCost({ status: 'running', progress: { done: 1, total: 4 } })).toEqual({
      cost: null,
      incomplete: true,
    });
    expect(mergeRunCost(null, cost(0.5, 0.6, 0), true)).toMatchObject({
      billedUsd: 0.5,
      incomplete: true,
    });
    const carried = priorRunCost({
      status: 'running',
      cost: { ...cost(0.3, 1, 0), incomplete: true },
    });
    expect(carried.incomplete).toBe(true);
    expect(carried.cost?.billedUsd).toBe(0.3);
  });
});
