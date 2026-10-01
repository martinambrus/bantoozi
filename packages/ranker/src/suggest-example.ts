import { normalizeText, type Explain, type Strength } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from './config.js';

/**
 * Card example suggestions (spec 06 §10, spec 08 §5.3 `/articles/:id/rating`): after a single
 * explicit rating, offer to add the article title as a `yes`/`no` example of the positive card that
 * explains the item best. An example changes Jev's own answer for every later article of that card,
 * so it helps before any personal model exists. A suggestion is only an offer: nothing changes until
 * the user accepts it through `POST /cards/:id/examples`.
 */

/** Dislike reasons of the rating endpoint (spec 02 `user_article.reason`). */
export type RatingReason = 'off_topic' | 'clickbait' | 'seen' | 'shallow' | 'promo' | 'other';

/** What produced the feedback: only a single explicit rating (`rating`) may suggest. */
export type SuggestionTrigger =
  'rating' | 'bulk_rating' | 'prompt_answer' | 'bookmark' | 'implicit';

export interface ExampleSuggestion {
  cardId: string;
  side: 'yes' | 'no';
}

/** One interest card the user holds now, with its current examples. */
export interface SuggestionCard {
  cardId: string;
  strength: Strength;
  /** A private fork already; adding an example to another card creates one (`maxForks`). */
  isPrivateFork: boolean;
  examplesYes: readonly string[];
  examplesNo: readonly string[];
}

/** An earlier suggestion, read from the `rate` events that carried one. */
export interface PastSuggestion {
  cardId: string;
  at: Date;
}

export interface SuggestExampleInput {
  trigger: SuggestionTrigger;
  /** The rating just set; `null` is an un-rate. */
  rating: 1 | -1 | null;
  reason: RatingReason | null;
  /** `articles.content_revision` the rating applies to (decimal string). */
  ratedContentRevision: string;
  /** The item's stored explanation (`user_article.explain`), as the reader saw it. */
  explain: Explain | null;
  /** The interest cards the user holds now. */
  cards: readonly SuggestionCard[];
  /** The example text the article title would contribute; `null` when the title is unusable. */
  exampleText: string | null;
  /** `prefs.exampleSuggestions`. */
  enabled: boolean;
  /** The user's current private forks and the plan's `maxForks`. */
  forkCount: number;
  maxForks: number;
  /** Earlier suggestions (at least those of the last 7 days). */
  recent: readonly PastSuggestion[];
  now: Date;
  config: Pick<ReadonlyRankerConfig, 'lanes'>;
}

/** The same card is not suggested again within 7 days (spec 06 §10). */
export const SUGGESTION_CARD_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** At most 3 suggestions within 24 hours (spec 06 §10). */
export const SUGGESTION_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SUGGESTION_DAILY_LIMIT = 3;

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * `suggestExample` (spec 06 §10), pure. Uses the stored `explain` only when it describes the rated
 * revision and its source is `cards` or `model`. Among its positive cards with a `typesafe` answer
 * that the user still holds with a positive strength, the one with the highest p (ties: lowest
 * numeric id) decides:
 * - a dislike with reason `off_topic` and p ≥ `lanes.maybe` → `{cardId, side: 'no'}`; any other
 *   reason, or none, never suggests (the card may have matched correctly)
 * - a like with `lanes.maybe` ≤ p < `lanes.forYou` → `{cardId, side: 'yes'}`
 * - nothing otherwise. Never-cards, bulk ratings, prompt answers, un-rating, bookmarks and implicit
 *   signals never suggest.
 *
 * No suggestion when the preference is off, the title is already an example on that side, the card
 * is not yet a private fork while the user holds `maxForks` forks, the same card was suggested in
 * the last 7 days, or 3 suggestions were made in the last 24 hours.
 */
export function suggestExample(input: SuggestExampleInput): ExampleSuggestion | null {
  if (!input.enabled || input.trigger !== 'rating' || input.rating === null) return null;
  const { explain } = input;
  if (explain === null || explain.inputs.contentRevision !== input.ratedContentRevision) {
    return null;
  }
  if (explain.source !== 'cards' && explain.source !== 'model') return null;

  const held = new Map(input.cards.map((card) => [card.cardId, card]));
  let best: { card: SuggestionCard; p: number } | null = null;
  for (const entry of explain.cards) {
    const card = held.get(entry.id);
    if (card === undefined || card.strength === 'never' || entry.strength === 'never') continue;
    if (entry.engine !== 'typesafe') continue;
    if (
      best === null ||
      entry.p > best.p ||
      (entry.p === best.p && compareIds(entry.id, best.card.cardId) < 0)
    ) {
      best = { card, p: entry.p };
    }
  }
  if (best === null) return null;

  const { lanes } = input.config;
  let side: ExampleSuggestion['side'] | null = null;
  if (input.rating === -1 && input.reason === 'off_topic' && best.p >= lanes.maybe) side = 'no';
  if (input.rating === 1 && best.p >= lanes.maybe && best.p < lanes.forYou) side = 'yes';
  if (side === null) return null;

  if (input.exampleText === null) return null;
  const text = normalizeText(input.exampleText);
  const existing = side === 'yes' ? best.card.examplesYes : best.card.examplesNo;
  if (existing.some((example) => normalizeText(example) === text)) return null;
  if (!best.card.isPrivateFork && input.forkCount >= input.maxForks) return null;

  const now = input.now.getTime();
  const cardId = best.card.cardId;
  if (
    input.recent.some(
      (s) => s.cardId === cardId && now - s.at.getTime() < SUGGESTION_CARD_COOLDOWN_MS,
    )
  ) {
    return null;
  }
  const lastDay = input.recent.filter((s) => now - s.at.getTime() < SUGGESTION_DAILY_WINDOW_MS);
  if (lastDay.length >= SUGGESTION_DAILY_LIMIT) return null;
  return { cardId, side };
}
