import { seededRandom } from '../learn/random.js';

export interface FitData {
  features: readonly Int32Array[];
  labels: Uint8Array;
  vocabSize: number;
}

export interface FitParams {
  epochs: number;
  learningRate: number;
  l2: number;
  seed: string;
}

const ACCUMULATOR_START = 1e-8;

/** Weighted-class logistic regression by Adagrad on the given rows; null when a class is missing. */
export function fitLogistic(
  data: FitData,
  rows: Int32Array,
  params: FitParams,
): { weights: Float64Array; bias: number } | null {
  const n = rows.length;
  let n1 = 0;
  for (let i = 0; i < n; i += 1) n1 += data.labels[rows[i] as number] as number;
  const n0 = n - n1;
  if (n0 === 0 || n1 === 0) return null;
  const classWeight = [n / (2 * n0), n / (2 * n1)];
  const weights = new Float64Array(data.vocabSize);
  const sums = new Float64Array(data.vocabSize).fill(ACCUMULATOR_START);
  const order = Int32Array.from(rows);
  const random = seededRandom(params.seed);
  let bias = 0;
  let biasSum = ACCUMULATOR_START;
  for (let epoch = 0; epoch < params.epochs; epoch += 1) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = order[i] as number;
      order[i] = order[j] as number;
      order[j] = swap;
    }
    for (let k = 0; k < n; k += 1) {
      const row = order[k] as number;
      const feats = data.features[row] as Int32Array;
      const label = data.labels[row] as number;
      let z = bias;
      for (let f = 0; f < feats.length; f += 1) z += weights[feats[f] as number] as number;
      const p = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const grad = (p - label) * (classWeight[label] as number);
      biasSum += grad * grad;
      bias -= (params.learningRate / Math.sqrt(biasSum)) * grad;
      for (let f = 0; f < feats.length; f += 1) {
        const id = feats[f] as number;
        const w = weights[id] as number;
        const g = grad + params.l2 * w;
        const acc = (sums[id] as number) + g * g;
        sums[id] = acc;
        weights[id] = w - (params.learningRate / Math.sqrt(acc)) * g;
      }
    }
  }
  return { weights, bias };
}

/** Zeroes all but the `keep` largest absolute weights; ties at the cut keep the smaller names. */
export function pruneWeights(weights: Float64Array, names: readonly string[], keep: number): void {
  const magnitudes: number[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] as number;
    if (w !== 0) magnitudes.push(Math.abs(w));
  }
  if (magnitudes.length <= keep) return;
  if (keep <= 0) {
    weights.fill(0);
    return;
  }
  const sorted = Float64Array.from(magnitudes).sort();
  const threshold = sorted[sorted.length - keep] as number;
  let above = 0;
  const tied: number[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    const m = Math.abs(weights[i] as number);
    if (m > threshold) above += 1;
    else if (m === threshold && m !== 0) tied.push(i);
    else weights[i] = 0;
  }
  tied.sort((a, b) => ((names[a] as string) < (names[b] as string) ? -1 : 1));
  for (let t = keep - above; t < tied.length; t += 1) weights[tied[t] as number] = 0;
}

/** The contiguous time block of the sample at `index` among `n` split into `k`. */
export function timeFold(index: number, n: number, k: number): number {
  return Math.floor((index * k) / n);
}
