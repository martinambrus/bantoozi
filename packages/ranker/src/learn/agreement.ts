import type { ReadonlyRankerConfig } from '../config.js';
import type { RawFeatureSnapshot } from './features.js';
import { auc, groupedBootstrapCi } from './metrics.js';
import { baselineScore, type TrainingRow } from './train.js';

/** Thresholds of the per-feed agreement hint. */
export const FEED_AGREEMENT = {
  minEachClass: 3,
  oneSidedMinTotal: 10,
  oneSidedMaxShare: 0.15,
} as const;

/** Explicit rating counts, as the trainer counts them. */
export function learningCounts(rows: readonly TrainingRow[]): {
  explicit: number;
  likes: number;
  dislikes: number;
} {
  const explicit = rows.filter((r) => r.s.explicit);
  const likes = explicit.filter((r) => r.s.y === 1).length;
  return { explicit: explicit.length, likes, dislikes: explicit.length - likes };
}

/** The feeds a stored snapshot was classified for: the manifest's, else its source feed. */
export function sampleFeedIds(f: RawFeatureSnapshot | null): string[] {
  if (f === null) return [];
  const manifest: unknown = (f as unknown as { sourceManifest?: unknown }).sourceManifest;
  if (typeof manifest === 'object' && manifest !== null) {
    const ids: unknown = (manifest as { inferenceFeedIds?: unknown }).inferenceFeedIds;
    if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) return ids as string[];
  }
  const source = f.values.sourceFeedId;
  return source === null || source === undefined ? [] : [source];
}

export type FeedAgreementStatus = 'collecting' | 'ready' | 'not_yet' | 'one_sided';

/** How well the interest-card score agrees with a user's explicit ratings of one feed. */
export function feedAgreement(
  rows: readonly TrainingRow[],
  feedId: string,
  cfg: ReadonlyRankerConfig,
  seed: string,
): {
  status: FeedAgreementStatus;
  likes: number;
  dislikes: number;
  auc: number | null;
  aucLow: number | null;
  ratedHigh: { total: number; liked: number };
  ratedLow: { total: number; disliked: number };
} {
  const mine = rows.filter((r) => r.s.explicit && sampleFeedIds(r.f).includes(feedId));
  const scores = mine.map((r) => baselineScore(r, cfg));
  const y = mine.map((r) => r.s.y);
  const { likes, dislikes } = learningCounts(mine);
  const high = mine.filter((_, i) => (scores[i] ?? 0) >= cfg.lanes.forYou);
  const low = mine.filter((_, i) => (scores[i] ?? 0) < cfg.lanes.forYou);
  const point = auc(scores, y);
  const low95 =
    groupedBootstrapCi(
      mine.map((r) => r.s.groupId),
      (m) => auc(scores, y, m),
      seed,
    )?.[0] ?? null;

  const total = likes + dislikes;
  let status: FeedAgreementStatus;
  if (
    total >= FEED_AGREEMENT.oneSidedMinTotal &&
    Math.min(likes, dislikes) / total < FEED_AGREEMENT.oneSidedMaxShare
  ) {
    status = 'one_sided';
  } else if (likes < FEED_AGREEMENT.minEachClass || dislikes < FEED_AGREEMENT.minEachClass) {
    status = 'collecting';
  } else if (low95 !== null && low95 >= cfg.model.minCvAuc) status = 'ready';
  else status = 'not_yet';

  return {
    status,
    likes,
    dislikes,
    auc: point,
    aucLow: low95,
    ratedHigh: { total: high.length, liked: high.filter((r) => r.s.y === 1).length },
    ratedLow: { total: low.length, disliked: low.filter((r) => r.s.y === 0).length },
  };
}
