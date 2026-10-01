import {
  buildBm25Corpus,
  cardScore,
  DEFAULT_RANKER_CONFIG,
  degradedScore,
  isPositiveStrength,
  type Bm25Corpus,
  type CardAnswers,
  type RankCard,
  type ReadonlyRankerConfig,
} from '@bantoozi/ranker';
import { normalizeText } from '@bantoozi/shared';

import type { EvalSnapshot } from '../dataset/snapshot.js';
import type { ScoreSource } from './definitions.js';
import type { RunCard } from './run-config.js';
import type { FrozenTranslation } from './states.js';
import { usableTranslation } from './states.js';

/**
 * The zero-training score per article and rater (spec 10 §3 "Per article and rater"), written as
 * `score.r<raterId>`: B0 by recency, B1/B1-T by the BM25 fallback of spec 06 §9 with the rater's
 * assigned frozen articles as corpus, and the card experiments by `cardScore` (spec 06 §4.1: no
 * demotions, no model). `null` is unknown (no applicable positive card answered, or no positive
 * card at all), never 0.
 */

export interface ScoreRow {
  score: number | null;
  source: ScoreSource;
  decidingCardId?: string;
}

/** The ranker card of a run card; `english` card mode gives BM25 the run's English query. */
export function rankCardOf(card: RunCard, englishQuery: boolean): RankCard {
  return {
    cardId: card.cardId,
    title: card.title,
    strength: card.strength,
    interest: card.interest,
    ...(englishQuery && card.interestEn !== null ? { interestEn: card.interestEn } : {}),
    lang: card.lang,
  };
}

/**
 * B0: newer = higher. The score is the article's recency percentile within the rater's scored
 * articles (published time, else first-seen time; equal times share their mean rank), so it orders
 * exactly like the timestamps and stays in [0, 1].
 */
export function chronoScores(
  articleIds: readonly string[],
  snapshots: ReadonlyMap<string, EvalSnapshot>,
): Map<string, number> {
  const times = articleIds.map((id) => {
    const snapshot = snapshots.get(id);
    const at = snapshot === undefined ? null : (snapshot.publishedAt ?? snapshot.firstSeenAt);
    return { id, t: at === null ? 0 : Date.parse(at) };
  });
  const sorted = [...times].sort((a, b) => a.t - b.t);
  const out = new Map<string, number>();
  const n = sorted.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1]?.t === sorted[i]?.t) j += 1;
    const rank = (i + j) / 2;
    for (let k = i; k <= j; k += 1) {
      const item = sorted[k];
      if (item !== undefined) out.set(item.id, n <= 1 ? 1 : rank / (n - 1));
    }
    i = j + 1;
  }
  return out;
}

/** The BM25 text of a frozen article: its own title/excerpt, plus a usable translation's. */
export function bm25Text(snapshot: EvalSnapshot, translation: FrozenTranslation | null) {
  const usable = usableTranslation(translation);
  return {
    lang: snapshot.lang,
    titleNorm: normalizeText(snapshot.input.title),
    excerptNorm: normalizeText(snapshot.input.excerpt ?? ''),
    ...(usable === null
      ? {}
      : {
          translatedTitleNorm: normalizeText(usable.texts.title ?? ''),
          translatedExcerptNorm: normalizeText(usable.texts.excerpt ?? ''),
        }),
  };
}

export function bm25Corpus(texts: Iterable<ReturnType<typeof bm25Text>>): Bm25Corpus {
  return buildBm25Corpus(texts);
}

export function bm25ScoreRow(
  cards: readonly RankCard[],
  text: ReturnType<typeof bm25Text>,
  corpus: Bm25Corpus,
  config: Pick<ReadonlyRankerConfig, 'bm25'> = DEFAULT_RANKER_CONFIG,
): ScoreRow {
  const scored = degradedScore(cards, { ...text, inferenceFeedIds: [] }, corpus, config);
  return scored === null
    ? { score: null, source: 'bm25' }
    : { score: scored.p, source: 'bm25', decidingCardId: scored.bestCardId };
}

export function cardsScoreRow(
  cards: readonly RankCard[],
  answers: CardAnswers,
  config: Pick<ReadonlyRankerConfig, 'strengthWeights'> = DEFAULT_RANKER_CONFIG,
): ScoreRow {
  const scored = cardScore(cards, { cardAnswers: answers, inferenceFeedIds: [] }, config);
  return scored === null
    ? { score: null, source: 'cards' }
    : { score: scored.score, source: 'cards', decidingCardId: scored.decidingCardId };
}

/**
 * Whether a card-experiment score is a valid observation (spec 10 §3 "Completeness"): every one
 * of the rater's positive cards has an answer for the article. A partially answered article is
 * counted as invalid, so coverage below 95 % yields `needs_more_data` instead of a pass on easy items.
 */
export function cardsComplete(cards: readonly RankCard[], answers: CardAnswers): boolean {
  const positive = cards.filter((card) => isPositiveStrength(card.strength));
  return positive.length > 0 && positive.every((card) => Object.hasOwn(answers, card.cardId));
}
