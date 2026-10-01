import { compareBigIntStrings } from '@bantoozi/shared';
import {
  DEFAULT_RANKER_CONFIG,
  isPositiveStrength,
  type ReadonlyRankerConfig,
} from '@bantoozi/ranker';
import { cutToCodePoints } from '@bantoozi/translate';

import type { RunCard, RunRating } from './run-config.js';

/**
 * E6 "card examples" (spec 10 §3, informational, development only). Each context's development
 * story groups are split by the time of their first rating into an earlier and a later half. The
 * suggestion rule of spec 06 §10 (`suggestExample`) is applied to the earlier half's E1 answers and
 * ratings in rating order, without the frequency limits, the preference or the fork quota, and
 * every suggestion is accepted within the example limits of spec 05 §5.1 (at most five per side,
 * the newest kept, each at most 200 characters). Call B then reruns for the later half with the
 * resulting cards. Pure: the runner supplies E1's answers and the frozen titles.
 */

/** Spec 05 §5.1 example limits. */
export const EXAMPLES_PER_SIDE = 5;
export const EXAMPLE_MAX_CHARS = 200;

export interface E6Article {
  storyGroupId: string;
  title: string;
}

/** An E1 card answer that may drive a suggestion (only `typesafe` answers do, spec 06 §10). */
export interface E6Answer {
  p: number;
  engine: string;
}

export interface E6Input {
  cards: readonly RunCard[];
  /** Development ratings of the E1 cohort. */
  ratings: readonly RunRating[];
  articles: ReadonlyMap<string, E6Article>;
  /** E1's card answers: article id → card id → answer. */
  answers: ReadonlyMap<string, ReadonlyMap<string, E6Answer>>;
  config?: Pick<ReadonlyRankerConfig, 'lanes'>;
}

export interface E6Plan {
  /** Each rater's cards with the accepted examples (unchanged cards included). */
  cardsByRater: Map<string, RunCard[]>;
  /** Examples added per card id (summed over raters holding it). */
  examplesAdded: Record<string, { yes: number; no: number }>;
  /** Each rater's later-half articles, which Call B reruns. */
  laterByRater: Map<string, string[]>;
  earlierArticleIds: string[];
  laterArticleIds: string[];
}

const byTimeThenIds = (a: RunRating, b: RunRating) =>
  a.createdAt.localeCompare(b.createdAt) ||
  compareBigIntStrings(a.raterId, b.raterId) ||
  compareBigIntStrings(a.articleId, b.articleId);

/** A dislike reason meaning "off topic" (`off_topic`, `Off-topic`, …). */
export function isOffTopic(reason: string | null): boolean {
  return (
    reason !== null &&
    reason
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_') === 'off_topic'
  );
}

/** An example text within the §5.1 limit. */
export function exampleText(title: string): string {
  return cutToCodePoints(title.trim().replace(/\s+/g, ' '), EXAMPLE_MAX_CHARS).trim();
}

/**
 * The suggestion of spec 06 §10 for one rating: among the rater's positive cards with a `typesafe`
 * answer, the one with the highest p (ties to the lowest id); `no` for an off-topic dislike with
 * `p ≥ lanes.maybe`, `yes` for a like with `lanes.maybe ≤ p < lanes.forYou`, else nothing.
 */
export function suggestExample(
  cards: readonly RunCard[],
  answers: ReadonlyMap<string, E6Answer> | undefined,
  rating: Pick<RunRating, 'rating' | 'reason'>,
  config: Pick<ReadonlyRankerConfig, 'lanes'>,
): { cardId: string; side: 'yes' | 'no' } | null {
  if (answers === undefined) return null;
  let best: { cardId: string; p: number } | null = null;
  for (const card of cards) {
    if (!isPositiveStrength(card.strength)) continue;
    const answer = answers.get(card.cardId);
    if (answer === undefined || answer.engine !== 'typesafe') continue;
    if (
      best === null ||
      answer.p > best.p ||
      (answer.p === best.p && compareBigIntStrings(card.cardId, best.cardId) < 0)
    ) {
      best = { cardId: card.cardId, p: answer.p };
    }
  }
  if (best === null) return null;
  if (rating.rating === -1) {
    return isOffTopic(rating.reason) && best.p >= config.lanes.maybe
      ? { cardId: best.cardId, side: 'no' }
      : null;
  }
  return best.p >= config.lanes.maybe && best.p < config.lanes.forYou
    ? { cardId: best.cardId, side: 'yes' }
    : null;
}

export function planE6(input: E6Input): E6Plan {
  const config = input.config ?? DEFAULT_RANKER_CONFIG;
  const cardsByRater = new Map<string, RunCard[]>();
  for (const card of input.cards) {
    const list = cardsByRater.get(card.raterId) ?? [];
    list.push({ ...card, examplesYes: [...card.examplesYes], examplesNo: [...card.examplesNo] });
    cardsByRater.set(card.raterId, list);
  }
  const ratingsByRater = new Map<string, RunRating[]>();
  for (const rating of [...input.ratings].sort(byTimeThenIds)) {
    if (!input.articles.has(rating.articleId)) continue;
    const list = ratingsByRater.get(rating.raterId) ?? [];
    list.push(rating);
    ratingsByRater.set(rating.raterId, list);
  }

  const examplesAdded: Record<string, { yes: number; no: number }> = {};
  const laterByRater = new Map<string, string[]>();
  const earlier = new Set<string>();
  const later = new Set<string>();
  for (const [raterId, ratings] of [...ratingsByRater].sort(([a], [b]) =>
    compareBigIntStrings(a, b),
  )) {
    // Story groups in the order of their first rating (ratings are sorted by time).
    const groups: string[] = [];
    for (const rating of ratings) {
      const group = input.articles.get(rating.articleId)?.storyGroupId;
      if (group !== undefined && !groups.includes(group)) groups.push(group);
    }
    const earlyGroups = new Set(groups.slice(0, Math.floor(groups.length / 2)));
    const cards = cardsByRater.get(raterId) ?? [];
    const laterIds: string[] = [];
    for (const rating of ratings) {
      const article = input.articles.get(rating.articleId);
      if (article === undefined) continue;
      if (!earlyGroups.has(article.storyGroupId)) {
        if (!laterIds.includes(rating.articleId)) laterIds.push(rating.articleId);
        later.add(rating.articleId);
        continue;
      }
      earlier.add(rating.articleId);
      const suggestion = suggestExample(cards, input.answers.get(rating.articleId), rating, config);
      if (suggestion === null) continue;
      const card = cards.find((c) => c.cardId === suggestion.cardId);
      const text = exampleText(article.title);
      if (card === undefined || text === '') continue;
      const side = suggestion.side === 'yes' ? card.examplesYes : card.examplesNo;
      if (side.includes(text)) continue;
      side.push(text);
      // The newest five per side are kept (spec 05 §5.1 "newest 5 per side").
      if (side.length > EXAMPLES_PER_SIDE) side.splice(0, side.length - EXAMPLES_PER_SIDE);
      const counts = (examplesAdded[card.cardId] ??= { yes: 0, no: 0 });
      counts[suggestion.side] += 1;
    }
    laterByRater.set(raterId, laterIds);
  }
  const sortIds = (ids: Iterable<string>) => [...ids].sort(compareBigIntStrings);
  return {
    cardsByRater,
    examplesAdded,
    laterByRater,
    earlierArticleIds: sortIds(earlier),
    laterArticleIds: sortIds(later),
  };
}
