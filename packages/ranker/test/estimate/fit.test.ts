import { describe, expect, it } from 'vitest';

import {
  epochOrder,
  featureSupport,
  fitLogistic,
  pruneWeights,
  timeFold,
  type FitData,
  type FitParams,
} from '../../src/estimate/fit.js';
import { murmur3 } from '../../src/learn/murmur3.js';
import { seededRandom } from '../../src/learn/random.js';

const params = { epochs: 8, learningRate: 0.3, l2: 1e-4, seed: 's' };

function toy() {
  const features: Int32Array[] = [];
  const labels: number[] = [];
  const keys = new Uint32Array(20);
  for (let i = 0; i < 20; i += 1) {
    features.push(Int32Array.from([i % 2 === 0 ? 0 : 1, 2]));
    labels.push(i % 2 === 0 ? 1 : 0);
    keys[i] = murmur3(`a${i}`);
  }
  return { features, labels: Uint8Array.from(labels), keys, vocabSize: 3 };
}
const all = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

/** Small, dense oracle: explicitly sum every post-update state, including untouched coordinates. */
function denseAverage(data: FitData, rows: Int32Array, options: FitParams) {
  const weights = new Float64Array(data.vocabSize);
  const accumulators = new Float64Array(data.vocabSize).fill(1e-8);
  const total = new Float64Array(data.vocabSize);
  const positives = Array.from(rows).reduce((sum, row) => sum + data.labels[row]!, 0);
  const classWeights = [
    rows.length / (2 * (rows.length - positives)),
    rows.length / (2 * positives),
  ];
  let bias = 0;
  let biasAccumulator = 1e-8;
  let totalBias = 0;
  let count = 0;
  const epochs = Math.ceil(options.epochs);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const learningRate = options.learningRate / Math.sqrt(epoch + 1);
    for (const row of epochOrder(data.keys, rows, options.seed, epoch)) {
      const features = data.features[row]!;
      const z = Array.from(features).reduce((sum, id) => sum + weights[id]!, bias);
      const label = data.labels[row]!;
      const gradient = (1 / (1 + Math.exp(-z)) - label) * classWeights[label]!;
      biasAccumulator += gradient ** 2;
      bias -= (learningRate * gradient) / Math.sqrt(biasAccumulator);
      for (const id of features) {
        const gradientWithPenalty = gradient + options.l2 * weights[id]!;
        accumulators[id] = accumulators[id]! + gradientWithPenalty ** 2;
        weights[id] =
          weights[id]! - (learningRate * gradientWithPenalty) / Math.sqrt(accumulators[id]!);
      }
      if (epoch >= Math.floor(epochs / 2)) {
        for (let id = 0; id < weights.length; id += 1) total[id] = total[id]! + weights[id]!;
        totalBias += bias;
        count += 1;
      }
    }
  }
  return {
    weights: total.map((value) => (count ? value / count : 0)),
    bias: count ? totalBias / count : 0,
  };
}

describe('fitLogistic', () => {
  it.each([0, 1, 3, 3.5, 8])(
    'matches dense tail averaging with %s epochs and sparse, uneven feature visits',
    (epochs) => {
      const data: FitData = {
        features: [[0, 1], [2], [], [0], [1], [2, 3]].map((ids) => Int32Array.from(ids)),
        labels: Uint8Array.from([1, 0, 0, 0, 1, 0]),
        keys: Uint32Array.from({ length: 6 }, (_, i) => murmur3(`sparse-${i}`)),
        vocabSize: 5,
      };
      // Excludes a row and leaves feature 4 unseen; empty-feature rows must still count in the mean.
      const rows = Int32Array.from([0, 1, 2, 4, 5]);
      const options = { ...params, epochs, l2: 0.1 };
      const actual = fitLogistic(data, rows, options)!;
      const expected = denseAverage(data, rows, options);
      for (let id = 0; id < data.vocabSize; id += 1) {
        expect(actual.weights[id]).toBeCloseTo(expected.weights[id]!, 12);
      }
      expect(actual.bias).toBeCloseTo(expected.bias, 12);
      expect(actual.weights[4]).toBe(0);
    },
  );

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
  const ones = [1, 1, 1, 1, 1];

  it('keeps the largest absolute weights', () => {
    const w = Float64Array.from([0.1, -3, 2, 0, -0.5]);
    pruneWeights(w, names, 2, ones);
    expect(Array.from(w)).toEqual([0, -3, 2, 0, 0]);
  });

  it('keeps the smaller names among ties at the cut', () => {
    const w = Float64Array.from([1, -1, 1, 5, 1]);
    pruneWeights(w, names, 3, ones);
    expect(Array.from(w)).toEqual([1, -1, 0, 5, 0]);
  });

  it('is a no-op when keep covers the non-zero weights', () => {
    const w = Float64Array.from([1, 0, 2, 0, 3]);
    pruneWeights(w, names, 3, ones);
    expect(Array.from(w)).toEqual([1, 0, 2, 0, 3]);
    pruneWeights(w, names, 10, ones);
    expect(Array.from(w)).toEqual([1, 0, 2, 0, 3]);
  });

  it('zeroes everything for keep 0', () => {
    const w = Float64Array.from([1, 2, 3, 4, 5]);
    pruneWeights(w, names, 0, ones);
    expect(Array.from(w)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('pruneWeights by contribution', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];

  it('ranks by |w| times the root of the support', () => {
    const w = Float64Array.from([0.3, 0.1, 0, 0, 0]);
    pruneWeights(w, names, 1, [1, 16, 1, 1, 1]);
    expect(Array.from(w)).toEqual([0, 0.1, 0, 0, 0]);
  });

  it('keeps the smaller names among exact score ties', () => {
    const w = Float64Array.from([0.5, 0.25, 0.5, 0, 0.25]);
    pruneWeights(w, names, 2, [1, 4, 1, 1, 4]);
    expect(Array.from(w)).toEqual([0.5, 0.25, 0, 0, 0]);
  });
});

describe('featureSupport', () => {
  it('counts only the given rows', () => {
    const data = toy();
    expect(Array.from(featureSupport(data, all(20)))).toEqual([10, 10, 20]);
    expect(Array.from(featureSupport(data, Int32Array.from([0, 1, 2])))).toEqual([2, 1, 3]);
    expect(Array.from(featureSupport(data, new Int32Array(0)))).toEqual([0, 0, 0]);
  });
});

function relativeOrder(order: Int32Array, among: Set<number>): number[] {
  return Array.from(order).filter((row) => among.has(row));
}

function spearman(a: Int32Array, b: Int32Array): number {
  const n = a.length;
  const posB = new Map<number, number>();
  b.forEach((row, k) => posB.set(row, k));
  let sum = 0;
  a.forEach((row, k) => {
    const d = k - (posB.get(row) as number);
    sum += d * d;
  });
  return 1 - (6 * sum) / (n * (n * n - 1));
}

describe('epochOrder', () => {
  const keysFor = (n: number) => Uint32Array.from({ length: n }, (_, i) => murmur3(`row${i}`));

  it('is a permutation of rows and deterministic', () => {
    const keys = keysFor(300);
    const rows = Int32Array.from({ length: 150 }, (_, i) => i * 2);
    const a = epochOrder(keys, rows, 's', 3);
    expect(Array.from(a).sort((x, y) => x - y)).toEqual(Array.from(rows));
    expect(Array.from(epochOrder(keys, rows, 's', 3))).toEqual(Array.from(a));
  });

  it('differs between epochs and between seeds', () => {
    const keys = keysFor(200);
    const rows = all(200);
    const base = Array.from(epochOrder(keys, rows, 's', 0));
    expect(Array.from(epochOrder(keys, rows, 's', 1))).not.toEqual(base);
    expect(Array.from(epochOrder(keys, rows, 't', 0))).not.toEqual(base);
  });

  it('keeps the relative order of the others when a row is removed or added', () => {
    const keys = keysFor(400);
    const rnd = seededRandom('pick');
    for (const size of [5, 40, 120, 399]) {
      for (const seed of ['a', 'b', 'c']) {
        for (let epoch = 0; epoch < 3; epoch += 1) {
          const pool = Array.from({ length: 400 }, (_, i) => i).sort(() => rnd() - 0.5);
          const rows = Int32Array.from(pool.slice(0, size).sort((x, y) => x - y));
          const dropAt = Math.floor(rnd() * size);
          const without = Int32Array.from(Array.from(rows).filter((_, k) => k !== dropAt));
          const withAll = epochOrder(keys, rows, seed, epoch);
          const withoutOne = epochOrder(keys, without, seed, epoch);
          expect(Array.from(withoutOne)).toEqual(relativeOrder(withAll, new Set(without)));
          const outside = pool[size] as number;
          const plus = Int32Array.from([...rows, outside].sort((x, y) => x - y));
          const withPlus = epochOrder(keys, plus, seed, epoch);
          expect(Array.from(epochOrder(keys, rows, seed, epoch))).toEqual(
            relativeOrder(withPlus, new Set(rows)),
          );
        }
      }
    }
  });

  it('keeps the order of rows for equal keys', () => {
    const keys = new Uint32Array(10).fill(7);
    const rows = Int32Array.from([4, 1, 9, 0, 6]);
    expect(Array.from(epochOrder(keys, rows, 's', 2))).toEqual([4, 1, 9, 0, 6]);
  });

  it('is uncorrelated between epochs and between seeds', () => {
    const n = 2_000;
    const keys = keysFor(n);
    const rows = all(n);
    const e0 = epochOrder(keys, rows, 's', 0);
    expect(Math.abs(spearman(e0, epochOrder(keys, rows, 's', 1)))).toBeLessThan(0.1);
    expect(Math.abs(spearman(e0, epochOrder(keys, rows, 'other', 0)))).toBeLessThan(0.1);
  });

  it('places a row near the middle on average over epochs', () => {
    const n = 500;
    const keys = keysFor(n);
    const rows = all(n);
    const total = new Float64Array(n);
    const epochs = 40;
    for (let epoch = 0; epoch < epochs; epoch += 1) {
      epochOrder(keys, rows, 's', epoch).forEach((row, k) => {
        total[row] = (total[row] as number) + k / (n - 1);
      });
    }
    for (let row = 0; row < n; row += 10) {
      const mean = (total[row] as number) / epochs;
      expect(mean).toBeGreaterThan(0.3);
      expect(mean).toBeLessThan(0.7);
    }
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
