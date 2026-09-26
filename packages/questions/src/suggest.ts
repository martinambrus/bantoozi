import { choice, type OptionCriteria } from './builders.js';
import { cardKey, parseCardKey, selectL2Branches } from './cards.js';
import { buildSuggestState, SUGGEST_MAX_ARTICLES, type SuggestState } from './state.js';
import { OTHER_TOPIC_ID, TAXONOMY, topicL1 } from './taxonomy.js';
import type { ChoiceAnswer, ChoiceQuestion } from './types.js';

/**
 * Card suggestions (spec 05 §7): the pure candidate selection of steps 1–3, the `suggest-v1`
 * question and the result rule of step 6. Leases, spend, authorization and the upserts live in the
 * worker; the caller passes only currently authorized liked articles (§1.1).
 */

/** A liked article is unexplained when every applicable positive card answered below this. */
export const SUGGEST_UNEXPLAINED_MAX_P = 0.3;
/** Stop when fewer unexplained likes than this are eligible (step 1). */
export const SUGGEST_MIN_LIKES = 3;
/** At most this many library cards are offered (step 3), plus `none`. */
export const SUGGEST_MAX_OPTIONS = 60;
/** Results need at least this probability (step 6)… */
export const SUGGEST_MIN_SCORE = 0.15;
/** …and at most this many are stored. */
export const SUGGEST_MAX_RESULTS = 3;

/** The question key of the `suggest-v1` Choice. */
export const SUGGEST_QUESTION_KEY = 'common_interest';
/** The option meaning that no offered card fits. */
export const SUGGEST_NONE_OPTION = 'none';

/** A liked (rated +1 or bookmarked, last 30 days) and currently authorized article. */
export interface SuggestLike {
  articleId: string;
  /** When the user liked or bookmarked it; the state lists the most recent first. */
  likedAt: Date;
  title: string;
  excerpt: string | null;
  /** The article's current `t1.<l1>` probabilities keyed by plain level-1 id; null without current facets. */
  t1: Readonly<Record<string, number>> | null;
  /**
   * The user's applicable positive cards on this article (strength must/love/like, scoped to a
   * carrying feed): `p` of a complete current primary-engine answer, or `null` for a missing,
   * prefilter or fallback answer. Never-cards are not listed.
   */
  cardP: readonly (number | null)[];
}

/** A public library card that may be offered. */
export interface SuggestLibraryCard {
  id: string;
  interest: string;
  notFor: string | null;
  topicIds: readonly string[];
}

/**
 * Step 1: likes whose applicable positive cards all have complete current primary answers below
 * 0.3 (a like no applicable card covers is unexplained too), with current facets. A missing,
 * prefilter or fallback answer makes the like ineligible: it is unknown, not unexplained.
 */
export function unexplainedLikes(likes: readonly SuggestLike[]): SuggestLike[] {
  return likes.filter(
    (like) =>
      like.t1 !== null &&
      like.cardP.every((p) => p !== null && Number.isFinite(p) && p < SUGGEST_UNEXPLAINED_MAX_P),
  );
}

/** Step 2: the level-1 topic with the highest summed `t1` over the likes (excluding `other`; ties by id). */
export function suggestBranch(likes: readonly SuggestLike[]): string | null {
  let best: { id: string; sum: number } | null = null;
  for (const topic of TAXONOMY) {
    if (topic.id === OTHER_TOPIC_ID) continue;
    let sum = 0;
    for (const like of likes) {
      const p = like.t1?.[topic.id];
      if (p !== undefined && Number.isFinite(p)) sum += p;
    }
    if (sum > 0 && (best === null || sum > best.sum || (sum === best.sum && topic.id < best.id))) {
      best = { id: topic.id, sum };
    }
  }
  return best === null ? null : best.id;
}

const byRecency = (a: SuggestLike, b: SuggestLike): number =>
  b.likedAt.getTime() - a.likedAt.getTime() ||
  (BigInt(b.articleId) > BigInt(a.articleId)
    ? 1
    : BigInt(b.articleId) < BigInt(a.articleId)
      ? -1
      : 0);

/**
 * Step 2: up to five likes relevant to the branch (it is one of the article's level-2 branches,
 * spec 05 §4), most recent first.
 */
export function likesForBranch(likes: readonly SuggestLike[], l1: string): SuggestLike[] {
  return likes
    .filter((like) => like.t1 !== null && selectL2Branches(like.t1).includes(l1))
    .sort(byRecency)
    .slice(0, SUGGEST_MAX_ARTICLES);
}

const byNumericId = (a: { id: string }, b: { id: string }): number =>
  BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;

/**
 * Step 3: library cards with a topic in the branch, minus the cards the user holds or dismissed in
 * the last 90 days (`excluded`), by card id, at most 60.
 */
export function suggestOptions(
  cards: readonly SuggestLibraryCard[],
  l1: string,
  excluded: ReadonlySet<string>,
): SuggestLibraryCard[] {
  return cards
    .filter((card) => !excluded.has(card.id) && card.topicIds.some((t) => topicL1(t) === l1))
    .sort(byNumericId)
    .slice(0, SUGGEST_MAX_OPTIONS);
}

/** The `suggest-v1` Choice over the offered cards (`c<cardId>`) plus `none` (spec 05 §7 step 5). */
export function suggestQuestion(
  cards: readonly Pick<SuggestLibraryCard, 'id' | 'interest' | 'notFor'>[],
): ChoiceQuestion {
  return buildSuggestQuestion(cards.map((card) => ({ key: cardKey(card.id), ...card })));
}

/** The builder behind {@link suggestQuestion}; the set template calls it with a placeholder key. */
export function buildSuggestQuestion(
  options: readonly { key: string; interest: string; notFor: string | null }[],
): ChoiceQuestion {
  const criteria: Record<string, OptionCriteria> = {};
  for (const option of options) {
    criteria[option.key] = {
      what: option.interest,
      ...(option.notFor ? { not_for: option.notFor } : {}),
    };
  }
  criteria[SUGGEST_NONE_OPTION] = 'None of these describe what the articles have in common';
  return choice(
    { question: 'Which interest best describes what `liked_articles` have in common?' },
    criteria,
  );
}

export type SuggestPlan =
  | {
      ask: false;
      reason: 'no_positive_cards' | 'too_few_unexplained_likes' | 'no_branch' | 'no_candidates';
    }
  | {
      ask: true;
      l1: string;
      /** The liked articles in the state, most recent first. */
      articleIds: string[];
      /** The offered library card ids, in option order. */
      cardIds: string[];
      state: SuggestState;
      questions: Record<string, ChoiceQuestion>;
    };

/**
 * Steps 1–5 as one pure decision. `positiveCardCount` is the number of positive cards the user
 * holds: with none, onboarding supplies suggestions instead. No call is planned without at least
 * three unexplained likes, a branch, a relevant like and one card to offer (a one-option Choice is
 * invalid).
 */
export function planSuggestion(input: {
  positiveCardCount: number;
  likes: readonly SuggestLike[];
  libraryCards: readonly SuggestLibraryCard[];
  excludedCardIds: ReadonlySet<string>;
}): SuggestPlan {
  if (input.positiveCardCount <= 0) return { ask: false, reason: 'no_positive_cards' };
  const eligible = unexplainedLikes(input.likes);
  if (eligible.length < SUGGEST_MIN_LIKES)
    return { ask: false, reason: 'too_few_unexplained_likes' };
  const l1 = suggestBranch(eligible);
  if (l1 === null) return { ask: false, reason: 'no_branch' };
  const articles = likesForBranch(eligible, l1);
  const cards = suggestOptions(input.libraryCards, l1, input.excludedCardIds);
  if (articles.length === 0 || cards.length === 0) return { ask: false, reason: 'no_candidates' };
  return {
    ask: true,
    l1,
    articleIds: articles.map((like) => like.articleId),
    cardIds: cards.map((card) => card.id),
    state: buildSuggestState(articles),
    questions: { [SUGGEST_QUESTION_KEY]: suggestQuestion(cards) },
  };
}

/**
 * Step 6: nothing when `none` wins; otherwise up to three offered cards with probability ≥ 0.15,
 * by probability descending, then card id. Choice probabilities are relative to the candidate list.
 */
export function suggestResults(answer: ChoiceAnswer): { cardId: string; score: number }[] {
  if (answer.choice === SUGGEST_NONE_OPTION) return [];
  const results: { cardId: string; score: number }[] = [];
  for (const [key, p] of Object.entries(answer.probabilities)) {
    const cardId = parseCardKey(key);
    if (cardId === null || !Number.isFinite(p) || p < SUGGEST_MIN_SCORE) continue;
    results.push({ cardId, score: p });
  }
  return results
    .sort((a, b) => b.score - a.score || byNumericId({ id: a.cardId }, { id: b.cardId }))
    .slice(0, SUGGEST_MAX_RESULTS);
}
