import type { ActiveEstimate } from '../rank.js';

import { explainEstimate } from './explain.js';
import { ESTIMATE_SPEC } from './spec.js';
import type { EstimateModel } from './types.js';

/**
 * The reader's word model as `rankArticle` uses it: null for a model of another `ESTIMATE_SPEC`.
 * `score(item)` maps a `RankItem` to the article the model was trained on (raw title, normalized
 * excerpt, lowest-id subscribed carrier feed) in this one place.
 */
export function activeEstimate(input: {
  version: number;
  model: EstimateModel;
}): ActiveEstimate | null {
  const { version, model } = input;
  if (model.spec !== ESTIMATE_SPEC) return null;
  return {
    version,
    score: (item) => {
      const explained = explainEstimate(model, {
        title: item.title ?? null,
        excerpt: item.excerptNorm,
        feedId: item.feedIds[0] ?? null,
      });
      return explained === null ? null : { p: explained.p, top: explained.top };
    },
  };
}
