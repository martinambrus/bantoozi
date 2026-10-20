import { applyPlatt } from '../learn/platt.js';

import { ESTIMATE_SPEC } from './spec.js';
import type { EstimateModel } from './types.js';

/** The model's logit and calibrated probability for an article's features; null for another spec. */
export function scoreEstimate(
  model: EstimateModel,
  features: readonly string[],
): { logit: number; p: number } | null {
  if (model.spec !== ESTIMATE_SPEC) return null;
  let logit = model.intercept;
  for (const feature of features) {
    if (Object.hasOwn(model.weights, feature)) logit += model.weights[feature] as number;
  }
  return { logit, p: applyPlatt(model.platt, logit) };
}
