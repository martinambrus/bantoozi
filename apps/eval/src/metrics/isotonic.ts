/**
 * Weighted isotonic regression by pool-adjacent-violators (spec 10 §5 step 4, `tiers`): the
 * non-decreasing step function of like-rate on raw score with the least weighted squared error.
 * Equal scores are pooled first, so a fitted block never splits a tie.
 */
export interface IsotonicPoint {
  x: number;
  y: number;
  weight?: number;
}

export interface IsotonicBlock {
  /** Smallest and largest score in the block. */
  xMin: number;
  xMax: number;
  /** The fitted value (weighted mean of y). */
  value: number;
  weight: number;
}

export function isotonicRegression(points: readonly IsotonicPoint[]): IsotonicBlock[] {
  const sorted = points.filter((point) => (point.weight ?? 1) > 0).sort((a, b) => a.x - b.x);
  const blocks: { xMin: number; xMax: number; sum: number; weight: number }[] = [];
  for (const point of sorted) {
    const w = point.weight ?? 1;
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.xMax === point.x) {
      last.sum += w * point.y;
      last.weight += w;
    } else {
      blocks.push({ xMin: point.x, xMax: point.x, sum: w * point.y, weight: w });
    }
    // Merge backwards while the order is violated.
    for (;;) {
      const top = blocks[blocks.length - 1];
      const below = blocks[blocks.length - 2];
      if (top === undefined || below === undefined) break;
      if (below.sum / below.weight <= top.sum / top.weight) break;
      blocks.splice(blocks.length - 2, 2, {
        xMin: below.xMin,
        xMax: top.xMax,
        sum: below.sum + top.sum,
        weight: below.weight + top.weight,
      });
    }
  }
  return blocks.map((block) => ({
    xMin: block.xMin,
    xMax: block.xMax,
    value: block.sum / block.weight,
    weight: block.weight,
  }));
}

/** The fitted value at `x` (constant inside a block, the nearer block between blocks). */
export function isotonicPredict(blocks: readonly IsotonicBlock[], x: number): number | null {
  if (blocks.length === 0) return null;
  let result = blocks[0]?.value ?? null;
  for (const block of blocks) {
    if (x >= block.xMin) result = block.value;
    else break;
  }
  return result;
}

/** The smallest score whose fitted value reaches `level`, or `null` when no block reaches it. */
export function smallestScoreReaching(
  blocks: readonly IsotonicBlock[],
  level: number,
): number | null {
  for (const block of blocks) if (block.value >= level) return block.xMin;
  return null;
}
