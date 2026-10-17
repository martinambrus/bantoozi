import { normalizeText } from '@bantoozi/shared';

import { tokenize } from './bm25/tokenize.js';

/** Settings of the similar-dislikes check (title-only TF-IDF cosine against a card's recent ratings). */
export const SIMILAR_DISLIKES = {
  /** Only ratings from the last this many days count. */
  windowDays: 30,
  /** At most this many of the newest ratings form the pool. */
  poolSize: 200,
  /** A dislike counts as similar from this cosine. */
  minSimilarity: 0.2,
  /** The top dislikes must beat the top likes by this much (mean cosine). */
  margin: 0.1,
  /** Both the similar-dislike count and the top-k mean use this k. */
  k: 2,
  /** The offer needs this many dislikes in total, the target included. */
  offerMin: 3,
  /** The offer lists this many articles, the target included. */
  offerArticles: 3,
  /** Tokens of at least this many characters are stemmed. */
  stemFrom: 6,
  /** A stemmed token keeps its first this many characters. */
  stemLength: 5,
} as const;

const PRICE_PHRASES = new Set([
  'dohodou',
  'cena dohodou',
  'v texte',
  'info v texte',
  'ponuknite',
  'zadarmo',
  'neuvedena',
]);
const NUMERIC_PRICE = /^\d[\d ]*( ?(eur|kc|czk|sk))?$/;

/** A classified-ad title without its trailing price segment. */
function stripPrice(title: string): string {
  const at = title.lastIndexOf(': ');
  if (at < 0) return title;
  const tail = normalizeText(title.slice(at + 2));
  if (PRICE_PHRASES.has(tail) || NUMERIC_PRICE.test(tail)) return title.slice(0, at);
  return title;
}

/** Title tokens for the similarity check: price segment stripped, tokenized, long tokens stemmed. */
export function similarityTokens(title: string | null): string[] {
  if (title === null) return [];
  return tokenize(stripPrice(title)).map((token) =>
    token.length >= SIMILAR_DISLIKES.stemFrom ? token.slice(0, SIMILAR_DISLIKES.stemLength) : token,
  );
}

/** One rated article of the card, with its similarity tokens. */
export interface LabelledArticle {
  articleId: string;
  rating: 1 | -1;
  ratedAt: Date;
  tokens: readonly string[];
}

export interface SimilarDislikesResult {
  lowered: boolean;
  /** The pool's dislikes at or above `minSimilarity`, most similar first. */
  similar: { articleId: string; ratedAt: Date; similarity: number }[];
  /** The earliest moment the answer can change by a rating leaving the window; null when none. */
  nextChangeAt: Date | null;
}

interface Scored {
  articleId: string;
  ratedAt: Date;
  similarity: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function byRecency(a: LabelledArticle, b: LabelledArticle): number {
  const dt = b.ratedAt.getTime() - a.ratedAt.getTime();
  if (dt !== 0) return dt;
  return a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0;
}

function bySimilarity(a: Scored, b: Scored): number {
  if (b.similarity !== a.similarity) return b.similarity - a.similarity;
  const dt = b.ratedAt.getTime() - a.ratedAt.getTime();
  if (dt !== 0) return dt;
  return a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0;
}

function counts(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function mean(sorted: readonly Scored[], k: number): number {
  let sum = 0;
  for (let i = 0; i < k; i += 1) sum += sorted[i]?.similarity ?? 0;
  return sum / k;
}

/**
 * Whether the target looks like at least `k` of the card's recent dislikes and unlike its likes.
 * Pure: the pool is the newest `poolSize` ratings of the last `windowDays` days, TF-IDF with
 * smoothed idf over the pool plus the target, cosine of the L2-normalised vectors.
 */
export function similarDislikes(
  target: { articleId: string; tokens: readonly string[] },
  labelled: readonly LabelledArticle[],
  now: Date,
): SimilarDislikesResult {
  const { windowDays, poolSize, minSimilarity, margin, k } = SIMILAR_DISLIKES;
  const from = now.getTime() - windowDays * DAY_MS;
  const pool = labelled
    .filter(
      (a) =>
        a.articleId !== target.articleId &&
        a.ratedAt.getTime() > from &&
        a.ratedAt.getTime() <= now.getTime(),
    )
    .sort(byRecency)
    .slice(0, poolSize);

  const docs = [target.tokens, ...pool.map((a) => a.tokens)];
  const df = new Map<string, number>();
  for (const doc of docs) for (const token of new Set(doc)) df.set(token, (df.get(token) ?? 0) + 1);
  const n = docs.length;
  const vector = (tokens: readonly string[]): Map<string, number> => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [token, tf] of counts(tokens)) {
      const w = tf * (Math.log((n + 1) / ((df.get(token) ?? 0) + 1)) + 1);
      v.set(token, w);
      norm += w * w;
    }
    if (norm === 0) return v;
    const root = Math.sqrt(norm);
    for (const [token, w] of v) v.set(token, w / root);
    return v;
  };

  const targetVector = vector(target.tokens);
  const dislikes: Scored[] = [];
  const likes: Scored[] = [];
  for (const a of pool) {
    const v = vector(a.tokens);
    let dot = 0;
    for (const [token, w] of targetVector) dot += w * (v.get(token) ?? 0);
    const scored = { articleId: a.articleId, ratedAt: a.ratedAt, similarity: dot };
    (a.rating === -1 ? dislikes : likes).push(scored);
  }
  dislikes.sort(bySimilarity);
  likes.sort(bySimilarity);

  const similar = dislikes.filter((d) => d.similarity >= minSimilarity);
  const lowered = similar.length >= k && mean(dislikes, k) > mean(likes, k) + margin;

  const relevant = [...dislikes.slice(0, k), ...likes.slice(0, k), ...similar];
  let nextChangeAt: Date | null = null;
  for (const r of relevant) {
    const at = r.ratedAt.getTime() + windowDays * DAY_MS;
    if (nextChangeAt === null || at < nextChangeAt.getTime()) nextChangeAt = new Date(at);
  }
  return { lowered, similar, nextChangeAt };
}

/**
 * The articles to show in "Show fewer like these?" after the target was just disliked: the target
 * plus its most similar dislikes, or null when the pattern is too thin to offer.
 */
export function dislikePatternOffer(
  target: { articleId: string; tokens: readonly string[] },
  labelled: readonly LabelledArticle[],
  now: Date,
): string[] | null {
  const { lowered, similar } = similarDislikes(target, labelled, now);
  const { offerMin, offerArticles } = SIMILAR_DISLIKES;
  if (!lowered || similar.length < offerMin - 1) return null;
  return [target.articleId, ...similar.slice(0, offerArticles - 1).map((s) => s.articleId)];
}
