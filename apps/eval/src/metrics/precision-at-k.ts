import { compareBigIntStrings } from '@bantoozi/shared';

/** One rated item in a ranked list (spec 10 §4 "P@10, P@20"). */
export interface RankedItem {
  id: string;
  score: number;
  positive: boolean;
  /** Epoch milliseconds (or any comparable number): newer first among equal scores. */
  firstSeenAt: number;
}

export interface PrecisionAtK {
  k: number;
  /** Like-rate among the top k; `null` when fewer than k eligible ratings exist. */
  value: number | null;
  /** The actual denominator: min(k, eligible items). */
  denominator: number;
  likes: number;
}

/** The stable ranking order `(score DESC, firstSeenAt DESC, id DESC)` (ids compared numerically). */
export function compareRanked(a: RankedItem, b: RankedItem): number {
  return b.score - a.score || b.firstSeenAt - a.firstSeenAt || compareBigIntStrings(b.id, a.id);
}

/** Like-rate among the top `k`; null (with the actual denominator) when fewer than `k` exist. */
export function precisionAtK(items: readonly RankedItem[], k: number): PrecisionAtK {
  if (!Number.isInteger(k) || k <= 0) throw new RangeError('k must be a positive integer');
  const top = [...items].sort(compareRanked).slice(0, k);
  const likes = top.filter((item) => item.positive).length;
  return { k, value: top.length < k ? null : likes / k, denominator: top.length, likes };
}
