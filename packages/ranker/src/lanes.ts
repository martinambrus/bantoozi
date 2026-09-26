import type { Lane } from '@bantoozi/shared';

import type { ReadonlyRankerConfig } from './config.js';
import type { Tier } from './types.js';

/**
 * Lane order for "at most" and "at least" (spec 06 §2): `hidden < everything < maybe < for_you`.
 * `new` (no score yet) is outside the order.
 */
export const LANE_ORDER = [
  'hidden',
  'everything',
  'maybe',
  'for_you',
] as const satisfies readonly Lane[];

export type OrderedLane = (typeof LANE_ORDER)[number];

/** The lanes a probability maps to (§6.1); `hidden` needs a rule and `new` means no score. */
export type ScoredLane = Exclude<OrderedLane, 'hidden'>;

function laneRank(lane: OrderedLane): number {
  const rank = LANE_ORDER.indexOf(lane);
  if (rank < 0) throw new RangeError(`lane ${String(lane)} has no order`);
  return rank;
}

/** Compares two lanes in {@link LANE_ORDER}: negative when `a` is below `b`. */
export function compareLanes(a: OrderedLane, b: OrderedLane): number {
  return laneRank(a) - laneRank(b);
}

/** The lower of two lanes: `min(lane, 'maybe')` caps a lane at Maybe (§2 step 6). */
export function minLane<L extends OrderedLane>(a: L, b: L): L {
  return compareLanes(a, b) <= 0 ? a : b;
}

/** The higher of two lanes. */
export function maxLane<L extends OrderedLane>(a: L, b: L): L {
  return compareLanes(a, b) >= 0 ? a : b;
}

/** Whether `p` is a finite probability in [0, 1]. */
export function isProbability(p: unknown): p is number {
  return typeof p === 'number' && p >= 0 && p <= 1;
}

/** @throws RangeError unless `p` is a finite probability in [0, 1]. */
export function assertProbability(p: number, name = 'p'): void {
  if (!isProbability(p)) throw new RangeError(`${name} must be a probability in [0, 1]`);
}

/**
 * `laneFromP(P)` (spec 06 §6.1): `for_you` when `P ≥ lanes.forYou`, `maybe` when
 * `P ≥ lanes.maybe`, otherwise `everything`. The boundaries come from the config only.
 *
 * @throws RangeError when `p` is not a probability (invalid values are unknown, never a lane).
 */
export function laneFromP(p: number, config: Pick<ReadonlyRankerConfig, 'lanes'>): ScoredLane {
  assertProbability(p);
  if (p >= config.lanes.forYou) return 'for_you';
  if (p >= config.lanes.maybe) return 'maybe';
  return 'everything';
}

/**
 * `tierFromP(P)` (spec 06 §6.1): one plus the number of `tiers` boundaries at or below `P`, so with
 * the defaults 5 when `P ≥ 0.85`, 4 when `≥ 0.65`, 3 when `≥ 0.45`, 2 when `≥ 0.25`, otherwise 1.
 * `null` when `P` is null.
 *
 * @throws RangeError when `p` is neither null nor a probability.
 */
export function tierFromP(p: number, config: Pick<ReadonlyRankerConfig, 'tiers'>): Tier;
export function tierFromP(
  p: number | null,
  config: Pick<ReadonlyRankerConfig, 'tiers'>,
): Tier | null;
export function tierFromP(
  p: number | null,
  config: Pick<ReadonlyRankerConfig, 'tiers'>,
): Tier | null {
  if (p === null) return null;
  assertProbability(p);
  let tier = 1;
  for (const boundary of config.tiers) if (p >= boundary) tier += 1;
  return tier as Tier;
}
