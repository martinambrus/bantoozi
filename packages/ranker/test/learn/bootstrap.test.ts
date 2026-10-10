import { describe, expect, it } from 'vitest';

import * as ranker from '../../src/index.js';
import { api } from './support/api.js';
import { drivenSamples, sample, trainArgs } from './support/synth.js';

type Interval = [number, number] | null;
interface Ci {
  cvAuc: Interval;
  baselineAuc: Interval;
  deltaAuc: Interval;
}

type BootstrapFn = (
  groupIds: readonly string[],
  statistic: (multiplicity: readonly number[]) => number | null,
  seed: string,
) => Interval;

const bootstrap = (ranker as unknown as { groupedBootstrapCi?: BootstrapFn }).groupedBootstrapCi;

function ciOf(r: { metrics: unknown }): Ci {
  return (r.metrics as { ci: Ci }).ci;
}

function aucStat(scores: number[], y: number[]): (m: readonly number[]) => number | null {
  return (m) => ranker.auc(scores, y, m as number[]);
}

describe('groupedBootstrapCi', () => {
  const groups = Array.from({ length: 40 }, (_, i) => `g${Math.floor(i / 2)}`);
  const y = Array.from({ length: 40 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? 1 : 0));
  const scores = y.map((v, i) => v * 0.4 + ((i * 7) % 10) / 10);

  it('is deterministic and brackets the point estimate', () => {
    const point = ranker.auc(scores, y);
    const a = bootstrap?.(groups, aucStat(scores, y), 'seed-1');
    const b = bootstrap?.(groups, aucStat(scores, y), 'seed-1');
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
    const [lo, hi] = a ?? [0, 0];
    expect(point).not.toBeNull();
    expect(lo).toBeLessThanOrEqual(point ?? 0);
    expect(hi).toBeGreaterThanOrEqual(point ?? 1);
    expect(hi).toBeGreaterThan(lo);
  });

  it('gives a zero-width interval when every score is identical', () => {
    const flat = scores.map(() => 0.5);
    const ci = bootstrap?.(groups, aucStat(flat, y), 'seed-1');
    expect(ci).toEqual([0.5, 0.5]);
  });

  it('is null when the point estimate is undefined', () => {
    const ones = y.map(() => 1);
    expect(bootstrap?.(groups, aucStat(scores, ones), 'seed-1')).toBeNull();
  });
});

describe('trainUserModel metrics.ci', () => {
  it('reports a cvAuc interval containing cvAuc, identical across runs', () => {
    const run = (): ReturnType<typeof api.trainUserModel> =>
      api.trainUserModel(trainArgs(drivenSamples(300, 'drive')), { mode: 'production' });
    const a = run();
    const b = run();
    const ci = ciOf(a);
    expect(ci.cvAuc).not.toBeNull();
    const [lo, hi] = ci.cvAuc ?? [0, 0];
    expect(a.metrics.cvAuc).not.toBeNull();
    expect(lo).toBeLessThanOrEqual(a.metrics.cvAuc ?? 0);
    expect(hi).toBeGreaterThanOrEqual(a.metrics.cvAuc ?? 1);
    expect(ci.baselineAuc).not.toBeNull();
    expect(ci.deltaAuc).not.toBeNull();
    expect(ciOf(b)).toEqual(ci);
  }, 60_000);

  it('reports null intervals without throwing when one class has a single group', () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample(i, i === 0 ? 1 : 0, { pA: (i % 10) / 10, pB: 0.3, pC: 0.6, pN: 0.1 }),
    );
    const r = api.trainUserModel(trainArgs(samples), { mode: 'research' });
    const ci = ciOf(r);
    expect(ci.cvAuc).toBeNull();
    expect(ci.deltaAuc).toBeNull();
    expect(ci.baselineAuc === null || ci.baselineAuc[0] <= ci.baselineAuc[1]).toBe(true);
  });
});
