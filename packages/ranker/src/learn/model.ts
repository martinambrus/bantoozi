import { compareBigIntStrings, type Strength } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';

import type { ReadonlyRankerConfig } from '../config.js';
import { applyPlatt, type PlattParams } from './platt.js';

export interface Consent {
  implicitFeedback: boolean;
  implicitNegative: boolean;
}

export interface HeldCard {
  cardId: string;
  strength: Strength;
  scopeFeedId: string | null;
  cardInputSha256: string;
}

export interface ContextInput {
  ratingSha: string;
  featureSpecSha: string;
  strengthWeights: ReadonlyRankerConfig['strengthWeights'];
  modelConfig: ReadonlyRankerConfig['model'];
  consent: Consent;
  ownInputs: readonly {
    cardId: string;
    strength: string;
    scopeFeedId: string | null;
    cardInputSha256: string;
  }[];
}

/** A trained personal model with named inputs, its scaler, calibrator and manifest (spec 06 §8.1, §8.3). */
export interface StoredModel {
  features: string[];
  weights: number[];
  scaler: { mean: number[]; scale: number[] };
  intercept: number;
  platt: PlattParams;
  featureSpecSha: string;
  lambda: number;
  ownInputs: string[];
  contextSha: string | null;
  ratingSha: string | null;
  feedbackCutoffEventId: string | null;
  dropped: string[];
}

/**
 * The model context sha (spec 06 §8.1): the rating fingerprint, feature spec, strength weights and
 * model config, both consent flags and each own input's id, strength, scope and card hash.
 */
export function modelContextSha(input: ContextInput): string {
  return canonicalSha256({
    ratingSha: input.ratingSha,
    featureSpecSha: input.featureSpecSha,
    strengthWeights: input.strengthWeights,
    model: input.modelConfig,
    consent: {
      implicitFeedback: input.consent.implicitFeedback,
      implicitNegative: input.consent.implicitNegative,
    },
    ownInputs: input.ownInputs
      .map((o) => ({
        cardId: o.cardId,
        strength: o.strength,
        scopeFeedId: o.scopeFeedId,
        cardInputSha256: o.cardInputSha256,
      }))
      .sort((a, b) => compareBigIntStrings(a.cardId, b.cardId)),
  });
}

/**
 * Scores a feature vector (spec 06 §8.3): `z = intercept + Σ wᵢ·(xᵢ − meanᵢ)/scaleᵢ`, `p` through the
 * Platt calibrator, and the top 3 contributions `a·wᵢ·x_scaledᵢ` by magnitude (ties by feature
 * name). `null` when a stored feature is missing from `x`.
 */
export function scoreModel(
  model: Pick<StoredModel, 'features' | 'weights' | 'scaler' | 'intercept' | 'platt'>,
  x: Readonly<Record<string, number>>,
): { logit: number; p: number; contributions: { feature: string; contribution: number }[] } | null {
  let logit = model.intercept;
  const all: { feature: string; contribution: number }[] = [];
  for (let i = 0; i < model.features.length; i += 1) {
    const feature = model.features[i] ?? '';
    const value: unknown = Object.hasOwn(x, feature) ? x[feature] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scaled = (value - (model.scaler.mean[i] ?? 0)) / (model.scaler.scale[i] ?? 1);
    const w = model.weights[i] ?? 0;
    logit += w * scaled;
    all.push({ feature, contribution: model.platt.a * w * scaled });
  }
  all.sort(
    (p, q) =>
      Math.abs(q.contribution) - Math.abs(p.contribution) ||
      (p.feature < q.feature ? -1 : p.feature > q.feature ? 1 : 0),
  );
  return { logit, p: applyPlatt(model.platt, logit), contributions: all.slice(0, 3) };
}
