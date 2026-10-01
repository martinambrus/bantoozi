/**
 * Rank correlation and agreement (spec 10 §2.3, §4): Spearman ρ for `depth`, Cohen's κ (weighted κ
 * for the ordinal depth) between two labellers as an agreement reference.
 */

/** 1-based ranks with ties given their average rank. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let m = i; m <= j; m += 1) {
      const entry = order[m];
      if (entry !== undefined) ranks[entry.index] = rank;
    }
    i = j + 1;
  }
  return ranks;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new RangeError('xs and ys differ in length');
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman ρ: Pearson correlation of the average ranks; `null` for n < 2 or a constant side. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new RangeError('xs and ys differ in length');
  return pearson(averageRanks(xs), averageRanks(ys));
}

export type KappaWeights = 'none' | 'linear' | 'quadratic';

/**
 * Cohen's κ of two raters' labels on the same items: (p_o − p_e) / (1 − p_e) with disagreement
 * weights. `categories` orders the scale for weighted κ (default: sorted distinct labels). `null`
 * without items, and when chance agreement is already perfect (p_e = 1).
 */
export function cohenKappa(
  pairs: readonly { a: string; b: string }[],
  options: { weights?: KappaWeights; categories?: readonly string[] } = {},
): number | null {
  if (pairs.length === 0) return null;
  const categories =
    options.categories ?? [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))].sort();
  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const weights = options.weights ?? 'none';
  const disagreement = (i: number, j: number): number => {
    if (weights === 'none' || k < 2) return i === j ? 0 : 1;
    const d = Math.abs(i - j) / (k - 1);
    return weights === 'linear' ? d : d * d;
  };
  const n = pairs.length;
  const rowTotals = new Array<number>(k).fill(0);
  const colTotals = new Array<number>(k).fill(0);
  let observed = 0;
  for (const pair of pairs) {
    const i = index.get(pair.a);
    const j = index.get(pair.b);
    if (i === undefined || j === undefined) throw new RangeError('label outside the categories');
    rowTotals[i] = (rowTotals[i] ?? 0) + 1;
    colTotals[j] = (colTotals[j] ?? 0) + 1;
    observed += disagreement(i, j);
  }
  let expected = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      expected += (((rowTotals[i] ?? 0) * (colTotals[j] ?? 0)) / (n * n)) * disagreement(i, j);
    }
  }
  if (expected === 0) return null;
  return 1 - observed / n / expected;
}
