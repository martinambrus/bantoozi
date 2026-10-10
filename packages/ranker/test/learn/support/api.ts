import * as ranker from '../../../src/index.js';
import type { RawFeatureSnapshot, ReadonlyRankerConfig as RankerConfig } from '../../../src/index.js';

/**
 * The M7-T3b contract, declared test-locally so this file typechecks and lints before the
 * implementation exists. The ranker namespace is cast to it; a missing export is `undefined` and
 * fails the calling test (never the runner).
 */
export interface TrainingSample {
  articleId: string;
  eventId?: string;
  signal?: string;
  y: 0 | 1;
  weight: number;
  explicit: boolean;
  feedbackAt: Date;
  groupId: string;
  features: RawFeatureSnapshot | null;
}

export type EligibilityReason =
  | 'missing_snapshot'
  | 'spec_sha_mismatch'
  | 'rating_sha_mismatch'
  | 'too_old'
  | 'no_facets'
  | 'invalid_facets'
  | 'foreign_engine'
  | 'incomplete_coverage'
  | 'no_positive_cards';

export interface EligibilityOpts {
  now: Date;
  historyDays: number;
  ratingSha: string | null;
}

export interface Consent {
  implicitFeedback: boolean;
  implicitNegative: boolean;
}

export interface HeldCard {
  cardId: string;
  strength: 'must' | 'love' | 'like' | 'never';
  scopeFeedId: string | null;
  cardInputSha256: string;
}

export interface ContextInput {
  ratingSha: string;
  featureSpecSha: string;
  strengthWeights: RankerConfig['strengthWeights'];
  modelConfig: RankerConfig['model'];
  consent: Consent;
  ownInputs: { cardId: string; strength: string; scopeFeedId: string | null; cardInputSha256: string }[];
}

/**
 * Assumed minimal stored-model shape, used only by test 14 (hand-built model) and the weight
 * helper. If the implementation names these differently, adjust this one interface and `weightOf`.
 */
export interface StoredModel {
  features: string[];
  weights: number[];
  scaler: { mean: number[]; scale: number[] };
  intercept: number;
  platt: { a: number; b: number };
  [extra: string]: unknown;
}

export interface TrainArgs {
  samples: TrainingSample[];
  now: Date;
  config: RankerConfig;
  heldCards: HeldCard[];
  ratingSha: string | null;
  consent: Consent;
  seedMaterial: string;
  feedbackCutoffEventId: string | null;
}

export interface TrainMetrics {
  skipped: Record<string, number>;
  nExplicit: number;
  nPos: number;
  nNeg: number;
  k: number | null;
  lambda: number | null;
  ownInputs: string[];
  cvAuc: number | null;
  cvLogloss: number | null;
  baselineAuc: number | null;
  baselineLogloss: number | null;
  research: boolean;
  contextSha: string | null;
}

export interface TrainResult {
  model: StoredModel | null;
  metrics: TrainMetrics;
  activation: { eligible: boolean; reasons: string[] };
}

export interface Api {
  sampleEligibility(
    s: TrainingSample,
    opts: EligibilityOpts,
  ): { ok: true } | { ok: false; reason: EligibilityReason };
  eligibleSetSha(samples: TrainingSample[], opts: EligibilityOpts): string;
  ownInputs(samples: TrainingSample[], heldCards: HeldCard[], cfg: RankerConfig): string[];
  groupFolds(samples: TrainingSample[], k: number, seed: string): number[];
  chooseLambda(lossByLambda: { lambda: number; loss: number }[]): number;
  modelContextSha(input: ContextInput): string;
  trainUserModel(args: TrainArgs, opts: { mode: 'production' | 'research' }): TrainResult;
  decideActivation(
    candidate: TrainResult,
    current: { currentRatingSha: string; currentContextSha: string },
  ): { activate: boolean; reasons: string[] };
  scoreModel(
    model: StoredModel,
    x: Record<string, number>,
  ): {
    logit: number;
    p: number;
    contributions: { feature: string; contribution: number }[];
  } | null;
}

export const api = ranker as unknown as Api;

/** Weight of a named feature in the stored model (0 when dropped). */
export function weightOf(model: StoredModel, name: string): number {
  const i = model.features.indexOf(name);
  return i < 0 ? 0 : (model.weights[i] ?? 0);
}
