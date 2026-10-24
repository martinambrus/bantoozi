import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ESTIMATE_OPTIONS,
  ESTIMATE_SPEC,
  estimateFeatures,
  estimateGate,
  scoreEstimate,
  trainEstimateModel,
  type EstimateModel,
  type EstimateSample,
} from '../../src/index.js';
import { seededRandom } from '../../src/learn/random.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');

function corpus(n: number, posShare = 0.5, seed = 'c'): EstimateSample[] {
  const rnd = seededRandom(seed);
  const likeWords = ['garden', 'recipe', 'cooking', 'travel', 'music'];
  const dislikeWords = ['crypto', 'celebrity', 'gossip', 'lottery', 'horoscope'];
  const common = ['today', 'new', 'report', 'people', 'world', 'story', 'week'];
  return Array.from({ length: n }, (_, i) => {
    const pos = rnd() < posShare;
    const pick = (list: string[]) => list[Math.floor(rnd() * list.length)] as string;
    const feed = pos ? (rnd() < 0.8 ? 'fa' : 'fb') : rnd() < 0.8 ? 'fb' : 'fa';
    const feed2 = i % 3 === 0 ? 'fc' : feed;
    return {
      articleId: `a${String(i).padStart(4, '0')}`,
      rating: pos ? 1 : -1,
      ratedAt: new Date(T0 + i * 60_000),
      title: `${pick(common)} ${pick(pos ? likeWords : dislikeWords)} ${pick(common)}`,
      excerpt: `${pick(pos ? likeWords : dislikeWords)} ${pick(common)} ${pick(common)}`,
      feedId: feed2,
    };
  });
}

function must(samples: EstimateSample[], options = {}): EstimateModel {
  const r = trainEstimateModel(samples, options);
  if (!r.ok) throw new Error('expected a model');
  return r.model;
}

describe('estimateGate', () => {
  it('has the truth table', () => {
    expect(estimateGate({ n: 9, nPos: 4, nNeg: 5 })).toEqual({ open: false, needed: 1 });
    expect(estimateGate({ n: 10, nPos: 3, nNeg: 7 })).toEqual({ open: true, needed: 0 });
    expect(estimateGate({ n: 10, nPos: 2, nNeg: 8 })).toEqual({ open: false, needed: 1 });
    expect(estimateGate({ n: 0, nPos: 0, nNeg: 0 })).toEqual({ open: false, needed: 10 });
    expect(estimateGate({ n: 100, nPos: 100, nNeg: 0 })).toEqual({ open: false, needed: 3 });
    expect(estimateGate({ n: 100, nPos: 1, nNeg: 99 })).toEqual({ open: false, needed: 2 });
  });

  it('honours custom options', () => {
    expect(estimateGate({ n: 4, nPos: 2, nNeg: 2 }, { minRatings: 4, minEachClass: 2 }).open).toBe(
      true,
    );
    expect(estimateGate({ n: 4, nPos: 2, nNeg: 2 }, { minRatings: 6 })).toEqual({
      open: false,
      needed: 2,
    });
    expect(estimateGate({ n: 5, nPos: 5, nNeg: 0 }, { minRatings: 1, minEachClass: 0 }).open).toBe(
      true,
    );
  });
});

describe('trainEstimateModel', () => {
  it('stays closed below the gate', () => {
    expect(trainEstimateModel([])).toEqual({ ok: false, reason: 'below_gate' });
    expect(trainEstimateModel(corpus(9))).toEqual({ ok: false, reason: 'below_gate' });
    expect(trainEstimateModel(corpus(100, 1.01))).toEqual({ ok: false, reason: 'below_gate' });
    const twoPos = corpus(30).map((s, i) => ({ ...s, rating: (i < 2 ? 1 : -1) as 1 | -1 }));
    expect(trainEstimateModel(twoPos)).toEqual({ ok: false, reason: 'below_gate' });
  });

  it('trains at exactly 10 ratings with 3 and 7', () => {
    const s = corpus(10).map((x, i) => ({ ...x, rating: (i < 3 ? 1 : -1) as 1 | -1 }));
    const m = must(s);
    expect(m.metrics).toMatchObject({ n: 10, nPos: 3, nNeg: 7 });
  });

  it('is independent of the input order and byte-stable', () => {
    const s = corpus(80);
    const json = JSON.stringify(must(s));
    expect(JSON.stringify(must(s))).toBe(json);
    expect(JSON.stringify(must([...s].reverse()))).toBe(json);
    const rnd = seededRandom('shuffle');
    const shuffled = [...s].sort(() => rnd() - 0.5);
    expect(JSON.stringify(must(shuffled))).toBe(json);
    expect(JSON.parse(json)).toEqual(must(s));
  });

  it('orders equal times by article id then rating', () => {
    const base = corpus(40).map((x) => ({ ...x, ratedAt: new Date(T0) }));
    const m = must(base);
    expect(JSON.stringify(must([...base].reverse()))).toBe(JSON.stringify(m));
    const dup = [...base, { ...base[0]!, rating: (base[0]!.rating === 1 ? -1 : 1) as 1 | -1 }];
    expect(JSON.stringify(must([...dup].reverse()))).toBe(JSON.stringify(must(dup)));
  });

  it('pins the trained model: when this hash changes, give DEFAULT_ESTIMATE_OPTIONS.seed a new revision', () => {
    // The input hash of a stored model covers the options but not the trainer's code. When the arithmetic of
    // training changes on purpose, a new default seed (estimate-v3, ...) makes every stored model retrain once;
    // then replace the hash below.
    const rounded = JSON.stringify(must(corpus(80)), (_key, value: unknown) =>
      typeof value === 'number' ? Number(value.toFixed(6)) : value,
    );
    expect(createHash('sha256').update(rounded).digest('hex')).toBe(
      '68affe3b0e6cb20756dc0a93a347b0dd9b372dea06450b233bc64841dd1594d2',
    );
  });

  it('carries the spec and sorted keys', () => {
    const m = must(corpus(60));
    expect(m.spec).toBe(ESTIMATE_SPEC);
    const keys = Object.keys(m.weights);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : 1)));
    expect(Object.values(m.weights).every((w) => w !== 0 && Number.isFinite(w))).toBe(true);
  });

  it('keeps at most maxWeights, exactly the largest of an unpruned run', () => {
    const s = corpus(120);
    const full = must(s, { maxWeights: 1_000_000 });
    expect(Object.keys(full.weights).length).toBeGreaterThan(5);
    expect(Object.keys(must(s, { maxWeights: 7 }).weights).length).toBeLessThanOrEqual(7);
    const support = new Map<string, number>();
    for (const sample of s) {
      for (const feature of new Set(estimateFeatures(sample))) {
        support.set(feature, (support.get(feature) ?? 0) + 1);
      }
    }
    const contribution = ([name, w]: [string, number]) =>
      Math.abs(w) * Math.sqrt(support.get(name) as number);
    const top = Object.entries(full.weights)
      .sort((a, b) => contribution(b) - contribution(a) || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([k]) => k)
      .sort();
    expect(Object.keys(must(s, { maxWeights: 5 }).weights)).toEqual(top);
  });

  it('ranks held-out ratings on a corpus with class-specific words', () => {
    const m = must(corpus(300));
    expect(m.metrics.auc).toBeGreaterThanOrEqual(0.9);
    expect(m.platt.a).toBeGreaterThan(0);
  });

  it('reports per-feed metrics only for feeds with enough scored ratings and both classes', () => {
    const s = corpus(200).map((x, i) => (i % 50 === 0 ? { ...x, feedId: 'rare' } : x));
    const m = must(s);
    expect(Object.keys(m.metrics.feeds)).toEqual(['fa', 'fb', 'fc']);
    for (const f of Object.values(m.metrics.feeds)) {
      expect(f.n).toBeGreaterThanOrEqual(10);
      expect(f.nPos).toBeGreaterThan(0);
      expect(f.nNeg).toBeGreaterThan(0);
      expect(f.nPos + f.nNeg).toBe(f.n);
    }
    const oneClass = corpus(60).map((x) => ({ ...x, feedId: x.rating === 1 ? 'pos' : 'neg' }));
    expect(must(oneClass).metrics.feeds).toEqual({});
    const nullFeed = corpus(60).map((x) => ({ ...x, feedId: null }));
    expect(must(nullFeed).metrics.feeds).toEqual({});
  });

  it('still ranks the minority class high when imbalanced', () => {
    const s = corpus(400, 0.1);
    const m = must(s);
    expect(m.metrics.nPos).toBeLessThan(m.metrics.nNeg / 3);
    expect(m.metrics.auc).toBeGreaterThanOrEqual(0.85);
    const pos = s.filter((x) => x.rating === 1);
    const neg = s.filter((x) => x.rating === -1);
    const mean = (xs: EstimateSample[]) =>
      xs.reduce((sum, x) => sum + (scoreEstimate(m, estimateFeatures(x))?.p ?? 0), 0) / xs.length;
    expect(mean(pos)).toBeGreaterThan(mean(neg));
  });

  it('adds up counts and folds', () => {
    const m = must(corpus(77));
    expect(m.metrics.nPos + m.metrics.nNeg).toBe(m.metrics.n);
    expect(m.metrics.n).toBe(77);
    expect(m.metrics.folds).toBe(DEFAULT_ESTIMATE_OPTIONS.folds);
    const none = must(corpus(77), { folds: 1 });
    expect(none.metrics.folds).toBe(0);
    expect(none.metrics.auc).toBeNull();
    expect(none.platt).toEqual({ a: 1, b: 0 });
  });

  it('skips a fold whose training rows lack a class', () => {
    const s = corpus(20).map((x, i) => ({
      ...x,
      rating: (i < 12 ? -1 : i < 16 ? 1 : -1) as 1 | -1,
    }));
    const m = must(s, { folds: 2, minEachClass: 3 });
    expect(m.metrics.folds).toBe(1);
    const lopsided = corpus(20).map((x, i) => ({ ...x, rating: (i < 10 ? 1 : -1) as 1 | -1 }));
    const l = must(lopsided, { folds: 2 });
    expect(l.metrics.folds).toBe(0);
    expect(l.metrics.auc).toBeNull();
  });

  it('closes when the full fit lacks a class under a zero gate', () => {
    const s = corpus(12).map((x) => ({ ...x, rating: 1 as const }));
    expect(trainEstimateModel(s, { minRatings: 1, minEachClass: 0 })).toEqual({
      ok: false,
      reason: 'below_gate',
    });
  });
});
