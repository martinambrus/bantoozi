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

const byNumericId = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Assign a split to every item. `known` holds the groups already in the version (their side is
 * final); `knownCounts` the number of articles of known groups per language (a group's language is
 * that of its oldest article) and side, for the balance.
 */
export function assignSplits(
  items: readonly SplitItem[],
  seed: string,
  known: ReadonlyMap<string, DatasetSplit> = new Map(),
  knownCounts: ReadonlyMap<string, { dev: number; test: number }> = new Map(),
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
      const langCounts = counts.get(oldest.lang) ?? { dev: 0, test: 0 };
      langCounts[side] += members.length;
      counts.set(oldest.lang, langCounts);
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
    // Whole groups in seeded order: a group goes to development when that brings the language's
    // development article count closer to its target, otherwise to test.
    let dev = langCounts.dev;
    for (const groupId of ordered) {
      const n = size(groupId);
      const toDev = Math.abs(dev + n - wantDev) < Math.abs(dev - wantDev);
      if (toDev) dev += n;
      decided.set(groupId, toDev ? 'dev' : 'test');
    }
  }
  const result = new Map<string, DatasetSplit>();
  for (const item of items) {
    const side = decided.get(item.storyGroupId);
    if (side === undefined) throw new Error(`no split for group ${item.storyGroupId}`);
    result.set(item.articleId, side);
  }
  return result;
}
