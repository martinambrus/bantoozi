import type { CardStrength, RaterCard } from '@bantoozi/db';

/**
 * The rating app's steps (spec 10 §2.2): write 5–10 interest cards (plus up to 3 "never" cards)
 * before seeing any article, pick at least 10 golden feeds, then rate. Cards and feeds are frozen
 * once the first assignments exist, so no rater sees articles before their cards are final and a
 * run's frozen cards match what the rater wrote before rating (D-100).
 */

export const MIN_INTEREST_CARDS = 5;
export const MAX_INTEREST_CARDS = 10;
export const MAX_NEVER_CARDS = 3;
export const MIN_FEEDS = 10;

export const POSITIVE_STRENGTHS: readonly CardStrength[] = ['must', 'love', 'like'];

export interface StepState {
  interestCards: number;
  neverCards: number;
  feeds: number;
  assignments: number;
}

export function countCards(cards: ReadonlyArray<Pick<RaterCard, 'strength'>>): {
  interestCards: number;
  neverCards: number;
} {
  const neverCards = cards.filter((c) => c.strength === 'never').length;
  return { interestCards: cards.length - neverCards, neverCards };
}

export function cardsReady(state: Pick<StepState, 'interestCards' | 'neverCards'>): boolean {
  return (
    state.interestCards >= MIN_INTEREST_CARDS &&
    state.interestCards <= MAX_INTEREST_CARDS &&
    state.neverCards <= MAX_NEVER_CARDS
  );
}

export function feedsReady(state: Pick<StepState, 'feeds'>): boolean {
  return state.feeds >= MIN_FEEDS;
}

/** Whether rating may start (or continue): both earlier steps are complete. */
export function readyToRate(state: StepState): boolean {
  return cardsReady(state) && feedsReady(state);
}

/** Cards and feeds can change only until the first assignment exists. */
export function setupLocked(state: Pick<StepState, 'assignments'>): boolean {
  return state.assignments > 0;
}

/** Why a card cannot be added, or null when it can. */
export function cardLimitError(
  state: Pick<StepState, 'interestCards' | 'neverCards'>,
  strength: CardStrength,
): string | null {
  if (strength === 'never') {
    return state.neverCards >= MAX_NEVER_CARDS ? `At most ${MAX_NEVER_CARDS} "never" cards.` : null;
  }
  return state.interestCards >= MAX_INTEREST_CARDS
    ? `At most ${MAX_INTEREST_CARDS} interest cards.`
    : null;
}
