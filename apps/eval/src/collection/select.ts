import { groupRank } from '../dataset/split.js';

/**
 * Drawing one language's sample (spec 10 §2.1): up to `target` articles, stratified across feeds and
 * collection days, with no feed above `feedCapShare` of the language sample. The cap is a share of
 * the sample actually drawn, so when a language runs short the sample shrinks to the largest size
 * the feeds can fill under the cap instead of letting one prolific feed replace source diversity;
 * the result reports the availability per feed.
 *
 * Pure and seeded: the same candidates, existing rows, target, cap and seed give the same selection.
 * Rows already in the version (an earlier run of `eval sample` on an open version) are kept and
 * count toward their feed's quota; the draw only adds.
 */

export interface SelectItem {
  articleId: string;
  feedId: string;
  /** Collection day (UTC `YYYY-MM-DD` of `first_seen_at`). */
  day: string;
}

export interface SelectInput {
  /** Eligible articles not yet in the version. */
  fresh: readonly SelectItem[];
  /** Articles already in the version for this language (feedId may be unknown: `''`). */
  existing: readonly SelectItem[];
  target: number;
  /** Largest share of the language sample one feed may hold (spec 10 §2.1: 0.10). */
  feedCapShare: number;
  seed: string;
}

export interface FeedAvailability {
  feedId: string;
  /** Eligible articles (existing + fresh). */
  available: number;
  existing: number;
  /** Final count in the sample (existing + added). */
  selected: number;
}

export interface SelectResult {
  /** Fresh articles to add, in the seeded order of the draw. */
  added: string[];
  /** The language sample size after the draw. */
  size: number;
  /** The per-feed cap at that size. */
  cap: number;
  available: number;
  feeds: FeedAvailability[];
  /** Selected articles per collection day (existing + added). */
  days: Record<string, number>;
}

/** The cap for a sample of size `n`. */
export function feedCap(n: number, share: number): number {
  return Math.floor(share * n + 1e-9);
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The largest sample size in `[existingTotal, target]` that the feeds can fill when each holds at
 * most the cap of that size (a feed already above it keeps its existing rows).
 */
export function feasibleSize(
  feeds: readonly { available: number; existing: number }[],
  target: number,
  share: number,
): number {
  const existingTotal = feeds.reduce((s, f) => s + f.existing, 0);
  const totalAvailable = feeds.reduce((s, f) => s + f.available, 0);
  for (let n = Math.min(target, totalAvailable); n > existingTotal; n -= 1) {
    const cap = feedCap(n, share);
    const fill = feeds.reduce((s, f) => s + Math.min(f.available, Math.max(f.existing, cap)), 0);
    if (fill >= n) return n;
  }
  return existingTotal;
}

export function selectLanguageSample(input: SelectInput): SelectResult {
  const { seed } = input;
  const feedIds = [...new Set([...input.fresh, ...input.existing].map((i) => i.feedId))].sort(
    byKey,
  );
  const freshByFeed = new Map<string, SelectItem[]>();
  for (const item of input.fresh) {
    const list = freshByFeed.get(item.feedId) ?? [];
    list.push(item);
    freshByFeed.set(item.feedId, list);
  }
  const existingByFeed = new Map<string, SelectItem[]>();
  for (const item of input.existing) {
    const list = existingByFeed.get(item.feedId) ?? [];
    list.push(item);
    existingByFeed.set(item.feedId, list);
  }
  const stats = feedIds.map((feedId) => {
    const existing = existingByFeed.get(feedId)?.length ?? 0;
    return { feedId, existing, available: existing + (freshByFeed.get(feedId)?.length ?? 0) };
  });
  const size = feasibleSize(stats, input.target, input.feedCapShare);
  const cap = feedCap(size, input.feedCapShare);

  // Water-filling: one more article at a time to the feed holding the fewest, ties broken by a
  // seeded feed order, until the size is reached. No feed goes above max(cap, its existing rows).
  const quota = new Map(stats.map((s) => [s.feedId, s.existing]));
  const limit = new Map(
    stats.map((s) => [s.feedId, Math.min(s.available, Math.max(s.existing, cap))]),
  );
  const feedOrder = new Map(feedIds.map((id) => [id, groupRank(seed, `feed:${id}`)]));
  let remaining = size - input.existing.length;
  while (remaining > 0) {
    let best: string | null = null;
    for (const feedId of feedIds) {
      const q = quota.get(feedId) ?? 0;
      if (q >= (limit.get(feedId) ?? 0)) continue;
      if (best === null) {
        best = feedId;
        continue;
      }
      const qb = quota.get(best) ?? 0;
      if (q < qb || (q === qb && (feedOrder.get(feedId) ?? 0) < (feedOrder.get(best) ?? 0))) {
        best = feedId;
      }
    }
    if (best === null) break;
    quota.set(best, (quota.get(best) ?? 0) + 1);
    remaining -= 1;
  }

  // Within a feed, spread the additions over collection days: always take from the day holding the
  // fewest of this feed's selected articles (earlier day first), in the seeded order of the day.
  const added: string[] = [];
  const days: Record<string, number> = {};
  for (const item of input.existing) days[item.day] = (days[item.day] ?? 0) + 1;
  for (const feedId of feedIds) {
    const want = (quota.get(feedId) ?? 0) - (existingByFeed.get(feedId)?.length ?? 0);
    if (want <= 0) continue;
    const pools = new Map<string, SelectItem[]>();
    for (const item of freshByFeed.get(feedId) ?? []) {
      const list = pools.get(item.day) ?? [];
      list.push(item);
      pools.set(item.day, list);
    }
    for (const list of pools.values()) {
      list.sort(
        (a, b) =>
          groupRank(seed, a.articleId) - groupRank(seed, b.articleId) ||
          byKey(a.articleId, b.articleId),
      );
    }
    const taken = new Map<string, number>();
    for (const item of existingByFeed.get(feedId) ?? []) {
      taken.set(item.day, (taken.get(item.day) ?? 0) + 1);
    }
    const dayKeys = [...pools.keys()].sort(byKey);
    for (let i = 0; i < want; i += 1) {
      let day: string | null = null;
      for (const key of dayKeys) {
        if ((pools.get(key)?.length ?? 0) === 0) continue;
        if (day === null || (taken.get(key) ?? 0) < (taken.get(day) ?? 0)) day = key;
      }
      if (day === null) break;
      const item = pools.get(day)?.shift();
      if (item === undefined) break;
      taken.set(day, (taken.get(day) ?? 0) + 1);
      days[day] = (days[day] ?? 0) + 1;
      added.push(item.articleId);
    }
  }

  return {
    added,
    size: input.existing.length + added.length,
    cap,
    available: stats.reduce((s, f) => s + f.available, 0),
    feeds: stats.map((s) => ({ ...s, selected: quota.get(s.feedId) ?? s.existing })),
    days,
  };
}
