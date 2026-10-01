import { describe, expect, it } from 'vitest';

import {
  accuracy,
  averageRanks,
  binIndex,
  calibration,
  cohenKappa,
  groupBootstrap,
  hierarchicalWeights,
  isotonicPredict,
  isotonicRegression,
  laneDistribution,
  macroF1,
  mannWhitneyU,
  meanAbsoluteError,
  pairedGroupBootstrap,
  participantMacro,
  policySummary,
  precisionAtK,
  precisionRecallAtCutoff,
  rocAuc,
  smallestScoreReaching,
  spearman,
  topKAccuracy,
  type GroupWeights,
  type ScoredLabel,
} from '../src/metrics/index.js';

/** M3a-T5 (spec 10 §4): every metric against hand-computed values. */

const pos = (score: number, weight?: number): ScoredLabel => ({
  score,
  positive: true,
  ...(weight === undefined ? {} : { weight }),
});
const neg = (score: number, weight?: number): ScoredLabel => ({
  score,
  positive: false,
  ...(weight === undefined ? {} : { weight }),
});

describe('ROC AUC (Mann–Whitney U)', () => {
  it('matches the hand-computed U with ties counted as ½', () => {
    // Pairs: 0.9 beats 3, 0.8 beats 3, 0.5 beats 0.1, ties 0.5 (½), loses to 0.7 → U = 7.5.
    const items = [pos(0.9), pos(0.8), pos(0.5), neg(0.7), neg(0.5), neg(0.1)];
    expect(mannWhitneyU(items)).toEqual({ u: 7.5, positives: 3, negatives: 3 });
    expect(rocAuc(items)).toBeCloseTo(7.5 / 9, 12);
  });

  it('is 0.5 when every score ties, 1 when perfectly separated and 0 when inverted', () => {
    expect(rocAuc([pos(0.4), pos(0.4), neg(0.4)])).toBe(0.5);
    expect(rocAuc([pos(0.9), neg(0.1)])).toBe(1);
    expect(rocAuc([pos(0.1), neg(0.9)])).toBe(0);
  });

  it('treats weights as multiplicities', () => {
    const weighted = rocAuc([pos(0.9), pos(0.3, 2), neg(0.5), neg(0.1)]);
    const duplicated = rocAuc([pos(0.9), pos(0.3), pos(0.3), neg(0.5), neg(0.1)]);
    expect(weighted).toBeCloseTo(duplicated ?? Number.NaN, 12);
    // pos 0.9 beats both (2), each 0.3 beats 0.1 only (1 each) → U = 4 of 6.
    expect(weighted).toBeCloseTo(4 / 6, 12);
    expect(rocAuc([pos(0.9), neg(0.1), pos(0.05, 0)])).toBe(1);
  });

  it('is null for a single class, never 0 or 0.5', () => {
    expect(rocAuc([pos(0.9), pos(0.1)])).toBeNull();
    expect(rocAuc([neg(0.9)])).toBeNull();
    expect(rocAuc([])).toBeNull();
  });
});

describe('P@k', () => {
  const item = (id: string, score: number, positive: boolean, firstSeenAt = 0) => ({
    id,
    score,
    positive,
    firstSeenAt,
  });

  it('counts likes in the top k with stable (score, firstSeenAt, id) DESC ties', () => {
    const items = [
      item('1', 0.9, true),
      item('2', 0.5, false, 10),
      item('3', 0.5, true, 20),
      item('10', 0.5, false, 20),
      item('4', 0.1, true),
    ];
    // Order: 1, then the 0.5 ties newest first: (20: id 10 before id 3), then 2; then 4.
    expect(precisionAtK(items, 2)).toEqual({ k: 2, value: 0.5, denominator: 2, likes: 1 });
    expect(precisionAtK(items, 3)).toEqual({ k: 3, value: 2 / 3, denominator: 3, likes: 2 });
  });

  it('is null with the actual denominator when fewer than k ratings exist', () => {
    const result = precisionAtK([item('1', 0.9, true), item('2', 0.2, true)], 10);
    expect(result).toEqual({ k: 10, value: null, denominator: 2, likes: 2 });
  });
});

describe('calibration', () => {
  it('computes the ten-bin ECE, Brier and logloss', () => {
    const preds = [
      { p: 0.05, positive: false },
      { p: 0.15, positive: true },
      { p: 0.15, positive: false },
      { p: 0.95, positive: true },
    ];
    const result = calibration(preds);
    // Bin 0: |0.05 − 0|·¼; bin 1: |0.15 − 0.5|·½; bin 9: |0.95 − 1|·¼ → 0.2.
    expect(result.ece).toBeCloseTo(0.2, 12);
    expect(result.brier).toBeCloseTo((0.0025 + 0.7225 + 0.0225 + 0.0025) / 4, 12);
    expect(result.logloss).toBeCloseTo(
      -(Math.log(0.95) + Math.log(0.15) + Math.log(0.85) + Math.log(0.95)) / 4,
      12,
    );
    expect(result.prevalence).toBe(0.5);
    expect(result.bins).toHaveLength(10);
    expect(result.bins[1]).toMatchObject({ count: 2, meanScore: 0.15, positiveFraction: 0.5 });
    // Empty bins contribute zero and carry null means.
    expect(result.bins[5]).toMatchObject({ count: 0, meanScore: null, positiveFraction: null });
  });

  it('puts 1.0 in the last bin and clips only the logarithm', () => {
    expect(binIndex(1)).toBe(9);
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.1)).toBe(1);
    const result = calibration([{ p: 1, positive: false }]);
    expect(result.brier).toBe(1);
    expect(result.logloss).toBeCloseTo(-Math.log(1e-6), 9);
  });

  it('is null without predictions and rejects non-probabilities', () => {
    expect(calibration([]).ece).toBeNull();
    expect(() => calibration([{ p: 1.2, positive: true }])).toThrow(RangeError);
  });
});

describe('classification metrics', () => {
  it('computes accuracy and macro-F1 over the classes present', () => {
    const pairs = [
      { truth: 'a', predicted: 'a' },
      { truth: 'a', predicted: 'b' },
      { truth: 'b', predicted: 'b' },
      { truth: 'c', predicted: 'a' },
    ];
    expect(accuracy(pairs)).toBe(0.5);
    // a: P ½ R ½ F ½; b: P ½ R 1 F ⅔; c: F 0 → (½ + ⅔ + 0) / 3.
    expect(macroF1(pairs).value).toBeCloseTo((0.5 + 2 / 3) / 3, 12);
    expect(macroF1([]).value).toBeNull();
  });

  it('computes top-1 and top-2 accuracy', () => {
    const items = [
      { truth: 'tech', probabilities: { tech: 0.6, science: 0.3, sport: 0.1 } },
      { truth: 'science', probabilities: { tech: 0.6, science: 0.3, sport: 0.1 } },
      { truth: 'sport', probabilities: { tech: 0.6, science: 0.3, sport: 0.1 } },
    ];
    expect(topKAccuracy(items, 1)).toBeCloseTo(1 / 3, 12);
    expect(topKAccuracy(items, 2)).toBeCloseTo(2 / 3, 12);
  });

  it('computes the MAE', () => {
    expect(
      meanAbsoluteError([
        { truth: 0, predicted: 1 },
        { truth: 4, predicted: 2 },
      ]),
    ).toBe(1.5);
    expect(meanAbsoluteError([])).toBeNull();
  });

  it('computes precision and recall at a cutoff in both directions', () => {
    const samples = [
      { value: 0.9, positive: true },
      { value: 0.85, positive: false },
      { value: 0.8, positive: true },
      { value: 0.5, positive: true },
      { value: 0.3, positive: false },
    ];
    expect(precisionRecallAtCutoff(samples, 0.8, 'gte')).toEqual({
      cutoff: 0.8,
      direction: 'gte',
      flagged: 3,
      truePositives: 2,
      positives: 3,
      precision: 2 / 3,
      recall: 2 / 3,
    });
    const lte = precisionRecallAtCutoff(samples, 0.5, 'lte');
    expect([lte.flagged, lte.precision, lte.recall]).toEqual([2, 0.5, 1 / 3]);
    expect(precisionRecallAtCutoff(samples, 0.95, 'gte').precision).toBeNull();
    expect(precisionRecallAtCutoff([{ value: 1, positive: false }], 0.5, 'gte').recall).toBeNull();
  });
});

describe('Spearman ρ and Cohen κ', () => {
  it('uses average ranks for ties', () => {
    expect(averageRanks([5, 6, 7, 8, 7])).toEqual([1, 2, 3.5, 5, 3.5]);
    // Ranks [1..5] vs [1, 2, 3.5, 5, 3.5]: Sxy = 8, Sxx = 10, Syy = 9.5.
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(8 / Math.sqrt(95), 12);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1], [1])).toBeNull();
    expect(spearman([1, 2], [3, 3])).toBeNull();
  });

  it('computes unweighted κ for the textbook 2×2 table', () => {
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ a: 'y', b: 'y' })),
      ...Array.from({ length: 5 }, () => ({ a: 'y', b: 'n' })),
      ...Array.from({ length: 10 }, () => ({ a: 'n', b: 'y' })),
      ...Array.from({ length: 15 }, () => ({ a: 'n', b: 'n' })),
    ];
    // p_o = 0.7, p_e = 0.5·0.6 + 0.5·0.4 = 0.5 → κ = 0.4.
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 12);
  });

  it('computes quadratic weighted κ on an ordinal scale', () => {
    const pairs = [
      { a: '0', b: '0' },
      { a: '1', b: '1' },
      { a: '2', b: '2' },
      { a: '0', b: '1' },
      { a: '1', b: '2' },
      { a: '2', b: '0' },
    ];
    // Observed disagreement (0.25 + 0.25 + 1) / 6 = 0.25; expected = Σ d / 9 = 3 / 9.
    expect(cohenKappa(pairs, { weights: 'quadratic', categories: ['0', '1', '2'] })).toBeCloseTo(
      1 - 0.25 / (3 / 9),
      12,
    );
    expect(cohenKappa([])).toBeNull();
    expect(cohenKappa([{ a: 'y', b: 'y' }])).toBeNull();
  });
});

describe('isotonic regression (PAV)', () => {
  it('pools adjacent violators', () => {
    const blocks = isotonicRegression([
      { x: 1, y: 1 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
      { x: 4, y: 4 },
      { x: 5, y: 3.5 },
    ]);
    expect(blocks.map((b) => [b.xMin, b.xMax, b.value])).toEqual([
      [1, 1, 1],
      [2, 3, 2.5],
      [4, 5, 3.75],
    ]);
    expect(isotonicPredict(blocks, 3)).toBe(2.5);
    expect(isotonicPredict(blocks, 0)).toBe(1);
  });

  it('respects weights and pools equal scores first', () => {
    const blocks = isotonicRegression([
      { x: 0.1, y: 0 },
      { x: 0.2, y: 1 },
      { x: 0.3, y: 0, weight: 3 },
      { x: 0.4, y: 1 },
      { x: 0.4, y: 0 },
    ]);
    expect(blocks.map((b) => [b.xMin, b.xMax, b.value])).toEqual([
      [0.1, 0.1, 0],
      [0.2, 0.3, 0.25],
      [0.4, 0.4, 0.5],
    ]);
    expect(smallestScoreReaching(blocks, 0.2)).toBe(0.2);
    expect(smallestScoreReaching(blocks, 0.5)).toBe(0.4);
    expect(smallestScoreReaching(blocks, 0.6)).toBeNull();
  });
});

describe('lane distribution of liked and disliked items', () => {
  it('places each item in exactly one lane per class and summarizes the policy', () => {
    const items = [
      { liked: true, lane: 'for_you' as const },
      { liked: true, lane: 'everything' as const },
      { liked: true, lane: 'hidden' as const },
      { liked: true, lane: 'for_you' as const },
      { liked: false, lane: 'for_you' as const },
      { liked: false, lane: 'maybe' as const },
      { liked: false, lane: 'new' as const },
    ];
    const dist = laneDistribution(items);
    expect(dist.liked.n).toBe(4);
    expect(dist.liked.counts).toEqual({ for_you: 2, maybe: 0, everything: 1, hidden: 1, new: 0 });
    expect(dist.liked.shares.for_you).toBe(0.5);
    expect(dist.disliked.counts).toEqual({
      for_you: 1,
      maybe: 1,
      everything: 0,
      hidden: 0,
      new: 1,
    });
    const summary = policySummary(items);
    expect(summary.forYouPrecision).toBeCloseTo(2 / 3, 12);
    expect(summary.forYouCoverage).toBe(0.5);
    expect(summary.maybeShare).toBeCloseTo(1 / 7, 12);
    expect(summary.hardHideFalseNegativeRate).toBe(0.25);
    expect(summary.likedInEverything).toBe(0.25);
    expect(laneDistribution([]).liked.shares.for_you).toBeNull();
  });
});

describe('macro averages and pooling weights', () => {
  it('averages contexts inside a participant, then participants; nulls are left out', () => {
    const macro = participantMacro([
      { participantKey: 'owner', contextId: 'web', value: 0.9 },
      { participantKey: 'owner', contextId: 'cooking', value: 0.7 },
      { participantKey: 'owner', contextId: 'local', value: null },
      { participantKey: 'b', contextId: 'b1', value: 0.6 },
      { participantKey: 'c', contextId: 'c1', value: null },
    ]);
    expect(macro.value).toBeCloseTo((0.8 + 0.6) / 2, 12);
    expect(macro.participants).toBe(2);
    expect(macro.contexts).toBe(3);
    expect(
      participantMacro([{ participantKey: 'a', contextId: 'x', value: null }]).value,
    ).toBeNull();
  });

  it('gives each participant equal total weight whatever its persona count', () => {
    const items = [
      { participantKey: 'owner', contextId: 'web' },
      { participantKey: 'owner', contextId: 'web' },
      { participantKey: 'owner', contextId: 'cooking' },
      { participantKey: 'b', contextId: 'b1' },
    ];
    expect(hierarchicalWeights(items)).toEqual([0.25, 0.25, 0.5, 1]);
  });
});

describe('story-group bootstrap', () => {
  const groups = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
  const items = [
    { group: 'g1', score: 0.9, positive: true },
    { group: 'g1', score: 0.8, positive: true },
    { group: 'g2', score: 0.4, positive: false },
    { group: 'g3', score: 0.7, positive: true },
    { group: 'g4', score: 0.6, positive: false },
    { group: 'g5', score: 0.3, positive: true },
    { group: 'g6', score: 0.2, positive: false },
  ];
  const auc = (offset: number) => (weights: GroupWeights) =>
    rocAuc(
      items.map((item) => ({
        score: item.score + (item.positive ? offset : 0),
        positive: item.positive,
        weight: weights.get(item.group) ?? 0,
      })),
    );

  it('is deterministic for a seed and differs across seeds', () => {
    const a = groupBootstrap(groups, auc(0), { seed: 7, resamples: 200 });
    const b = groupBootstrap(groups, auc(0), { seed: 7, resamples: 200 });
    const c = groupBootstrap(groups, auc(0), { seed: 8, resamples: 200 });
    expect(a).toEqual(b);
    // Four likes, three dislikes: 0.9, 0.8 and 0.7 beat all three, 0.3 beats 0.2 → 10 / 12.
    expect(a.estimate).toBeCloseTo(10 / 12, 12);
    expect(a.lo).not.toBeNull();
    expect(a.lo! <= a.estimate! && a.estimate! <= a.hi!).toBe(true);
    expect([c.lo, c.hi]).not.toEqual([a.lo, a.hi]);
    // Single-class draws are dropped, never counted as 0 or 0.5.
    expect(a.valid).toBeLessThanOrEqual(200);
  });

  it('resamples whole groups: both items of g1 always share a weight', () => {
    const seen: number[][] = [];
    groupBootstrap(
      groups,
      (weights) => {
        seen.push([weights.get('g1') ?? 0]);
        return 1;
      },
      { seed: 's', resamples: 50 },
    );
    expect(seen).toHaveLength(51);
    expect(seen[0]).toEqual([1]);
  });

  it('pairs candidate and baseline on the same draws', () => {
    const paired = pairedGroupBootstrap(groups, auc(0.5), auc(0), { seed: 3, resamples: 300 });
    expect(paired.estimate).toBeCloseTo(1 - 10 / 12, 12);
    // Shifting liked items up can only help on every draw.
    expect(paired.lo!).toBeGreaterThanOrEqual(0);
    const same = pairedGroupBootstrap(groups, auc(0), auc(0), { seed: 3, resamples: 100 });
    expect([same.lo, same.hi]).toEqual([0, 0]);
  });
});
