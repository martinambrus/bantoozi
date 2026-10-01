import type { DatasetSplit } from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';

/**
 * The development/test split (spec 10 §2.1): deterministic, 70 % development, stratified by
 * language and grouped by story, so every copy of a story (duplicates, and every rater's copy) is on
 * one side. Groups already in the version keep their side; new groups fill each language toward
 * 70 % in the order of a seeded hash, so a top-up never moves an item and keeps the balance.
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
 * final); `knownCounts` the number of known groups per language and side, for the balance.
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
  for (const [groupId, members] of groups) {
    const side = known.get(groupId);
    if (side !== undefined) {
      decided.set(groupId, side);
      continue;
    }
    const oldest = [...members].sort((a, b) => byNumericId(a.articleId, b.articleId))[0];
    if (oldest === undefined) continue;
    const list = fresh.get(oldest.lang) ?? [];
    list.push(groupId);
    fresh.set(oldest.lang, list);
  }
  for (const [lang, groupIds] of fresh) {
    const counts = knownCounts.get(lang) ?? { dev: 0, test: 0 };
    const total = counts.dev + counts.test + groupIds.length;
    const wantDev = Math.min(
      groupIds.length,
      Math.max(0, Math.round(DEV_SHARE * total) - counts.dev),
    );
    const ordered = [...groupIds].sort(
      (a, b) => groupRank(seed, a) - groupRank(seed, b) || (a < b ? -1 : a > b ? 1 : 0),
    );
    ordered.forEach((groupId, i) => decided.set(groupId, i < wantDev ? 'dev' : 'test'));
  }
  const result = new Map<string, DatasetSplit>();
  for (const item of items) {
    const side = decided.get(item.storyGroupId);
    if (side === undefined) throw new Error(`no split for group ${item.storyGroupId}`);
    result.set(item.articleId, side);
  }
  return result;
}
