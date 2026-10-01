import type { Lane } from '@bantoozi/shared';

/**
 * The lane distribution of each class (spec 10 §4 "Policy"): the shares of liked and of disliked
 * items placed in For You, Maybe, Everything, Hidden and New. Each rated item is in exactly one
 * lane per rater, so each class's counts sum to its denominator; this shows one-sided failures
 * (liked items piling up in Everything) that AUC hides.
 */
export const REPORT_LANES = [
  'for_you',
  'maybe',
  'everything',
  'hidden',
  'new',
] as const satisfies readonly Lane[];
export type ReportLane = (typeof REPORT_LANES)[number];

export interface ClassLaneDistribution {
  n: number;
  counts: Record<ReportLane, number>;
  /** `null` shares when the class is empty. */
  shares: Record<ReportLane, number | null>;
}

export interface LaneDistribution {
  liked: ClassLaneDistribution;
  disliked: ClassLaneDistribution;
}

function distribution(lanes: readonly ReportLane[]): ClassLaneDistribution {
  const counts = Object.fromEntries(REPORT_LANES.map((lane) => [lane, 0])) as Record<
    ReportLane,
    number
  >;
  for (const lane of lanes) counts[lane] += 1;
  const n = lanes.length;
  const shares = Object.fromEntries(
    REPORT_LANES.map((lane) => [lane, n === 0 ? null : counts[lane] / n]),
  ) as Record<ReportLane, number | null>;
  return { n, counts, shares };
}

export function laneDistribution(
  items: readonly { liked: boolean; lane: ReportLane }[],
): LaneDistribution {
  return {
    liked: distribution(items.filter((item) => item.liked).map((item) => item.lane)),
    disliked: distribution(items.filter((item) => !item.liked).map((item) => item.lane)),
  };
}

export interface PolicySummary {
  /** Like-rate among items in For You; null when For You is empty. */
  forYouPrecision: number | null;
  /** Share of liked items placed in For You. */
  forYouCoverage: number | null;
  /** Share of all items placed in Maybe. */
  maybeShare: number | null;
  /** Hard-hide false negatives: liked items hidden / all liked items. */
  hardHideFalseNegativeRate: number | null;
  /** Share of liked items placed in Everything (an explicit owner-review item). */
  likedInEverything: number | null;
  forYou: number;
  total: number;
  distribution: LaneDistribution;
}

/** For You precision/coverage, Maybe share, hard-hide false negatives and the class distribution. */
export function policySummary(
  items: readonly { liked: boolean; lane: ReportLane }[],
): PolicySummary {
  const dist = laneDistribution(items);
  const forYou = items.filter((item) => item.lane === 'for_you');
  const total = items.length;
  return {
    forYouPrecision:
      forYou.length === 0 ? null : forYou.filter((item) => item.liked).length / forYou.length,
    forYouCoverage: dist.liked.shares.for_you,
    maybeShare: total === 0 ? null : items.filter((item) => item.lane === 'maybe').length / total,
    hardHideFalseNegativeRate: dist.liked.shares.hidden,
    likedInEverything: dist.liked.shares.everything,
    forYou: forYou.length,
    total,
    distribution: dist,
  };
}
