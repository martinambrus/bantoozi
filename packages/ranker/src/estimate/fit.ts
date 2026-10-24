import { murmur3 } from '../learn/murmur3.js';

export interface FitData {
  features: readonly Int32Array[];
  labels: Uint8Array;
  /** The murmur3 of each row's article id; a row keeps its place among the others in every epoch. */
  keys: Uint32Array;
  vocabSize: number;
}

export interface FitParams {
  epochs: number;
  learningRate: number;
  l2: number;
  /** Seeds each epoch's visiting order. */
  seed: string;
}

const ACCUMULATOR_START = 1e-8;

const EPOCH_STEP = 0x9e3779b9;
const MAX_KEY_BITS = 32;
const SAFE_INTEGER_BITS = 53;

/** The 32-bit finalizer of MurmurHash3: a bijection that mixes every input bit into every output bit. */
function mix32(input: number): number {
  let h = input | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The order in which a fit visits `rows` in `epoch`: ascending by a hash of (seed, epoch, row key), ties by position in `rows`.
 * A row's place relative to another depends on those two rows only, so removing or adding one row leaves the order of all the
 * others unchanged and a retrain follows the same path except for that row (a Fisher-Yates over n reorders every row).
 */
export function epochOrder(
  keys: Uint32Array,
  rows: Int32Array,
  seed: string,
  epoch: number,
): Int32Array {
  const n = rows.length;
  const salt = mix32(murmur3(seed) + Math.imul(epoch + 1, EPOCH_STEP));
  const indexBits = Math.max(1, Math.ceil(Math.log2(n + 1)));
  const keyShift = MAX_KEY_BITS - Math.min(MAX_KEY_BITS, SAFE_INTEGER_BITS - indexBits);
  const scale = 2 ** indexBits;
  const packed = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    packed[k] = (mix32((keys[rows[k] as number] as number) ^ salt) >>> keyShift) * scale + k;
  }
  packed.sort();
  const order = new Int32Array(n);
  for (let k = 0; k < n; k += 1) {
    const value = packed[k] as number;
    order[k] = rows[value - Math.floor(value / scale) * scale] as number;
  }
  return order;
}

/** How many of `rows` contain each feature. */
export function featureSupport(
  data: Pick<FitData, 'features' | 'vocabSize'>,
  rows: Int32Array,
): Int32Array {
  const support = new Int32Array(data.vocabSize);
  for (let k = 0; k < rows.length; k += 1) {
    const feats = data.features[rows[k] as number] as Int32Array;
    for (let f = 0; f < feats.length; f += 1) {
      const id = feats[f] as number;
      support[id] = (support[id] as number) + 1;
    }
  }
  return support;
}

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
  let bias = 0;
  let biasSum = ACCUMULATOR_START;
  for (let epoch = 0; epoch < params.epochs; epoch += 1) {
    const order = epochOrder(data.keys, rows, params.seed, epoch);
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

/**
 * Zeroes all but the `keep` weights with the largest contribution `|w| * sqrt(support)`: the root-mean-square effect of the weight on the
 * logits of the rows it was trained on. Ranking by |w| alone leaves the cut to a coin flip among thousands of near-equal weights, common words
 * included, which a retrain would swap at every run.
 */
export function pruneWeights(
  weights: Float64Array,
  names: readonly string[],
  keep: number,
  support: ArrayLike<number>,
): void {
  const scores = new Float64Array(weights.length);
  const live: number[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] as number;
    if (w === 0) continue;
    scores[i] = Math.abs(w) * Math.sqrt(support[i] as number);
    live.push(scores[i] as number);
  }
  if (live.length <= keep) return;
  if (keep <= 0) {
    weights.fill(0);
    return;
  }
  const threshold = Float64Array.from(live).sort()[live.length - keep] as number;
  let above = 0;
  const tied: number[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    if (weights[i] === 0) continue;
    const score = scores[i] as number;
    if (score > threshold) above += 1;
    else if (score === threshold) tied.push(i);
    else weights[i] = 0;
  }
  tied.sort((a, b) => ((names[a] as string) < (names[b] as string) ? -1 : 1));
  for (let t = keep - above; t < tied.length; t += 1) weights[tied[t] as number] = 0;
}

/** The contiguous time block of the sample at `index` among `n` split into `k`. */
export function timeFold(index: number, n: number, k: number): number {
  return Math.floor((index * k) / n);
}
