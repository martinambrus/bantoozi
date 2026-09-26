import { compareBigIntStrings, type Strength } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from './config.js';
import { isProbability } from './lanes.js';
import { mustCode, neverCode, neverSoftCode } from './rule-codes.js';
import type { CardAnswers, ModelEngine, PositiveStrength, RankCard, RankItem } from './types.js';

/** What card evaluation reads from an item: its answers and its authorized carriers. */
export type CardEvidenceItem = Pick<RankItem, 'cardAnswers' | 'inferenceFeedIds'>;

/** An answer that counts as evidence: a measuring engine and a probability in [0, 1]. */
export interface UsableAnswer {
  p: number;
  engine: ModelEngine;
}

const MODEL_ENGINES: ReadonlySet<string> = new Set<ModelEngine>(['typesafe', 'llm', 'laya']);

export function isPositiveStrength(strength: Strength): strength is PositiveStrength {
  return strength !== 'never';
}

/**
 * Card scope (spec 06 §2): an unscoped card applies to every item; a scoped card only when its feed
 * is one of the item's authorized carriers, whichever view lists the item. Scope applies to every
 * card operation: positive and never cards, the must floor, coverage, BM25 and explanations.
 */
export function isCardApplicable(
  card: Pick<RankCard, 'scopeFeedId'>,
  inferenceFeedIds: readonly string[],
): boolean {
  return card.scopeFeedId === undefined || inferenceFeedIds.includes(card.scopeFeedId);
}

/**
 * The card's answer when it is evidence (spec 06 §2, §4.1). A missing or malformed answer, a
 * `prefilter` marker, an unknown engine or a nonfinite/out-of-range probability is unknown
 * (`undefined`), never zero.
 */
export function usableAnswer(answers: CardAnswers, cardId: string): UsableAnswer | undefined {
  if (!Object.hasOwn(answers, cardId)) return undefined;
  const answer: unknown = answers[cardId];
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { p, engine } = answer as Partial<Record<'p' | 'engine', unknown>>;
  return isModelEngine(engine) && isProbability(p) ? { p, engine } : undefined;
}

function isModelEngine(engine: unknown): engine is ModelEngine {
  return typeof engine === 'string' && MODEL_ENGINES.has(engine);
}

/** The card score and the card that achieved it (spec 06 §4.1). */
export interface CardScore {
  /** `max over applicable positive cards with a usable answer of w[strength] × p`. */
  score: number;
  /** The deciding card (`explain.decidingCardId`). */
  decidingCardId: string;
  /** Its answer; the engine drives the LLM cap of §2 step 6iv. */
  decidingAnswer: UsableAnswer;
}

/**
 * `cardScore` (spec 06 §4.1): the maximum of `strengthWeights[strength] × p` over the applicable
 * positive cards with a usable answer, ties to the lowest numeric card id. Missing answers and
 * `prefilter` markers are unknown and ignored, never cards do not count, and scope follows
 * {@link isCardApplicable}. Returns `null` when no applicable positive card has a usable answer:
 * the item then has no card score (pending answers leave it in New).
 */
export function cardScore(
  cards: readonly RankCard[],
  item: CardEvidenceItem,
  config: Pick<ReadonlyRankerConfig, 'strengthWeights'>,
): CardScore | null {
  let best: CardScore | null = null;
  for (const card of cards) {
    if (!isPositiveStrength(card.strength)) continue;
    if (!isCardApplicable(card, item.inferenceFeedIds)) continue;
    const answer = usableAnswer(item.cardAnswers, card.cardId);
    if (answer === undefined) continue;
    const score = config.strengthWeights[card.strength] * answer.p;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && compareBigIntStrings(card.cardId, best.decidingCardId) < 0)
    ) {
      best = { score, decidingCardId: card.cardId, decidingAnswer: answer };
    }
  }
  return best;
}

/** An applicable card with its usable answer. */
export interface AnsweredCard {
  cardId: string;
  p: number;
  engine: ModelEngine;
}

/**
 * The applicable card matching `accept` with the highest usable p, ties to the lowest numeric id;
 * `null` when none has a usable answer.
 */
function strongestAnswer(
  cards: readonly RankCard[],
  item: CardEvidenceItem,
  accept: (card: RankCard) => boolean,
): AnsweredCard | null {
  let best: AnsweredCard | null = null;
  for (const card of cards) {
    if (!accept(card) || !isCardApplicable(card, item.inferenceFeedIds)) continue;
    const answer = usableAnswer(item.cardAnswers, card.cardId);
    if (answer === undefined) continue;
    if (
      best === null ||
      answer.p > best.p ||
      (answer.p === best.p && compareBigIntStrings(card.cardId, best.cardId) < 0)
    ) {
      best = { cardId: card.cardId, p: answer.p, engine: answer.engine };
    }
  }
  return best;
}

/** The effect of the user's never-cards on an item (spec 06 §4.2). */
export type NeverVerdict =
  | { effect: 'hide'; cardId: string; p: number; code: `never:${string}` }
  | { effect: 'soft_cap'; cardId: string; p: number; code: `never_soft:${string}` }
  | { effect: 'none' };

/**
 * Never-card evaluation (spec 06 §4.2) over the applicable never-cards with a usable answer: the
 * strongest one (highest p, ties to the lowest numeric id) hides the item when `p ≥ never.hide`
 * (`never:<id>`, §2 step 3) and caps the lane at Maybe when `never.soft ≤ p < never.hide`
 * (`never_soft:<id>`, §2 step 6iv). A missing answer or `prefilter` marker never hides anything.
 * These apply whatever the score source, the personal model included.
 */
export function evaluateNeverCards(
  cards: readonly RankCard[],
  item: CardEvidenceItem,
  config: Pick<ReadonlyRankerConfig, 'never'>,
): NeverVerdict {
  const strongest = strongestAnswer(cards, item, (card) => card.strength === 'never');
  if (strongest === null) return { effect: 'none' };
  const { cardId, p } = strongest;
  if (p >= config.never.hide) return { effect: 'hide', cardId, p, code: neverCode(cardId) };
  if (p >= config.never.soft) return { effect: 'soft_cap', cardId, p, code: neverSoftCode(cardId) };
  return { effect: 'none' };
}

/**
 * The must-card floor trigger (spec 06 §2 step 6iii): the applicable `must` card with the highest
 * usable p when that p is at least `mustFloor` (ties to the lowest numeric id), else `null`. The
 * floor compares the card's own p, not its weighted score.
 */
export function mustFloorCard(
  cards: readonly RankCard[],
  item: CardEvidenceItem,
  config: Pick<ReadonlyRankerConfig, 'mustFloor'>,
): (AnsweredCard & { code: `must:${string}` }) | null {
  const strongest = strongestAnswer(cards, item, (card) => card.strength === 'must');
  if (strongest === null || strongest.p < config.mustFloor) return null;
  return { ...strongest, code: mustCode(strongest.cardId) };
}
