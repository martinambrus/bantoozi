/**
 * Calibration of the heuristic card score against the like-rate (spec 10 §4): ten fixed-width bins
 * on [0, 1] with each bin's count, mean score and positive fraction; ECE = Σ (n_bin / N) ·
 * |meanScore − positiveFraction| (empty bins contribute zero), the Brier score and the logloss, with
 * only the logarithm's argument clipped to [1e-6, 1 − 1e-6]. Weights generalize the counts so the
 * gate can weight participants equally (spec 10 §5 step 4).
 */
export interface Prediction {
  p: number;
  positive: boolean;
  weight?: number;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  /** Number of items (unweighted). */
  count: number;
  /** Total weight (equals `count` when unweighted). */
  weight: number;
  /** `null` for an empty bin. */
  meanScore: number | null;
  positiveFraction: number | null;
}

export interface Calibration {
  bins: ReliabilityBin[];
  n: number;
  /** `null` when there are no predictions. */
  ece: number | null;
  brier: number | null;
  logloss: number | null;
  prevalence: number | null;
}

export const LOG_CLIP = 1e-6;

function checkProbability(p: number): void {
  if (!(p >= 0 && p <= 1)) throw new RangeError('p must be a probability in [0, 1]');
}

/** The bin of `p` among `bins` fixed-width bins; 1.0 belongs to the last bin. */
export function binIndex(p: number, bins = 10): number {
  checkProbability(p);
  return Math.min(Math.floor(p * bins), bins - 1);
}

export function calibration(predictions: readonly Prediction[], binCount = 10): Calibration {
  const sums = Array.from({ length: binCount }, () => ({ count: 0, w: 0, p: 0, pos: 0 }));
  let total = 0;
  let brier = 0;
  let logloss = 0;
  let positives = 0;
  for (const { p, positive, weight = 1 } of predictions) {
    if (weight <= 0) continue;
    const bin = sums[binIndex(p, binCount)];
    if (bin === undefined) continue;
    const y = positive ? 1 : 0;
    bin.count += 1;
    bin.w += weight;
    bin.p += weight * p;
    bin.pos += weight * y;
    total += weight;
    positives += weight * y;
    brier += weight * (p - y) ** 2;
    const clipped = Math.min(Math.max(p, LOG_CLIP), 1 - LOG_CLIP);
    logloss -= weight * (y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
  }
  const bins: ReliabilityBin[] = sums.map((bin, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    count: bin.count,
    weight: bin.w,
    meanScore: bin.w > 0 ? bin.p / bin.w : null,
    positiveFraction: bin.w > 0 ? bin.pos / bin.w : null,
  }));
  if (total <= 0) {
    return { bins, n: 0, ece: null, brier: null, logloss: null, prevalence: null };
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.meanScore === null || bin.positiveFraction === null) continue;
    ece += (bin.weight / total) * Math.abs(bin.meanScore - bin.positiveFraction);
  }
  return {
    bins,
    n: bins.reduce((sum, bin) => sum + bin.count, 0),
    ece,
    brier: brier / total,
    logloss: logloss / total,
    prevalence: positives / total,
  };
}
