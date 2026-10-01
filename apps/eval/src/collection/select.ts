import { groupRank } from '../dataset/split.js';

/**
 * Drawing one language's sample (spec 10 §2.1): up to `target` articles, stratified across feeds and
 * collection days, with no feed above `feedCapShare` of the language sample. The cap holds for every
 * feed that carries a selected article, not only the feed that carried it first, so a prolific feed
 * that syndicates many other feeds' stories cannot exceed it either (D-98). The cap is a share of
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
  /** The feed that carried it first: the stratum of the draw. */
  feedId: string;
  /** Every golden feed carrying it (`feedId` included); each one's count is capped. */
  carriers?: readonly string[];
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

/** Per feed, counting every article the feed carries (not only those it carried first). */
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

const carriersOf = (item: SelectItem): readonly string[] =>
  item.carriers === undefined || item.carriers.length === 0
    ? [item.feedId]
    : item.carriers.includes(item.feedId)
      ? item.carriers
      : [item.feedId, ...item.carriers];

export function selectLanguageSample(input: SelectInput): SelectResult {
  const { seed } = input;
  // Strata: the feed that carried each article first.
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
  // Carrier counts: every feed carrying an article counts it.
  const carrierAvailable = new Map<string, number>();
  const carrierExisting = new Map<string, number>();
  for (const item of input.existing) {
    for (const c of carriersOf(item)) {
      carrierExisting.set(c, (carrierExisting.get(c) ?? 0) + 1);
      carrierAvailable.set(c, (carrierAvailable.get(c) ?? 0) + 1);
    }
  }
  for (const item of input.fresh) {
    for (const c of carriersOf(item)) carrierAvailable.set(c, (carrierAvailable.get(c) ?? 0) + 1);
  }

  // Within a feed, the seeded order of each collection day's articles.
  const sortedPools = new Map<string, Map<string, SelectItem[]>>();
  for (const feedId of feedIds) {
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
    sortedPools.set(feedId, pools);
  }
  const feedOrder = new Map(feedIds.map((id) => [id, groupRank(seed, `feed:${id}`)]));

  /**
   * One draw of size `n`: water-filling, one article at a time from the stratum whose feed carries
   * the fewest selected articles (ties by a seeded feed order); within it, from the collection day
   * holding the fewest of its selected articles (earlier day first), in the day's seeded order.
   * An article is taken only when every feed carrying it stays within max(cap, its existing rows).
   */
  const draw = (n: number, exclusiveFirst: boolean) => {
    const cap = feedCap(n, input.feedCapShare);
    const limitOf = (feedId: string) => Math.max(cap, carrierExisting.get(feedId) ?? 0);
    const count = new Map(carrierExisting);
    const fits = (item: SelectItem) =>
      carriersOf(item).every((c) => (count.get(c) ?? 0) < limitOf(c));
    const pools = new Map(
      [...sortedPools].map(([feedId, byDay]) => [
        feedId,
        new Map([...byDay].map(([day, list]) => [day, [...list]])),
      ]),
    );
    const taken = new Map<string, Map<string, number>>();
    for (const item of input.existing) {
      const perDay = taken.get(item.feedId) ?? new Map<string, number>();
      perDay.set(item.day, (perDay.get(item.day) ?? 0) + 1);
      taken.set(item.feedId, perDay);
    }
    // The next article a stratum would give, dropping those that no longer fit (counts only grow).
    // Among the articles that fit, the one with the fewest carriers comes first, so an article
    // shared with another feed does not use up that feed's room while an exclusive one is left; in
    // `exclusiveFirst` mode that preference outranks the day spread.
    const next = (feedId: string): { day: string; index: number; item: SelectItem } | null => {
      const byDay = pools.get(feedId);
      if (byDay === undefined) return null;
      const perDay = taken.get(feedId);
      const days = [...byDay.keys()].sort(
        (a, b) => (perDay?.get(a) ?? 0) - (perDay?.get(b) ?? 0) || byKey(a, b),
      );
      let found: { day: string; index: number; item: SelectItem } | null = null;
      for (const day of days) {
        const list = byDay.get(day) ?? [];
        for (let i = list.length - 1; i >= 0; i -= 1) if (!fits(list[i]!)) list.splice(i, 1);
        if (list.length === 0) {
          byDay.delete(day);
          continue;
        }
        let index = 0;
        for (let i = 1; i < list.length; i += 1) {
          if (carriersOf(list[i]!).length < carriersOf(list[index]!).length) index = i;
        }
        const item = list[index]!;
        if (found === null || carriersOf(item).length < carriersOf(found.item).length) {
          found = { day, index, item };
        }
        if (!exclusiveFirst || carriersOf(item).length === 1) break;
      }
      return found;
    };
    const added: string[] = [];
    const days: Record<string, number> = {};
    for (const item of input.existing) days[item.day] = (days[item.day] ?? 0) + 1;
    let remaining = n - input.existing.length;
    while (remaining > 0) {
      let best: { feedId: string; day: string; index: number; item: SelectItem } | null = null;
      for (const feedId of feedIds) {
        const candidate = next(feedId);
        if (candidate === null) continue;
        if (best === null) {
          best = { feedId, ...candidate };
          continue;
        }
        const q = count.get(feedId) ?? 0;
        const qb = count.get(best.feedId) ?? 0;
        if (
          q < qb ||
          (q === qb && (feedOrder.get(feedId) ?? 0) < (feedOrder.get(best.feedId) ?? 0))
        ) {
          best = { feedId, ...candidate };
        }
      }
      if (best === null) break;
      pools.get(best.feedId)?.get(best.day)?.splice(best.index, 1);
      for (const c of carriersOf(best.item)) count.set(c, (count.get(c) ?? 0) + 1);
      const perDay = taken.get(best.feedId) ?? new Map<string, number>();
      perDay.set(best.day, (perDay.get(best.day) ?? 0) + 1);
      taken.set(best.feedId, perDay);
      days[best.day] = (days[best.day] ?? 0) + 1;
      added.push(best.item.articleId);
      remaining -= 1;
    }
    return { cap, added, days, count };
  };

  // The largest size the strata could fill under the cap bounds the draw; when the feeds that also
  // carry articles block it, shrink to what the draw reached (the cap of a smaller size is no
  // larger) until a draw fills its size.
  const strata = feedIds.map((feedId) => {
    const existing = existingByFeed.get(feedId)?.length ?? 0;
    return { existing, available: existing + (freshByFeed.get(feedId)?.length ?? 0) };
  });
  const freshById = new Map(input.fresh.map((item) => [item.articleId, item]));
  /**
   * Repairs a draw that fell short of `n` with augmenting swaps: an unchosen article blocked by a
   * single full feed replaces a chosen article of that feed when a third article then fits too,
   * one more each time (an article with two strata-feeds of room, `{A,Y}` for `{A,X}`, frees `X`
   * for `{B,X}`). Exact packing under several caps is NP-hard, so the search is bounded; the cap
   * itself is never exceeded.
   */
  const augment = (n: number, result: ReturnType<typeof draw>) => {
    const limitOf = (feedId: string) => Math.max(result.cap, carrierExisting.get(feedId) ?? 0);
    const count = new Map(result.count);
    const chosen = new Set(result.added);
    const days = { ...result.days };
    const fits = (item: SelectItem) =>
      carriersOf(item).every((c) => (count.get(c) ?? 0) < limitOf(c));
    const shift = (item: SelectItem, delta: 1 | -1) => {
      for (const c of carriersOf(item)) count.set(c, (count.get(c) ?? 0) + delta);
      days[item.day] = (days[item.day] ?? 0) + delta;
      if (delta === 1) chosen.add(item.articleId);
      else chosen.delete(item.articleId);
    };
    const order = [...input.fresh].sort(
      (a, b) =>
        groupRank(seed, a.articleId) - groupRank(seed, b.articleId) ||
        byKey(a.articleId, b.articleId),
    );
    let budget = 2_000_000;
    let improved = true;
    while (improved && input.existing.length + chosen.size < n && budget > 0) {
      improved = false;
      search: for (const c of order) {
        if (chosen.has(c.articleId)) continue;
        if (fits(c)) {
          shift(c, 1);
          improved = true;
          break;
        }
        const full = carriersOf(c).filter((f) => (count.get(f) ?? 0) >= limitOf(f));
        if (full.length !== 1) continue;
        for (const id of [...chosen]) {
          budget -= 1;
          const s = freshById.get(id);
          if (s === undefined || !carriersOf(s).includes(full[0]!)) continue;
          shift(s, -1);
          if (fits(c)) {
            shift(c, 1);
            for (const t of order) {
              budget -= 1;
              if (t === s || chosen.has(t.articleId) || !fits(t)) continue;
              shift(t, 1);
              improved = true;
              break search;
            }
            shift(c, -1);
          }
          shift(s, 1);
          if (budget <= 0) break search;
        }
      }
    }
    const drawn = new Set(result.added);
    const added = [
      ...result.added.filter((id) => chosen.has(id)),
      ...order
        .filter((i) => chosen.has(i.articleId) && !drawn.has(i.articleId))
        .map((i) => i.articleId),
    ];
    return { cap: result.cap, added, days, count };
  };
  // Each size gets a second, exclusive-first attempt and then the augmenting repair before it is
  // given up.
  const attempt = (size: number) => {
    const spread = draw(size, false);
    if (input.existing.length + spread.added.length >= size) return spread;
    const exclusive = draw(size, true);
    if (input.existing.length + exclusive.added.length >= size) return exclusive;
    return augment(size, exclusive);
  };
  let n = feasibleSize(strata, input.target, input.feedCapShare);
  let result = attempt(n);
  while (input.existing.length + result.added.length < n) {
    n = Math.min(n - 1, input.existing.length + result.added.length);
    result = attempt(n);
  }

  const allFeeds = [...carrierAvailable.keys()].sort(byKey);
  return {
    added: result.added,
    size: input.existing.length + result.added.length,
    cap: result.cap,
    available: input.existing.length + input.fresh.length,
    feeds: allFeeds.map((feedId) => ({
      feedId,
      available: carrierAvailable.get(feedId) ?? 0,
      existing: carrierExisting.get(feedId) ?? 0,
      selected: result.count.get(feedId) ?? 0,
    })),
    days: result.days,
  };
}
