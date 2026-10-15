import type { ReadonlyRankerConfig } from '../config.js';
import type { RawFeatureSnapshot } from './features.js';
import { auc, groupedBootstrapCi } from './metrics.js';
import { baselineScore, type TrainingRow } from './train.js';

/** Thresholds of the per-feed agreement hint. */
export const FEED_AGREEMENT = {
  minEachClass: 3,
  oneSidedMinTotal: 10,
  oneSidedMaxShare: 0.15,
  /** Likes every card scored below `lanes.maybe` before a new card is suggested (D-241)… */
  uncoveredMin: 3,
  /** …and their least share of the feed's likes. */
  uncoveredMinShare: 0.3,
  /** The most recent uncovered likes a suggested card is drafted from. */
  uncoveredArticles: 5,
} as const;

/** Whether `count` uncovered likes among a feed's `likes` are enough to suggest a new card (D-241). */
export function uncoveredSuggests(count: number, likes: number): boolean {
  return count >= FEED_AGREEMENT.uncoveredMin && count >= FEED_AGREEMENT.uncoveredMinShare * likes;
}

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
  /**
   * Liked articles that every card scored below `lanes.maybe`, the "unexplained likes" of spec 06
   * §10 (D-241): their count, the most recent ones' ids (newest first) and whether there are enough
   * of them to suggest a new card. `items` lists all of them, newest first, with their rating time.
   */
  uncovered: {
    count: number;
    articleIds: string[];
    suggest: boolean;
    items: { articleId: string; at: Date }[];
  };
  /**
   * Topical dislikes (reason off-topic or none) that no held Never card scored at Maybe or above,
   * the "unwanted" articles a new Never card could catch: shaped like `uncovered`.
   */
  unwanted: {
    count: number;
    articleIds: string[];
    suggest: boolean;
    items: { articleId: string; at: Date }[];
  };
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

  const uncovered = mine
    .filter((r, i) => r.s.y === 1 && (scores[i] ?? 0) < cfg.lanes.maybe)
    .sort((a, b) => b.s.feedbackAt.getTime() - a.s.feedbackAt.getTime());

  const unwanted = mine
    .filter(
      (r) =>
        r.s.y === 0 &&
        (r.s.reason === undefined || r.s.reason === null || r.s.reason === 'off_topic') &&
        !(r.f?.cards ?? []).some(
          (card) => card.strength === 'never' && card.p !== null && card.p >= cfg.lanes.maybe,
        ),
    )
    .sort((a, b) => b.s.feedbackAt.getTime() - a.s.feedbackAt.getTime());

  const total = likes + dislikes;
  const enough = likes >= FEED_AGREEMENT.minEachClass && dislikes >= FEED_AGREEMENT.minEachClass;
  // Agreement decides once both classes are there: a small minority share only explains a feed
  // that is not ready yet, it never holds back one whose ratings the cards already separate.
  let status: FeedAgreementStatus;
  if (enough && low95 !== null && low95 >= cfg.model.minCvAuc) status = 'ready';
  else if (
    total >= FEED_AGREEMENT.oneSidedMinTotal &&
    Math.min(likes, dislikes) / total < FEED_AGREEMENT.oneSidedMaxShare
  ) {
    status = 'one_sided';
  } else if (!enough) status = 'collecting';
  else status = 'not_yet';

  return {
    status,
    likes,
    dislikes,
    auc: point,
    aucLow: low95,
    ratedHigh: { total: high.length, liked: high.filter((r) => r.s.y === 1).length },
    ratedLow: { total: low.length, disliked: low.filter((r) => r.s.y === 0).length },
    uncovered: {
      count: uncovered.length,
      articleIds: uncovered.slice(0, FEED_AGREEMENT.uncoveredArticles).map((r) => r.s.articleId),
      suggest: uncoveredSuggests(uncovered.length, likes),
      items: uncovered.map((r) => ({ articleId: r.s.articleId, at: r.s.feedbackAt })),
    },
    unwanted: {
      count: unwanted.length,
      articleIds: unwanted.slice(0, FEED_AGREEMENT.uncoveredArticles).map((r) => r.s.articleId),
      suggest: uncoveredSuggests(unwanted.length, dislikes),
      items: unwanted.map((r) => ({ articleId: r.s.articleId, at: r.s.feedbackAt })),
    },
  };
}
