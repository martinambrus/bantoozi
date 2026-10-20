import { canonicalSha256 } from '@bantoozi/shared/server';

import { SIMILAR_DISLIKES } from '../similar-dislikes.js';

/** Excerpt tokens that become features; later ones are ignored. */
export const ESTIMATE_EXCERPT_TOKENS = 80;

/**
 * What a stored word model depends on: the feature definition and the scoring formula, never the
 * trainer's settings. Changing any value (the stemming is D-268's, shared with the similar-dislikes
 * check) changes `ESTIMATE_SPEC`, so every stored model is rebuilt before it is scored again.
 */
export const ESTIMATE_SPEC_DESCRIPTOR = {
  name: 'ESTIMATE_SPEC_V1',
  title: { tokens: 'similarityTokens', pairs: 'adjacent', prefix: 't:', pairPrefix: 'b:' },
  excerpt: { tokens: 'tokenize+stem', first: ESTIMATE_EXCERPT_TOKENS, prefix: 'e:' },
  stem: { from: SIMILAR_DISLIKES.stemFrom, length: SIMILAR_DISLIKES.stemLength },
  feed: { prefix: 'f:' },
  values: 'binary',
  score: 'intercept+sum(weights),platt',
} as const;

/** The string stored with every word model and compared before it scores (spec above). */
export const ESTIMATE_SPEC: string = `estimate-v1:${canonicalSha256(ESTIMATE_SPEC_DESCRIPTOR).slice(0, 16)}`;
