/** `publish_stats.recent_gaps_s` covers the newest 20 distinct publication instants (spec 03 §7). */
const MAX_PUBLICATIONS = 20;

/**
 * `feeds.publish_stats.recent_gaps_s` (spec 03 §7, §9; spec 02 `feeds.publish_stats`): the gaps,
 * in whole seconds and newest first, between consecutive values of the newest ≤ 20 distinct valid
 * `published_at` instants. Instants are truncated to whole seconds before deduplication; `null`
 * and invalid dates are skipped, and input order does not matter. Because the instants are
 * distinct and sorted, every gap is positive (zero and negative gaps cannot occur), so the result
 * has at most 19 entries.
 */
export function recentGapsS(publishedAt: ReadonlyArray<Date | null>): number[] {
  const seconds = new Set<number>();
  for (const date of publishedAt) {
    if (!(date instanceof Date)) continue;
    const ms = date.getTime();
    if (Number.isFinite(ms)) seconds.add(Math.floor(ms / 1000));
  }
  const newest = [...seconds].sort((a, b) => b - a).slice(0, MAX_PUBLICATIONS);
  const gaps: number[] = [];
  let previous: number | undefined;
  for (const s of newest) {
    if (previous !== undefined) gaps.push(previous - s);
    previous = s;
  }
  return gaps;
}

/** Median of a list (`NaN` when empty); the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? Number.NaN;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? Number.NaN) + upper) / 2;
}
