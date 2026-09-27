import type { ScoreSource } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from './config.js';
import { assertProbability, laneFromP, minLane, type ScoredLane, tierFromP } from './lanes.js';
import { mustCode, neverSoftCode, RULE_CODES } from './rule-codes.js';
import type { MatchCoverage, ModelEngine, Tier } from './types.js';

/** A floor of spec 06 §2 step 6iii: a must card with `p ≥ mustFloor`, or a boost rule. */
export type FloorTrigger =
  | { kind: 'must'; cardId: string }
  | { kind: 'boost_feed'; ruleId?: string | undefined }
  | { kind: 'boost_domain'; ruleId?: string | undefined };

/** A fired rule: its stable code (§3.2) and the ids behind it (an `explain.rules` entry). */
export interface FiredRule {
  code: string;
  cardId?: string;
  ruleId?: string;
}

/** The inputs of the lane modifiers, all computed by the caller. */
export interface LanePolicyInput {
  /** The base probability of §2 step 4 (after quality demotions), in [0, 1]. */
  p: number;
  source: Exclude<ScoreSource, 'none'>;
  /** The user's coverage of their applicable positive cards (`matchCoverage`). */
  coverage: MatchCoverage;
  /** The item's cluster has a member the user read in the window (§2 step 6i). */
  seenStory?: boolean | undefined;
  /** Floors that match (see `mustFloorCard`; boost rules come from the rules engine). */
  floors?: readonly FloorTrigger[] | undefined;
  /** A never-card in the soft band (`evaluateNeverCards` → `soft_cap`). */
  neverSoftCardId?: string | null | undefined;
  /** The engine of the deciding card's answer (source `cards`); `llm` caps below `llmForYouMin`. */
  decidingEngine?: ModelEngine | null | undefined;
}

export interface LanePolicyResult {
  lane: ScoredLane;
  /** P after a floor raised it; the lane caps never rewrite it. */
  p: number;
  tier: Tier;
  /** In evaluation order; `rulesFired` is their codes. */
  rules: FiredRule[];
}

/**
 * The lane policy preview: spec 06 §2 steps 5–8 for a scored item (P set), without the steps that
 * need the full context (the rules engine, demotions, the personal model, explanations and label
 * suggestions, which M5 adds). It is the bootstrap subset the evaluation (G1) uses to turn a P and
 * the flags into a lane and a tier:
 *
 * 5. `lane = laneFromP(P)`.
 * 6. Only the first modifier whose condition holds applies; the later ones are skipped:
 *    i.   a read story → `lane = min(lane, 'everything')`;
 *    ii.  source `degraded` → `lane = 'maybe'` (so a read story keeps a BM25 item in Everything);
 *    iii. a floor → `lane = 'for_you'`, `P = max(P, lanes.forYou)`;
 *    iv.  caps, both may apply: a never-card in the soft band → `min(lane, 'maybe')`; an `llm`
 *         deciding answer with `P < llmForYouMin` → `min(lane, 'maybe')`.
 * 7. Coverage not complete, lane `everything` and no read story → `maybe`.
 * 8. `tier = tierFromP(P)`.
 *
 * A rule fires only when it changes the outcome (§2): `seen_story` and the floors when the lane or
 * P differs from what it would be without them, which includes skipping a later modifier (a floor
 * keeps a capped item in For you); `never_soft:<id>` when it lowers the lane; `pending_cards` when
 * step 7 moves the item. `degraded` fires for every degraded item, and `llm_answer` for an `llm`
 * deciding answer, even when no cap changes the lane (§2). A lane cap never rewrites P, so a high
 * tier can sit in Everything after `seen_story`.
 *
 * @throws RangeError when `p` is not a probability.
 */
export function applyLanePolicy(
  input: LanePolicyInput,
  config: Pick<ReadonlyRankerConfig, 'lanes' | 'tiers' | 'llmForYouMin'>,
): LanePolicyResult {
  assertProbability(input.p);
  const outcome = modify(input, config);
  const changes = (other: Outcome) => other.lane !== outcome.lane || other.p !== outcome.p;
  const rules: FiredRule[] = [];
  if (outcome.applied === 'seen_story' && changes(modify({ ...input, seenStory: false }, config))) {
    rules.push({ code: RULE_CODES.seenStory });
  }
  if (input.source === 'degraded') rules.push({ code: RULE_CODES.degraded });
  if (outcome.applied === 'floor' && changes(modify({ ...input, floors: [] }, config))) {
    for (const floor of input.floors ?? []) rules.push(floorRule(floor));
  }
  if (outcome.neverSoftLowered !== null) {
    rules.push({ code: neverSoftCode(outcome.neverSoftLowered), cardId: outcome.neverSoftLowered });
  }
  if (input.decidingEngine === 'llm') rules.push({ code: RULE_CODES.llmAnswer });
  if (outcome.pendingCards) rules.push({ code: RULE_CODES.pendingCards });
  return { lane: outcome.lane, p: outcome.p, tier: tierFromP(outcome.p, config), rules };
}

/** The lane and P after steps 5–7, with what applied. */
interface Outcome {
  lane: ScoredLane;
  p: number;
  /** The branch of step 6 that ran; `caps` is step iv, also when neither cap holds. */
  applied: 'seen_story' | 'degraded' | 'floor' | 'caps';
  /** The never-card whose soft cap lowered the lane, if it did. */
  neverSoftLowered: string | null;
  pendingCards: boolean;
}

function modify(
  input: LanePolicyInput,
  config: Pick<ReadonlyRankerConfig, 'lanes' | 'llmForYouMin'>,
): Outcome {
  let p = input.p;
  const base = laneFromP(p, config);
  let lane = base;
  let applied: Outcome['applied'] = 'caps';
  let neverSoftLowered: string | null = null;
  const seenStory = input.seenStory === true;
  if (seenStory) {
    applied = 'seen_story';
    lane = minLane(lane, 'everything');
  } else if (input.source === 'degraded') {
    applied = 'degraded';
    lane = 'maybe';
  } else if ((input.floors ?? []).length > 0) {
    applied = 'floor';
    lane = 'for_you';
    p = Math.max(p, config.lanes.forYou);
  } else {
    const neverSoft = input.neverSoftCardId ?? null;
    if (neverSoft !== null) {
      lane = minLane(lane, 'maybe');
      if (lane !== base) neverSoftLowered = neverSoft;
    }
    if (input.decidingEngine === 'llm' && p < config.llmForYouMin) lane = minLane(lane, 'maybe');
  }
  const pendingCards = input.coverage !== 'complete' && lane === 'everything' && !seenStory;
  if (pendingCards) lane = 'maybe';
  return { lane, p, applied, neverSoftLowered, pendingCards };
}

function floorRule(floor: FloorTrigger): FiredRule {
  if (floor.kind === 'must') return { code: mustCode(floor.cardId), cardId: floor.cardId };
  const code = floor.kind === 'boost_feed' ? RULE_CODES.boostFeed : RULE_CODES.boostDomain;
  return floor.ruleId === undefined ? { code } : { code, ruleId: floor.ruleId };
}
