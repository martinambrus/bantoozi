import { describe, expect, it } from 'vitest';

import { ESTIMATE_SPEC, scoreEstimate, sigmoid, type EstimateModel } from '../../src/index.js';

const model = (over: Partial<EstimateModel> = {}): EstimateModel => ({
  spec: ESTIMATE_SPEC,
  intercept: -0.5,
  weights: { 't:cat': 1.5, 't:dog': -2 },
  platt: { a: 0.8, b: 0.1 },
  metrics: { n: 10, nPos: 5, nNeg: 5, folds: 5, auc: 0.8, feeds: {} },
  ...over,
});

describe('scoreEstimate', () => {
  it('returns null for another spec', () => {
    expect(scoreEstimate(model({ spec: 'old' }), ['t:cat'])).toBeNull();
  });

  it('sums the present weights and calibrates', () => {
    const s = scoreEstimate(model(), ['t:cat', 't:dog']);
    expect(s?.logit).toBeCloseTo(-1);
    expect(s?.p).toBeCloseTo(sigmoid(0.8 * -1 + 0.1));
  });

  it('ignores unknown features, including inherited names', () => {
    expect(scoreEstimate(model(), ['t:none', 'toString', '__proto__'])?.logit).toBe(-0.5);
  });

  it('empty features give sigmoid(a*intercept+b)', () => {
    expect(scoreEstimate(model(), [])?.p).toBeCloseTo(sigmoid(0.8 * -0.5 + 0.1));
  });
});
