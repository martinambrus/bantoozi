import type { DatasetSplit } from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';

/**
 * The development/test split (spec 10 §2.1): deterministic, 70 % development, stratified by
 * language and grouped by story, so every copy of a story (duplicates, and every rater's copy) is on
 * one side. Groups already in the version keep their side; new groups fill each language toward
 * 70 % of its articles (not of its groups, so one large duplicated story cannot unbalance the
 * sides) in the order of a seeded hash, so a top-up never moves an item and keeps the balance.
 */
export const DEV_SHARE = 0.7;

export interface SplitItem {
  articleId: string;
  lang: string;
  storyGroupId: string;
}

/** A group's position in the seeded order, in [0, 1). */
export function groupRank(seed: string, groupId: string): number {
  return Number.parseInt(sha256Hex(`${seed}\u0000${groupId}`).slice(0, 13), 16) / 2 ** 52;
}

/**
 * The groups (in `ordered`) whose sizes sum nearest `target` (ties: the smaller sum). `from[sum]` is
 * the first group, in order, that made `sum` reachable; walking it back yields one such subset.
 */
export function chooseDevGroups(
  ordered: readonly string[],
  size: (groupId: string) => number,
  target: number,
): string[] {
  const total = ordered.reduce((sum, groupId) => sum + size(groupId), 0);
  const from = new Int32Array(total + 1).fill(-1);
  const reachable = new Uint8Array(total + 1);
  reachable[0] = 1;
  ordered.forEach((groupId, index) => {
    const n = size(groupId);
    if (n <= 0) return;
    for (let sum = total; sum >= n; sum -= 1) {
      if (reachable[sum] === 0 && reachable[sum - n] === 1) {
        reachable[sum] = 1;
        from[sum] = index;
      }
    }
  });
  let best = 0;
  for (let sum = 0; sum <= total; sum += 1) {
    if (reachable[sum] === 1 && Math.abs(sum - target) < Math.abs(best - target)) best = sum;
  }
  const chosen: string[] = [];
  for (let sum = best; sum > 0;) {
    const groupId = ordered[from[sum] ?? -1];
    if (groupId === undefined) throw new Error(`split: no group reaches ${sum}`);
    chosen.push(groupId);
    sum -= size(groupId);
  }
  return chosen;
}

const byNumericId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Assign a split to every item. `known` holds the groups already in the version (their side is
 * final); `knownCounts` the number of articles of known groups per language (a group's language is
 * that of its oldest article) and side, for the balance; `knownLang` each known group's language,
 * so a new copy in another language is charged to the group's original language.
 */
export function assignSplits(
  items: readonly SplitItem[],
  seed: string,
  known: ReadonlyMap<string, DatasetSplit> = new Map(),
  knownCounts: ReadonlyMap<string, { dev: number; test: number }> = new Map(),
  knownLang: ReadonlyMap<string, string> = new Map(),
): Map<string, DatasetSplit> {
  // A new group's language is that of its oldest article (lowest id).
  const groups = new Map<string, SplitItem[]>();
  for (const item of items) {
    const list = groups.get(item.storyGroupId) ?? [];
    list.push(item);
    groups.set(item.storyGroupId, list);
  }
  const fresh = new Map<string, string[]>();
  const decided = new Map<string, DatasetSplit>();
  const counts = new Map<string, { dev: number; test: number }>();
  for (const [lang, known] of knownCounts) counts.set(lang, { ...known });
  for (const [groupId, members] of groups) {
    const oldest = [...members].sort((a, b) => byNumericId(a.articleId, b.articleId))[0];
    if (oldest === undefined) continue;
    const side = known.get(groupId);
    if (side !== undefined) {
      // New copies of a known story keep its side and count toward its language's balance.
      decided.set(groupId, side);
      const lang = knownLang.get(groupId) ?? oldest.lang;
      const langCounts = counts.get(lang) ?? { dev: 0, test: 0 };
      langCounts[side] += members.length;
      counts.set(lang, langCounts);
      continue;
    }
    const list = fresh.get(oldest.lang) ?? [];
    list.push(groupId);
    fresh.set(oldest.lang, list);
  }
  for (const [lang, groupIds] of fresh) {
    const langCounts = counts.get(lang) ?? { dev: 0, test: 0 };
    const size = (groupId: string) => groups.get(groupId)?.length ?? 0;
    const freshArticles = groupIds.reduce((sum, groupId) => sum + size(groupId), 0);
    const wantDev = Math.round(DEV_SHARE * (langCounts.dev + langCounts.test + freshArticles));
    const ordered = [...groupIds].sort(
      (a, b) => groupRank(seed, a) - groupRank(seed, b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    // Whole groups: the subset whose article count lands nearest the development target (ties: the
    // smaller count), chosen with a 0/1 knapsack over the seeded order, so among equal sums the
    // groups that reach it first in that order win and the choice is deterministic.
    for (const groupId of chooseDevGroups(ordered, size, wantDev - langCounts.dev)) {
      decided.set(groupId, 'dev');
    }
    for (const groupId of ordered) if (!decided.has(groupId)) decided.set(groupId, 'test');
  }
  const result = new Map<string, DatasetSplit>();
  for (const item of items) {
    const side = decided.get(item.storyGroupId);
    if (side === undefined) throw new Error(`no split for group ${item.storyGroupId}`);
    result.set(item.articleId, side);
  }
  return result;
}
