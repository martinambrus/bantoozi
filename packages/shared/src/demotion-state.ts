/**
 * The auto-demotion state of spec 06 §5, derived from the user's current dislikes. It lives here
 * (pure, no I/O) because both the rank handler (to build `UserRankContext`) and the reader actions
 * (to decide which rows a rating change makes due, and whether it flips an activation) need the
 * same function.
 */

/** Quality flags (spec 06 §5). */
export const DEMOTION_FLAGS = ['clickbait', 'promotional', 'shallow', 'stale'] as const;
export type DemotionFlag = (typeof DEMOTION_FLAGS)[number];

/** Dislike reasons (`user_article.reason`, spec 06 §1). */
export type DislikeReason = 'clickbait' | 'promo' | 'shallow' | 'seen' | 'off_topic' | 'other';

/** The dislike reason that drives a flag's `auto` activation; `stale` uses the stale-at-feedback count. */
export const DEMOTION_FLAG_REASON: Readonly<Record<Exclude<DemotionFlag, 'stale'>, DislikeReason>> =
  {
    clickbait: 'clickbait',
    promotional: 'promo',
    shallow: 'shallow',
  };

/** One current dislike inside the auto-demotion window. */
export interface DislikeSample {
  reason: string | null;
  ratedAt: Date;
  /** The feedback-time stale status of the rating in effect; null when unknown. */
  staleAtFeedback: boolean | null;
}

export interface DemotionStateConfig {
  autoMinDislikes: number;
  autoWindowDays: number;
}

export interface DemotionState {
  /** Current distinct disliked articles per reason in the window. */
  reasonCounts90d: Partial<Record<DislikeReason, number>>;
  /** Dislikes (any reason) on items that were stale when rated, in the same window. */
  staleDislikes90d: number;
  /** Per `auto` flag, the time its count falls below `autoMinDislikes` as dislikes leave the window. */
  demotionDeadlines: Partial<Record<DemotionFlag, Date>>;
}

const DAY_MS = 86_400_000;

/**
 * Counts per reason, the stale-at-feedback count, and per flag the time its count falls below
 * `autoMinDislikes` as the oldest qualifying dislike leaves the window (`next_rank_at`, §7 step 5).
 */
export function demotionStateOf(
  dislikes: readonly DislikeSample[],
  config: DemotionStateConfig,
): DemotionState {
  const { autoMinDislikes, autoWindowDays } = config;
  const windowMs = autoWindowDays * DAY_MS;
  const reasonCounts: Partial<Record<DislikeReason, number>> = {};
  for (const dislike of dislikes) {
    if (dislike.reason === null) continue;
    const reason = dislike.reason as DislikeReason;
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const qualifying: Record<DemotionFlag, DislikeSample[]> = {
    clickbait: dislikes.filter((d) => d.reason === 'clickbait'),
    promotional: dislikes.filter((d) => d.reason === 'promo'),
    shallow: dislikes.filter((d) => d.reason === 'shallow'),
    stale: dislikes.filter((d) => d.staleAtFeedback === true),
  };
  const deadlines: Partial<Record<DemotionFlag, Date>> = {};
  for (const flag of DEMOTION_FLAGS) {
    const rows = [...qualifying[flag]].sort((a, b) => a.ratedAt.getTime() - b.ratedAt.getTime());
    if (rows.length < autoMinDislikes) continue;
    // Below the minimum once all but `autoMinDislikes − 1` of them have aged out.
    const pivot = rows[rows.length - autoMinDislikes];
    if (pivot !== undefined) deadlines[flag] = new Date(pivot.ratedAt.getTime() + windowMs);
  }
  return {
    reasonCounts90d: reasonCounts,
    staleDislikes90d: qualifying.stale.length,
    demotionDeadlines: deadlines,
  };
}

/** Whether `flag`'s count reaches `autoMinDislikes` in `state` (the `auto` activation of §5). */
export function autoFlagCounts(
  flag: DemotionFlag,
  state: Pick<DemotionState, 'reasonCounts90d' | 'staleDislikes90d'>,
  autoMinDislikes: number,
): boolean {
  const count =
    flag === 'stale'
      ? state.staleDislikes90d
      : (state.reasonCounts90d[DEMOTION_FLAG_REASON[flag]] ?? 0);
  return count >= autoMinDislikes;
}
