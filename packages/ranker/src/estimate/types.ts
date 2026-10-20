import type { PlattParams } from '../learn/platt.js';

/** What a word estimate reads of one article (`ESTIMATE_SPEC`). */
export interface EstimateArticle {
  title: string | null;
  excerpt: string | null;
  /** The article's lowest-id subscribed carrier feed; null adds no feed feature. */
  feedId: string | null;
}

/** One explicit rating of the reader, the training unit. */
export interface EstimateSample extends EstimateArticle {
  articleId: string;
  rating: 1 | -1;
  ratedAt: Date;
}

/** Trainer settings. Only `minRatings` and `minEachClass` are meant to reach `RankerConfig`. */
export interface EstimateOptions {
  /** The gate: at least this many explicit ratings. */
  minRatings: number;
  /** The gate: at least this many of each class. */
  minEachClass: number;
  /** Adagrad passes over the shuffled samples. */
  epochs: number;
  learningRate: number;
  /** L2 strength, applied to the weights an example touches. */
  l2: number;
  /** Out-of-fold folds, contiguous in time order. */
  folds: number;
  /** The largest absolute weights that are kept. */
  maxWeights: number;
  /** A feed gets metrics from this many scored ratings, both classes present. */
  feedMetricMinRatings: number;
  /** Seeds the example order of every fit. */
  seed: string;
}

export const DEFAULT_ESTIMATE_OPTIONS: Readonly<EstimateOptions> = {
  minRatings: 10,
  minEachClass: 3,
  epochs: 8,
  learningRate: 0.3,
  l2: 1e-4,
  folds: 5,
  maxWeights: 20_000,
  feedMetricMinRatings: 10,
  seed: 'estimate-v1',
};

export interface EstimateFeedMetrics {
  /** Scored ratings of the feed, and their classes. */
  n: number;
  nPos: number;
  nNeg: number;
  /** Out-of-fold AUC of the feed's ratings; null when undefined. */
  auc: number | null;
}

export interface EstimateMetrics {
  /** All ratings the model was trained on, and their classes. */
  n: number;
  nPos: number;
  nNeg: number;
  /** Folds that produced out-of-fold scores (0: none, Platt is the identity). */
  folds: number;
  /** Pooled out-of-fold AUC; null when undefined. */
  auc: number | null;
  /** Feeds with `feedMetricMinRatings` scored ratings and both classes, by feed id. */
  feeds: Record<string, EstimateFeedMetrics>;
}

/** A trained word model. Plain JSON: it is stored as `weights`, `intercept`, `platt`, `metrics`. */
export interface EstimateModel {
  /** `ESTIMATE_SPEC` at training time; a model of another spec is never scored. */
  spec: string;
  intercept: number;
  /** Binary-feature weights by feature name (`t:`, `b:`, `e:`, `f:` prefixes), keys sorted. */
  weights: Record<string, number>;
  platt: PlattParams;
  metrics: EstimateMetrics;
}

export type EstimateTrainResult =
  { ok: true; model: EstimateModel } | { ok: false; reason: 'below_gate' };
