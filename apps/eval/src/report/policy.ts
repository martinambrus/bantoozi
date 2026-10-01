import {
  applyLanePolicy,
  cardScore,
  evaluateNeverCards,
  matchCoverage,
  mustFloorCard,
  type CardAnswers,
  type CardWorkStates,
  type RankCard,
  type ReadonlyRankerConfig,
} from '@bantoozi/ranker';

import type { ReportLane } from '../metrics/index.js';
import type { RatedItem } from './items.js';
import { raterCardResults, type RunCard, type RunData } from './run-data.js';

/**
 * The production-policy view of an item (spec 10 §3 "Per article and rater"): the rater's frozen
 * cards and the run's Call B answers go through the ranker's own card score, never-card,
 * must-floor, coverage and lane helpers under a given config. A never hard match hides the item
 * (policy score zero); soft never caps and must floors apply; demotions and the personal model do
 * not (no per-user demotion state exists in the evaluation). No usable positive answer leaves the
 * item in New (unknown, counted), and a failed card answer makes coverage unavailable, as the
 * router's exhausted state would.
 */
export type PolicyConfig = Pick<
  ReadonlyRankerConfig,
  'lanes' | 'tiers' | 'strengthWeights' | 'never' | 'mustFloor' | 'llmForYouMin'
>;

export interface PolicyOutcome {
  lane: ReportLane;
  /** Policy P after floors (0 for a hidden item), null when unknown. */
  p: number | null;
  /** The raw card score (no floors, no caps). */
  rawScore: number | null;
}

export function rankCardsOf(cards: readonly RunCard[], raterId: string): RankCard[] {
  return cards
    .filter((card) => card.raterId === raterId)
    .map((card) => ({
      cardId: card.cardId,
      title: '',
      strength: card.strength,
      interest: card.interest ?? '',
      ...(card.lang === undefined || card.lang === null ? {} : { lang: card.lang }),
    }));
}

export function policyOutcome(
  cards: readonly RankCard[],
  run: RunData,
  articleId: string,
  config: PolicyConfig,
  raterId?: string,
): PolicyOutcome {
  const answers: Record<string, { p: number; engine: 'typesafe' | 'llm' | 'laya' }> = {};
  const work: Record<string, 'exhausted'> = {};
  const results =
    raterId === undefined ? run.cards.get(articleId) : raterCardResults(run, raterId, articleId);
  for (const card of cards) {
    const result = results?.get(card.cardId);
    if (result === undefined) continue;
    if (
      result.ok &&
      (result.engine === 'typesafe' || result.engine === 'llm' || result.engine === 'laya')
    ) {
      answers[card.cardId] = { p: result.p, engine: result.engine };
    } else {
      work[card.cardId] = 'exhausted';
    }
  }
  const item = { cardAnswers: answers as CardAnswers, inferenceFeedIds: [] as string[] };
  const score = cardScore(cards, item, config);
  const never = evaluateNeverCards(cards, item, config);
  if (never.effect === 'hide') return { lane: 'hidden', p: 0, rawScore: score?.score ?? null };
  if (score === null) return { lane: 'new', p: null, rawScore: null };
  const coverage = matchCoverage(cards, item, work as CardWorkStates).coverage;
  const must = mustFloorCard(cards, item, config);
  const result = applyLanePolicy(
    {
      p: score.score,
      source: 'cards',
      coverage,
      floors: must === null ? [] : [{ kind: 'must', cardId: must.cardId }],
      neverSoftCardId: never.effect === 'soft_cap' ? never.cardId : null,
      decidingEngine: score.decidingAnswer.engine,
    },
    config,
  );
  return { lane: result.lane, p: result.p, rawScore: score.score };
}

/** Lanes of rated items under a config; `runFor` picks the run of each item (a composition). */
export function policyLanes(
  items: readonly RatedItem[],
  runFor: (item: RatedItem) => RunData | null,
  cards: readonly RunCard[],
  config: PolicyConfig,
): Map<string, PolicyOutcome> {
  const byRater = new Map<string, RankCard[]>();
  const result = new Map<string, PolicyOutcome>();
  for (const item of items) {
    const run = runFor(item);
    if (run === null) {
      result.set(item.key, { lane: 'new', p: null, rawScore: null });
      continue;
    }
    let rankCards = byRater.get(item.raterId);
    if (rankCards === undefined) {
      rankCards = rankCardsOf(cards, item.raterId);
      byRater.set(item.raterId, rankCards);
    }
    result.set(item.key, policyOutcome(rankCards, run, item.articleId, config, item.raterId));
  }
  return result;
}
