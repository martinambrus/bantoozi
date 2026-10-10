import { describe, expect, it } from 'vitest';

import {
  applyPlatt,
  auc,
  ece,
  fitLogistic,
  fitPlatt,
  logLoss,
  seededRandom,
  sigmoid,
} from '../../src/index.js';

/** Test-local deterministic generator (mulberry32), independent of the code under test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const TRUE_W = [2, -1.5, 0, 1];
const TRUE_B = -0.3;
const SCALE = 1.5;

function dataset(n: number, seed: number): { X: number[][]; y: (0 | 1)[] } {
  const r = rng(seed);
  const X: number[][] = [];
  const y: (0 | 1)[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = TRUE_W.map(() => SCALE * normal(r));
    const z = TRUE_B + row.reduce((s, v, j) => s + v * (TRUE_W[j] ?? 0), 0);
    X.push(row);
    y.push(r() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
  }
  return { X, y };
}

function ones(n: number): number[] {
  return Array.from({ length: n }, () => 1);
}

function norm(w: readonly number[]): number {
  return Math.sqrt(w.reduce((s, v) => s + v * v, 0));
}

function okFit(
  ...args: Parameters<typeof fitLogistic>
): Extract<ReturnType<typeof fitLogistic>, { ok: true }> {
  const res = fitLogistic(...args);
  if (!res.ok) throw new Error(`fit failed: ${res.reason}`);
  return res;
}

describe('numeric core (spec 06 §8.3)', () => {
  it('1. recovers the signs of a synthetic model and ranks held-out rows (AUC >= 0.9)', () => {
    const train = dataset(600, 11);
    const test = dataset(600, 22);
    const fit = okFit(train.X, train.y, ones(600), 1);
    expect(Math.sign(fit.weights[0] ?? 0)).toBe(1);
    expect(Math.sign(fit.weights[1] ?? 0)).toBe(-1);
    expect(Math.sign(fit.weights[3] ?? 0)).toBe(1);
    expect(Math.abs(fit.weights[2] ?? 1)).toBeLessThan(0.3);
    const scores = test.X.map(
      (row) => fit.intercept + row.reduce((s, v, j) => s + v * (fit.weights[j] ?? 0), 0),
    );
    const a = auc(scores, test.y);
    expect(a).not.toBeNull();
    expect(a as number).toBeGreaterThanOrEqual(0.9);
  });

  it('2. penalty is on the summed loss: weights grow with data at a fixed lambda', () => {
    const big = dataset(1000, 33);
    const small = { X: big.X.slice(0, 30), y: big.y.slice(0, 30) };
    const wSmall = okFit(small.X, small.y, ones(30), 1).weights[0] ?? 0;
    const wBig = okFit(big.X, big.y, ones(1000), 1).weights[0] ?? 0;
    expect(Math.abs(wSmall)).toBeLessThan(Math.abs(wBig));
  });

  it('3. integer sample weights act as row replication', () => {
    const { X, y } = dataset(80, 44);
    const weighted = okFit(
      X,
      y,
      ones(80).map((v) => v * 2),
      0.5,
    );
    const dup = okFit([...X, ...X], [...y, ...y], ones(160), 0.5);
    expect(weighted.intercept).toBeCloseTo(dup.intercept, 6);
    weighted.weights.forEach((v, j) => {
      expect(Math.abs(v - (dup.weights[j] ?? NaN))).toBeLessThan(1e-6);
    });
  });

  it('4. a larger lambda shrinks the weights', () => {
    const { X, y } = dataset(300, 55);
    const lo = okFit(X, y, ones(300), 0.01);
    const hi = okFit(X, y, ones(300), 100);
    expect(norm(hi.weights)).toBeLessThan(norm(lo.weights));
  });

  it('5. identical columns never yield NaN; lambda > 0 splits the weight evenly', () => {
    const base = dataset(200, 66);
    const X = base.X.map((row) => [row[0] ?? 0, row[0] ?? 0, row[1] ?? 0]);
    const free = fitLogistic(X, base.y, ones(200), 0);
    if (free.ok) {
      expect([...free.weights, free.intercept].every(Number.isFinite)).toBe(true);
    } else {
      expect(free.reason).toBe('singular');
    }
    const ridge = okFit(X, base.y, ones(200), 1);
    expect(Math.abs((ridge.weights[0] ?? 0) - (ridge.weights[1] ?? NaN))).toBeLessThan(1e-6);
    expect([...ridge.weights, ridge.intercept].every(Number.isFinite)).toBe(true);
  });

  it('6. a non-finite input is rejected as nonfinite', () => {
    const { X, y } = dataset(50, 77);
    const bad = X.map((row) => [...row]);
    (bad[3] as number[])[1] = Number.NaN;
    expect(fitLogistic(bad, y, ones(50), 1)).toEqual({ ok: false, reason: 'nonfinite' });
  });

  it('7. separable data at lambda 0 never returns non-finite weights', () => {
    const X = [[-2], [-1], [1], [2]];
    const y: (0 | 1)[] = [0, 0, 1, 1];
    const res = fitLogistic(X, y, ones(4), 0);
    if (res.ok) {
      expect([...res.weights, res.intercept].every(Number.isFinite)).toBe(true);
    } else {
      expect(res.reason).toBe('nonconverged');
    }
  });

  it('8. a single class with lambda > 0 fits with the intercept on the class side', () => {
    const X = [
      [0.5, -1],
      [1, 0.2],
      [-0.3, 0.8],
      [0.1, 0.1],
    ];
    const pos = okFit(X, [1, 1, 1, 1], ones(4), 1);
    expect(pos.intercept).toBeGreaterThan(0);
    const neg = okFit(X, [0, 0, 0, 0], ones(4), 1);
    expect(neg.intercept).toBeLessThan(0);
  });

  it('9. auc matches Mann-Whitney values, ties count one half, an empty class is null', () => {
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75, 12);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBeCloseTo(0.5, 12);
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBeCloseTo(1, 12);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBeCloseTo(0, 12);
    // positives {0.5, 0.9}, negatives {0.5, 0.2}: pairs 0.5>0.5 tie (0.5), 0.5>0.2, 0.9>0.5, 0.9>0.2 -> 3.5/4
    expect(auc([0.5, 0.9, 0.5, 0.2], [1, 1, 0, 0])).toBeCloseTo(0.875, 12);
    expect(auc([0.1, 0.2, 0.3], [1, 1, 1])).toBeNull();
    expect(auc([0.1, 0.2, 0.3], [0, 0, 0])).toBeNull();
    expect(auc([], [])).toBeNull();
  });

  it('10. ece uses ten equal-width bins; perfect calibration is 0', () => {
    // bins: 0.05 -> 0 (|0.05-0|), 0.15 -> 1 (|0.15-1|), two at 0.95 -> 9 (|0.95-0.5|)
    // = 0.25*0.05 + 0.25*0.85 + 0.5*0.45 = 0.45
    expect(ece([0.05, 0.15, 0.95, 0.95], [0, 1, 1, 0])).toBeCloseTo(0.45, 12);
    expect(ece([0.25, 0.25, 0.25, 0.25], [1, 0, 0, 0])).toBeCloseTo(0, 12);
    expect(ece([0, 0, 1, 1], [0, 0, 1, 1])).toBeCloseTo(0, 12);
  });

  it('11. Platt scaling lowers the ECE of over-confident scores', () => {
    const r = rng(99);
    const n = 5000;
    const z = Array.from({ length: n }, () => 6 * r() - 3);
    const y: (0 | 1)[] = z.map((v) => (r() < 1 / (1 + Math.exp(-v)) ? 1 : 0));
    const logits = z.map((v) => 3 * v);
    const before = ece(
      logits.map((v) => sigmoid(v)),
      y,
    );
    const cal = fitPlatt(logits, y);
    const after = ece(
      logits.map((v) => applyPlatt(cal, v)),
      y,
    );
    expect(after).toBeLessThan(before);
    expect(cal.a).toBeGreaterThan(0.2);
    expect(cal.a).toBeLessThan(0.5);
  });

  it('12. Platt with no data returns the identity prior', () => {
    const cal = fitPlatt([], []);
    expect(cal.a).toBeCloseTo(1, 6);
    expect(cal.b).toBeCloseTo(0, 6);
  });

  it('13. logLoss clips probabilities so p = 0 with y = 1 is finite', () => {
    const v = logLoss([0], [1]);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(-Math.log(1e-6), 6);
    expect(Number.isFinite(logLoss([1], [0]))).toBe(true);
  });

  it('14. seededRandom is deterministic per seed and differs across seeds', () => {
    const a = seededRandom('seed-a');
    const a2 = seededRandom('seed-a');
    const b = seededRandom('seed-b');
    const seqA = Array.from({ length: 20 }, () => a());
    const seqA2 = Array.from({ length: 20 }, () => a2());
    expect(seqA).toEqual(seqA2);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(b()).not.toBe(seqA[0]);
  });
});
