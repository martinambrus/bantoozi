import { canonicalSha256 } from '@bantoozi/shared/server';

import { ESTIMATE_SPEC } from './spec.js';
import { DEFAULT_ESTIMATE_OPTIONS, type EstimateOptions, type EstimateSample } from './types.js';

/**
 * What a trained word model depends on, as one hash: `ESTIMATE_SPEC`, the effective trainer options
 * and the samples (article, rating, rating time, carrier feed, title and excerpt), in any order. Equal
 * hashes give byte-equal models (the trainer is deterministic), so `user.estimate` skips training when
 * the newest stored model carries the hash of the current inputs.
 */
export function estimateInputSha(
  samples: readonly EstimateSample[],
  options: Partial<EstimateOptions> = {},
): string {
  const effective = { ...DEFAULT_ESTIMATE_OPTIONS, ...options };
  const rows = samples
    .map((s) => [s.articleId, s.rating, s.ratedAt.getTime(), s.feedId, s.title, s.excerpt] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]));
  return canonicalSha256({ spec: ESTIMATE_SPEC, options: effective, samples: rows });
}
