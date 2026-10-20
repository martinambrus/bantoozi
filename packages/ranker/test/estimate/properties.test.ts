import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_SPEC,
  estimateGate,
  scoreEstimate,
  trainEstimateModel,
  type EstimateModel,
  type EstimateSample,
} from '../../src/index.js';

const names = ['t:a', 't:b', 't:c', 'b:a_b', 'e:x', 'f:1'];

const modelArb = fc
  .record({
    intercept: fc.double({ min: -5, max: 5, noNaN: true }),
    a: fc.double({ min: 1e-3, max: 5, noNaN: true }),
    b: fc.double({ min: -3, max: 3, noNaN: true }),
    weights: fc.dictionary(fc.constantFrom(...names), fc.double({ min: -6, max: 6, noNaN: true })),
  })
  .map(({ intercept, a, b, weights }): EstimateModel => ({
    spec: ESTIMATE_SPEC,
    intercept,
    weights,
    platt: { a, b },
    metrics: { n: 10, nPos: 5, nNeg: 5, folds: 5, auc: null, feeds: {} },
  }));
const featuresArb = fc.subarray([...names, 'unknown']);

describe('scoreEstimate properties', () => {
  it('p is finite and within [0, 1]', () => {
    fc.assert(
      fc.property(modelArb, featuresArb, (m, f) => {
        const s = scoreEstimate(m, f);
        expect(s).not.toBeNull();
        expect(Number.isFinite(s?.p)).toBe(true);
        expect(s?.p).toBeGreaterThanOrEqual(0);
        expect(s?.p).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('p is monotone in the logit', () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: 1e-6, max: 10, noNaN: true }),
        (m, z1, d) => {
          const lo = scoreEstimate({ ...m, intercept: z1, weights: {} }, []);
          const hi = scoreEstimate({ ...m, intercept: z1 + d, weights: {} }, []);
          expect(lo?.p).toBeLessThanOrEqual(hi?.p ?? -1);
        },
      ),
    );
  });

  it('a positive weight never lowers p and a negative one never raises it', () => {
    fc.assert(
      fc.property(modelArb, featuresArb, fc.constantFrom(...names), (m, f, extra) => {
        const without = f.filter((x) => x !== extra);
        const before = scoreEstimate(m, without)?.p ?? NaN;
        const after = scoreEstimate(m, [...without, extra])?.p ?? NaN;
        const w = m.weights[extra] ?? 0;
        if (w > 0) expect(after).toBeGreaterThanOrEqual(before);
        if (w < 0) expect(after).toBeLessThanOrEqual(before);
      }),
    );
  });
});

const words = ['red', 'blue', 'green', 'pink', 'gray', 'gold'];
const sampleArb = (i: number): fc.Arbitrary<EstimateSample> =>
  fc.record({
    articleId: fc.constant(`a${i}`),
    rating: fc.constantFrom(1 as const, -1 as const),
    ratedAt: fc.integer({ min: 0, max: 1_000_000 }).map((t) => new Date(t)),
    title: fc.array(fc.constantFrom(...words), { maxLength: 4 }).map((w) => w.join(' ')),
    excerpt: fc.array(fc.constantFrom(...words), { maxLength: 6 }).map((w) => w.join(' ')),
    feedId: fc.constantFrom('1', '2', '3', '4'),
  });

describe('trainEstimateModel properties', () => {
  it('is closed exactly when the gate says so, else a sane model', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 10, max: 60 })
          .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => sampleArb(i)))),
        (samples) => {
          const nPos = samples.filter((s) => s.rating === 1).length;
          const gate = estimateGate({ n: samples.length, nPos, nNeg: samples.length - nPos });
          const r = trainEstimateModel(samples);
          expect(r.ok).toBe(gate.open);
          if (!r.ok) return;
          expect(Object.values(r.model.weights).every(Number.isFinite)).toBe(true);
          expect(Number.isFinite(r.model.intercept)).toBe(true);
          expect(r.model.platt.a).toBeGreaterThan(0);
          const m = r.model.metrics;
          expect(m.nPos + m.nNeg).toBe(m.n);
          expect(m.n).toBe(samples.length);
        },
      ),
      { numRuns: 30 },
    );
  });
});
