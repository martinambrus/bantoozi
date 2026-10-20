import { auc } from '../learn/metrics.js';
import { fitPlatt, type PlattParams } from '../learn/platt.js';

import { estimateFeatures } from './features.js';
import { fitLogistic, pruneWeights, timeFold, type FitData, type FitParams } from './fit.js';
import { ESTIMATE_SPEC } from './spec.js';
import {
  DEFAULT_ESTIMATE_OPTIONS,
  type EstimateFeedMetrics,
  type EstimateOptions,
  type EstimateSample,
  type EstimateTrainResult,
} from './types.js';

/** Whether the ratings so far open the gate, and how many more are needed. */
export function estimateGate(
  counts: { n: number; nPos: number; nNeg: number },
  options: Partial<Pick<EstimateOptions, 'minRatings' | 'minEachClass'>> = {},
): { open: boolean; needed: number } {
  const minRatings = options.minRatings ?? DEFAULT_ESTIMATE_OPTIONS.minRatings;
  const minEachClass = options.minEachClass ?? DEFAULT_ESTIMATE_OPTIONS.minEachClass;
  const missing = Math.max(0, minEachClass - counts.nPos) + Math.max(0, minEachClass - counts.nNeg);
  const needed = Math.max(missing, minRatings - counts.n, 0);
  return { open: needed === 0, needed };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalOrder(samples: readonly EstimateSample[]): EstimateSample[] {
  return [...samples].sort(
    (a, b) =>
      a.ratedAt.getTime() - b.ratedAt.getTime() ||
      compare(a.articleId, b.articleId) ||
      a.rating - b.rating,
  );
}

function fitPruned(
  data: FitData,
  rows: Int32Array,
  params: FitParams,
  names: readonly string[],
  keep: number,
): { weights: Float64Array; bias: number } | null {
  const fit = fitLogistic(data, rows, params);
  if (fit !== null) pruneWeights(fit.weights, names, keep);
  return fit;
}

/** Trains the per-user word model on explicit ratings; closed below the gate. Pure and order-independent. */
export function trainEstimateModel(
  samples: readonly EstimateSample[],
  options: Partial<EstimateOptions> = {},
): EstimateTrainResult {
  const opts: EstimateOptions = { ...DEFAULT_ESTIMATE_OPTIONS, ...options };
  const n = samples.length;
  let nPos = 0;
  for (const sample of samples) if (sample.rating === 1) nPos += 1;
  const nNeg = n - nPos;
  if (!estimateGate({ n, nPos, nNeg }, opts).open) return { ok: false, reason: 'below_gate' };

  const ordered = canonicalOrder(samples);
  const ids = new Map<string, number>();
  const names: string[] = [];
  const features: Int32Array[] = [];
  const labels = new Uint8Array(n);
  ordered.forEach((sample, index) => {
    const feats = estimateFeatures(sample);
    const row = new Int32Array(feats.length);
    feats.forEach((name, k) => {
      let id = ids.get(name);
      if (id === undefined) {
        id = names.length;
        ids.set(name, id);
        names.push(name);
      }
      row[k] = id;
    });
    features.push(row);
    labels[index] = sample.rating === 1 ? 1 : 0;
  });
  const data: FitData = { features, labels, vocabSize: names.length };
  const params = (suffix: string): FitParams => ({
    epochs: opts.epochs,
    learningRate: opts.learningRate,
    l2: opts.l2,
    seed: `${opts.seed}|${suffix}`,
  });

  const all = new Int32Array(n);
  for (let i = 0; i < n; i += 1) all[i] = i;
  const full = fitPruned(data, all, params('full'), names, opts.maxWeights);
  if (full === null) return { ok: false, reason: 'below_gate' };

  const k = Math.min(opts.folds, n);
  const oofLogits: number[] = [];
  const oofLabels: number[] = [];
  const oofFeeds: (string | null)[] = [];
  let scoredFolds = 0;
  if (k >= 2) {
    const foldOf = new Int32Array(n);
    for (let i = 0; i < n; i += 1) foldOf[i] = timeFold(i, n, k);
    for (let f = 0; f < k; f += 1) {
      const train: number[] = [];
      const held: number[] = [];
      for (let i = 0; i < n; i += 1) (foldOf[i] === f ? held : train).push(i);
      const fit = fitPruned(
        data,
        Int32Array.from(train),
        params(`fold${f}`),
        names,
        opts.maxWeights,
      );
      if (fit === null) continue;
      scoredFolds += 1;
      for (const i of held) {
        let z = fit.bias;
        for (const id of features[i] as Int32Array) z += fit.weights[id] as number;
        oofLogits.push(z);
        oofLabels.push(labels[i] as number);
        oofFeeds.push((ordered[i] as EstimateSample).feedId);
      }
    }
  }

  const platt: PlattParams = oofLogits.length > 0 ? fitPlatt(oofLogits, oofLabels) : { a: 1, b: 0 };

  const byFeed = new Map<string, { logits: number[]; labels: number[] }>();
  oofFeeds.forEach((feed, i) => {
    if (feed === null) return;
    let entry = byFeed.get(feed);
    if (entry === undefined) {
      entry = { logits: [], labels: [] };
      byFeed.set(feed, entry);
    }
    entry.logits.push(oofLogits[i] as number);
    entry.labels.push(oofLabels[i] as number);
  });
  const feeds: Record<string, EstimateFeedMetrics> = {};
  for (const feed of [...byFeed.keys()].sort(compare)) {
    const entry = byFeed.get(feed) as { logits: number[]; labels: number[] };
    const feedPos = entry.labels.reduce((sum, label) => sum + label, 0);
    const feedN = entry.labels.length;
    if (feedN < opts.feedMetricMinRatings || feedPos === 0 || feedPos === feedN) continue;
    feeds[feed] = {
      n: feedN,
      nPos: feedPos,
      nNeg: feedN - feedPos,
      auc: auc(entry.logits, entry.labels),
    };
  }

  const weights: Record<string, number> = {};
  const nonZero: number[] = [];
  for (let i = 0; i < names.length; i += 1) if (full.weights[i] !== 0) nonZero.push(i);
  nonZero.sort((a, b) => compare(names[a] as string, names[b] as string));
  for (const id of nonZero) weights[names[id] as string] = full.weights[id] as number;

  return {
    ok: true,
    model: {
      spec: ESTIMATE_SPEC,
      intercept: full.bias,
      weights,
      platt,
      metrics: {
        n,
        nPos,
        nNeg,
        folds: scoredFolds,
        auc: auc(oofLogits, oofLabels),
        feeds,
      },
    },
  };
}
