/**
 * Enrichment accuracy against facet labels (spec 10 §4): accuracy and macro-F1 for
 * `content_type`, top-k accuracy for `topic_l1`, MAE for `depth`, and precision/recall of a
 * demotion flag at a cutoff. Callers drop uncertain/not-applicable labels before calling.
 */
export interface LabelPair {
  truth: string;
  predicted: string;
}

export function accuracy(pairs: readonly LabelPair[]): number | null {
  if (pairs.length === 0) return null;
  return pairs.filter((pair) => pair.truth === pair.predicted).length / pairs.length;
}

export interface ClassF1 {
  label: string;
  support: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Macro-F1 over the classes present in the labels or predictions (an undefined precision or recall
 * counts as 0, as does the F1 of a class never predicted correctly). `null` without pairs.
 */
export function macroF1(pairs: readonly LabelPair[]): { value: number | null; classes: ClassF1[] } {
  if (pairs.length === 0) return { value: null, classes: [] };
  const labels = [...new Set(pairs.flatMap((pair) => [pair.truth, pair.predicted]))].sort();
  const classes = labels.map((label) => {
    const tp = pairs.filter((x) => x.truth === label && x.predicted === label).length;
    const predicted = pairs.filter((x) => x.predicted === label).length;
    const support = pairs.filter((x) => x.truth === label).length;
    const precision = predicted === 0 ? 0 : tp / predicted;
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, support, precision, recall, f1 };
  });
  return { value: classes.reduce((sum, c) => sum + c.f1, 0) / classes.length, classes };
}

/** Whether the truth is among the `k` most probable options (ties broken by option name). */
export function topKAccuracy(
  items: readonly { truth: string; probabilities: Readonly<Record<string, number>> }[],
  k: number,
): number | null {
  if (items.length === 0) return null;
  let hits = 0;
  for (const item of items) {
    const top = Object.entries(item.probabilities)
      .filter(([, p]) => Number.isFinite(p))
      .sort(([a, pa], [b, pb]) => pb - pa || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, k)
      .map(([option]) => option);
    if (top.includes(item.truth)) hits += 1;
  }
  return hits / items.length;
}

export function meanAbsoluteError(
  pairs: readonly { truth: number; predicted: number }[],
): number | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((sum, pair) => sum + Math.abs(pair.truth - pair.predicted), 0) / pairs.length;
}

/** A facet value and whether its label is the flagged class (*yes*, or depth ≤ 1). */
export interface FlagSample {
  value: number;
  positive: boolean;
}

export interface CutoffResult {
  cutoff: number;
  direction: 'gte' | 'lte';
  /** Items the cutoff flags. */
  flagged: number;
  truePositives: number;
  /** Items labelled positive. */
  positives: number;
  /** `null` when nothing is flagged. */
  precision: number | null;
  /** `null` when nothing is labelled positive. */
  recall: number | null;
}

/**
 * Precision and recall of a flag at a cutoff (spec 10 §4): `gte` flags `value ≥ cutoff`
 * (clickbait, promotional, time_sensitive), `lte` flags `value ≤ cutoff` (shallow depth).
 */
export function precisionRecallAtCutoff(
  samples: readonly FlagSample[],
  cutoff: number,
  direction: 'gte' | 'lte',
): CutoffResult {
  let flagged = 0;
  let truePositives = 0;
  let positives = 0;
  for (const sample of samples) {
    const isFlagged = direction === 'gte' ? sample.value >= cutoff : sample.value <= cutoff;
    if (sample.positive) positives += 1;
    if (!isFlagged) continue;
    flagged += 1;
    if (sample.positive) truePositives += 1;
  }
  return {
    cutoff,
    direction,
    flagged,
    truePositives,
    positives,
    precision: flagged === 0 ? null : truePositives / flagged,
    recall: positives === 0 ? null : truePositives / positives,
  };
}
