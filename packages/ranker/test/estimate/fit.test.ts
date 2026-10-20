import { describe, expect, it } from 'vitest';

import { fitLogistic, pruneWeights, timeFold } from '../../src/estimate/fit.js';

const params = { epochs: 8, learningRate: 0.3, l2: 1e-4, seed: 's' };

function toy() {
  const features: Int32Array[] = [];
  const labels: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    features.push(Int32Array.from([i % 2 === 0 ? 0 : 1, 2]));
    labels.push(i % 2 === 0 ? 1 : 0);
  }
  return { features, labels: Uint8Array.from(labels), vocabSize: 3 };
}
const all = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

describe('fitLogistic', () => {
  it('learns a separable toy set', () => {
    const data = toy();
    const fit = fitLogistic(data, all(20), params);
    expect(fit).not.toBeNull();
    expect(fit?.weights[0] ?? 0).toBeGreaterThan(0.5);
    expect(fit?.weights[1] ?? 0).toBeLessThan(-0.5);
  });

  it('returns null when a class is missing', () => {
    const data = toy();
    expect(fitLogistic(data, Int32Array.from([0, 2, 4]), params)).toBeNull();
    expect(fitLogistic(data, Int32Array.from([1, 3]), params)).toBeNull();
  });

  it('is deterministic per seed', () => {
    const data = toy();
    const a = fitLogistic(data, all(20), params);
    const b = fitLogistic(data, all(20), params);
    expect(Array.from(a?.weights ?? [])).toEqual(Array.from(b?.weights ?? []));
    expect(a?.bias).toBe(b?.bias);
  });
});

describe('pruneWeights', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];

  it('keeps the largest absolute weights', () => {
    const w = Float64Array.from([0.1, -3, 2, 0, -0.5]);
    pruneWeights(w, names, 2);
    expect(Array.from(w)).toEqual([0, -3, 2, 0, 0]);
  });

  it('keeps the smaller names among ties at the cut', () => {
    const w = Float64Array.from([1, -1, 1, 5, 1]);
    pruneWeights(w, names, 3);
    expect(Array.from(w)).toEqual([1, -1, 0, 5, 0]);
  });

  it('is a no-op when keep covers the non-zero weights', () => {
    const w = Float64Array.from([1, 0, 2, 0, 3]);
    pruneWeights(w, names, 3);
    expect(Array.from(w)).toEqual([1, 0, 2, 0, 3]);
    pruneWeights(w, names, 10);
    expect(Array.from(w)).toEqual([1, 0, 2, 0, 3]);
  });

  it('zeroes everything for keep 0', () => {
    const w = Float64Array.from([1, 2, 3, 4, 5]);
    pruneWeights(w, names, 0);
    expect(Array.from(w)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('timeFold', () => {
  it('makes contiguous blocks whose sizes differ by at most one', () => {
    for (const [n, k] of [
      [10, 5],
      [11, 5],
      [23, 4],
      [7, 7],
      [100, 3],
    ] as const) {
      const folds = Array.from({ length: n }, (_, i) => timeFold(i, n, k));
      for (let i = 1; i < n; i += 1)
        expect(folds[i]).toBeGreaterThanOrEqual(folds[i - 1] as number);
      const sizes = Array.from({ length: k }, (_, f) => folds.filter((x) => x === f).length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(Math.min(...sizes)).toBeGreaterThan(0);
    }
  });
});
