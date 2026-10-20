import { tokenize } from '../bm25/tokenize.js';
import { similarityTokens, stemToken } from '../similar-dislikes.js';

import { ESTIMATE_EXCERPT_TOKENS } from './spec.js';
import type { EstimateArticle } from './types.js';

/** The distinct binary features of an article, in first-seen order (`ESTIMATE_SPEC`). */
export function estimateFeatures(article: EstimateArticle): string[] {
  const out = new Set<string>();
  const title = similarityTokens(article.title);
  for (const token of title) out.add(`t:${token}`);
  for (let i = 0; i + 1 < title.length; i += 1) out.add(`b:${title[i]}_${title[i + 1]}`);
  if (article.excerpt !== null) {
    for (const token of tokenize(article.excerpt).slice(0, ESTIMATE_EXCERPT_TOKENS)) {
      out.add(`e:${stemToken(token)}`);
    }
  }
  if (article.feedId !== null) out.add(`f:${article.feedId}`);
  return [...out];
}
