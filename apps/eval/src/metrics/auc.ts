/**
 * ROC AUC as the Mann–Whitney statistic (spec 10 §4): the probability that a randomly chosen liked
 * item scores above a randomly chosen disliked one, ties counted as ½. Weights are multiplicities
 * (a story group drawn twice by the bootstrap counts twice), so one pass over the sorted scores
 * serves both the point estimate and every resample.
 */
export interface ScoredLabel {
  score: number;
  positive: boolean;
  /** Multiplicity; default 1. Zero-weight items are ignored. */
  weight?: number;
}

export interface MannWhitney {
  /** U of the positive class: Σ over (pos, neg) pairs of 1 if pos > neg, ½ if tied. */
  u: number;
  positives: number;
  negatives: number;
}

/** Mann–Whitney U of the positive class, with total positive and negative weight. */
export function mannWhitneyU(items: readonly ScoredLabel[]): MannWhitney {
  const sorted = items
    .filter((item) => (item.weight ?? 1) > 0)
    .map((item) => {
      if (!Number.isFinite(item.score)) throw new RangeError('scores must be finite');
      return item;
    })
    .sort((a, b) => a.score - b.score);
  let u = 0;
  let negBelow = 0;
  let positives = 0;
  let negatives = 0;
  let i = 0;
  while (i < sorted.length) {
    const score = sorted[i]?.score;
    let pos = 0;
    let neg = 0;
    while (i < sorted.length && sorted[i]?.score === score) {
      const item = sorted[i];
      const w = item?.weight ?? 1;
      if (item?.positive === true) pos += w;
      else neg += w;
      i += 1;
    }
    u += pos * (negBelow + neg / 2);
    negBelow += neg;
    positives += pos;
    negatives += neg;
  }
  return { u, positives, negatives };
}

/**
 * ROC AUC, or `null` when a class is missing: a single-class AUC is undefined and is never averaged
 * as 0 or 0.5 (spec 10 §4).
 */
export function rocAuc(items: readonly ScoredLabel[]): number | null {
  const { u, positives, negatives } = mannWhitneyU(items);
  if (positives <= 0 || negatives <= 0) return null;
  return u / (positives * negatives);
}
