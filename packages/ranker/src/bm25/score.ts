import { compareBigIntStrings } from '@bantoozi/shared';

import { isCardApplicable, isPositiveStrength } from '../cards.js';
import type { ReadonlyRankerConfig } from '../config.js';
import type { RankCard, RankItem } from '../types.js';
import {
  type Bm25Corpus,
  bm25DocumentTokens,
  type Bm25TermStats,
  type Bm25Text,
  hasTranslation,
} from './corpus.js';
import { tokenize } from './tokenize.js';

/**
 * Exact BM25 IDF with +0.5 smoothing (spec 06 §9): `ln(1 + (N − df + 0.5) / (df + 0.5))`. `df` is
 * clamped to [0, N], so the result is always positive and finite.
 */
export function bm25Idf(df: number, documents: number): number {
  const n = Math.max(0, documents);
  const d = Math.min(Math.max(0, df), n);
  return Math.log1p((n - d + 0.5) / (d + 0.5));
}

/**
 * `BM25(query, document)` (spec 06 §9): the sum over the unique query terms of
 * `IDF × tf × (k1 + 1) / (tf + k1 × (1 − b + b × docLength / avgLength))`, with `k1` and `b` from
 * the config and the statistics of the whole window. An empty corpus, document or query, or a zero
 * average length, scores 0, never NaN.
 */
export function bm25(
  queryTokens: readonly string[],
  documentTokens: readonly string[],
  stats: Bm25TermStats,
  config: Pick<ReadonlyRankerConfig, 'bm25'>,
): number {
  return scoreTerms(new Set(queryTokens), prepare(documentTokens), stats, config);
}

/** `P = 1 − exp(−s / bm25.scale)` (spec 06 §9); 0 for a score that is not positive. */
export function bm25P(s: number, config: Pick<ReadonlyRankerConfig, 'bm25'>): number {
  if (!(s > 0)) return 0;
  return -Math.expm1(-s / config.bm25.scale);
}

interface PreparedDocument {
  length: number;
  tf: ReadonlyMap<string, number>;
}

function prepare(tokens: readonly string[]): PreparedDocument {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return { length: tokens.length, tf };
}

function scoreTerms(
  terms: ReadonlySet<string>,
  document: PreparedDocument,
  stats: Bm25TermStats,
  config: Pick<ReadonlyRankerConfig, 'bm25'>,
): number {
  if (terms.size === 0 || document.length === 0) return 0;
  if (!(stats.documents > 0) || !(stats.avgLength > 0)) return 0;
  const { k1, b } = config.bm25;
  const lengthNorm = k1 * (1 - b + (b * document.length) / stats.avgLength);
  let score = 0;
  for (const term of terms) {
    const tf = document.tf.get(term) ?? 0;
    if (tf === 0) continue;
    const idf = bm25Idf(stats.df.get(term) ?? 0, stats.documents);
    score += (idf * tf * (k1 + 1)) / (tf + lengthNorm);
  }
  return score;
}

/** Which texts BM25 compares for one card and article (spec 06 §9). */
export interface Bm25Pairing {
  document: 'original' | 'translated';
  query: 'interest' | 'interest_en';
  /**
   * The document is English but the card has no English text, so the original pair was scored;
   * the evaluation reports it (§9).
   */
  untranslatedQuery: boolean;
}

/** What pairing reads from an article: its text and detected language. */
export type Bm25Article = Bm25Text & Pick<RankItem, 'lang'>;

/**
 * The document/query pair of spec 06 §9: `interest_en` only with an English document, and never a
 * translated English document with an untranslated Slovak/Czech query.
 * - With a translation (always English): the translated document with `interest_en`, or with
 *   `interest` when the card is written in English; otherwise the original document and `interest`,
 *   flagged `untranslatedQuery`.
 * - Without one: the original document, with `interest_en` when the article is English and the card
 *   has it, else with `interest` (flagged when the article is English and the card is not known to
 *   be).
 */
export function bm25Pairing(
  card: Pick<RankCard, 'interestEn' | 'lang'>,
  article: Bm25Article,
): Bm25Pairing {
  const hasEnglishQuery = card.interestEn !== undefined && card.interestEn.trim() !== '';
  const cardIsEnglish = card.lang === 'en';
  if (hasTranslation(article)) {
    if (hasEnglishQuery) return pairing('translated', 'interest_en', false);
    if (cardIsEnglish) return pairing('translated', 'interest', false);
    return pairing('original', 'interest', true);
  }
  const articleIsEnglish = article.lang === 'en';
  if (articleIsEnglish && hasEnglishQuery) return pairing('original', 'interest_en', false);
  return pairing('original', 'interest', articleIsEnglish && !cardIsEnglish);
}

function pairing(
  document: Bm25Pairing['document'],
  query: Bm25Pairing['query'],
  untranslatedQuery: boolean,
): Bm25Pairing {
  return { document, query, untranslatedQuery };
}

/** One card's degraded score. */
export interface DegradedCardScore {
  cardId: string;
  s: number;
  pairing: Bm25Pairing;
}

/** The degraded (keyword) score of an item (spec 06 §9). */
export interface DegradedScore {
  /** `s = max over the applicable positive cards of BM25(card, document)`. */
  s: number;
  /** `bm25P(s)`. */
  p: number;
  /** The card achieving `s` (ties to the lowest numeric id); for explanation and evaluation only. */
  bestCardId: string;
  /** Every applicable positive card, in numeric id order, with its pairing (reported in eval). */
  cards: DegradedCardScore[];
}

/**
 * The BM25 fallback of spec 06 §9, used when the engine was unavailable (§2 step 4c) and by the
 * evaluation as a baseline: `s` is the best BM25 score over the user's applicable positive cards,
 * and `P = 1 − exp(−s / scale)`. Scope applies as to every card operation; never-cards are not
 * queries. Returns `null` without an applicable positive card. The corpus must describe the whole
 * window ({@link Bm25Corpus}); the lane of a BM25 score is always Maybe (§2 step 6ii).
 */
export function degradedScore(
  cards: readonly RankCard[],
  item: Bm25Article & Pick<RankItem, 'inferenceFeedIds'>,
  corpus: Bm25Corpus,
  config: Pick<ReadonlyRankerConfig, 'bm25'>,
): DegradedScore | null {
  const applicable = cards
    .filter((card) => isPositiveStrength(card.strength))
    .filter((card) => isCardApplicable(card, item.inferenceFeedIds))
    .sort((a, b) => compareBigIntStrings(a.cardId, b.cardId));
  if (applicable.length === 0) return null;

  const tokens = bm25DocumentTokens(item);
  const original = prepare(tokens.original);
  const translated = tokens.translated === null ? null : prepare(tokens.translated);
  const scored = applicable.map((card): DegradedCardScore => {
    const pair = bm25Pairing(card, item);
    const query = pair.query === 'interest_en' ? (card.interestEn ?? '') : card.interest;
    // A translated article scored on its original text uses the statistics of original texts.
    const [document, stats] =
      pair.document === 'translated' && translated !== null
        ? [translated, corpus.preferred]
        : [original, translated === null ? corpus.preferred : corpus.original];
    const s = scoreTerms(new Set(tokenize(query)), document, stats, config);
    return { cardId: card.cardId, s, pairing: pair };
  });
  // In id order, so a strict comparison leaves ties with the lowest id.
  const best = scored.reduce((a, b) => (b.s > a.s ? b : a));
  return { s: best.s, p: bm25P(best.s, config), bestCardId: best.cardId, cards: scored };
}
