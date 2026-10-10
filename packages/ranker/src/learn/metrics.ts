const LOG_CLIP = 1e-6;

/** Logistic function, stable for large |z|. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Weighted mean negative log-likelihood with `p` clipped to [1e-6, 1 − 1e-6] (spec 06 §8.3). */
export function logLoss(p: readonly number[], y: readonly number[], w?: readonly number[]): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < p.length; i += 1) {
    const wi = w?.[i] ?? 1;
    const c = Math.min(Math.max(p[i] ?? 0, LOG_CLIP), 1 - LOG_CLIP);
    sum -= wi * ((y[i] ?? 0) * Math.log(c) + (1 - (y[i] ?? 0)) * Math.log(1 - c));
    total += wi;
  }
  return total > 0 ? sum / total : 0;
}

/** Weighted Mann-Whitney AUC, ties count one half; `null` when a class is empty (spec 06 §8.3). */
export function auc(
  scores: readonly number[],
  labels: readonly number[],
  weights?: readonly number[],
): number | null {
  const idx = Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => (scores[a] ?? 0) - (scores[b] ?? 0),
  );
  let negBelow = 0;
  let negTotal = 0;
  let posTotal = 0;
  let wins = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    const s = scores[idx[i] ?? 0];
    let pos = 0;
    let neg = 0;
    while (j < idx.length && scores[idx[j] ?? 0] === s) {
      const k = idx[j] ?? 0;
      const w = weights?.[k] ?? 1;
      if ((labels[k] ?? 0) > 0) pos += w;
      else neg += w;
      j += 1;
    }
    wins += pos * (negBelow + 0.5 * neg);
    negBelow += neg;
    negTotal += neg;
    posTotal += pos;
    i = j;
  }
  if (posTotal <= 0 || negTotal <= 0) return null;
  return wins / (posTotal * negTotal);
}

/** Expected calibration error over equal-width bins, the last inclusive of 1.0 (spec 06 §8.3). */
export function ece(p: readonly number[], y: readonly number[], bins = 10): number {
  const count = new Array<number>(bins).fill(0);
  const sumP = new Array<number>(bins).fill(0);
  const sumY = new Array<number>(bins).fill(0);
  for (let i = 0; i < p.length; i += 1) {
    const pi = p[i] ?? 0;
    const b = Math.min(Math.max(Math.floor(pi * bins), 0), bins - 1);
    count[b] = (count[b] ?? 0) + 1;
    sumP[b] = (sumP[b] ?? 0) + pi;
    sumY[b] = (sumY[b] ?? 0) + (y[i] ?? 0);
  }
  if (p.length === 0) return 0;
  let total = 0;
  for (let b = 0; b < bins; b += 1) {
    const n = count[b] ?? 0;
    if (n > 0) total += (n / p.length) * Math.abs((sumP[b] ?? 0) / n - (sumY[b] ?? 0) / n);
  }
  return total;
}
