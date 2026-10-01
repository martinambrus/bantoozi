import { createRng } from './random.js';

/**
 * Story-group bootstrap (spec 10 §4): each resample draws whole story groups with replacement, so
 * all copies of a story (duplicates and every rater's/context's copy) move together and one owner
 * rating an article under several personas does not multiply the effective sample size. The
 * statistic receives each group's multiplicity; a paired comparison evaluates candidate and
 * baseline on the same draw. Seeded, so the interval is reproducible.
 */
export interface BootstrapOptions {
  /** Default 1000 (spec 10 §4). */
  resamples?: number;
  seed: string | number;
  /** Two-sided level; default 0.95. */
  level?: number;
}

export interface BootstrapInterval {
  /** The statistic on the original data (every group once); null when undefined there. */
  estimate: number | null;
  lo: number | null;
  hi: number | null;
  /** Resamples whose statistic was defined. */
  valid: number;
  resamples: number;
}

/** Group multiplicities of one resample. */
export type GroupWeights = ReadonlyMap<string, number>;

/** Percentile `q` in [0, 1] of sorted values (linear interpolation). */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/**
 * Percentile bootstrap over groups. `statistic` gets the multiplicity of each group (absent = 0)
 * and returns null when undefined on that draw (e.g. a single-class resample); those draws are
 * counted out of `valid`, never replaced by 0 or 0.5.
 */
export function groupBootstrap(
  groupIds: readonly string[],
  statistic: (weights: GroupWeights) => number | null,
  options: BootstrapOptions,
): BootstrapInterval {
  const groups = [...new Set(groupIds)].sort();
  const resamples = options.resamples ?? 1000;
  const level = options.level ?? 0.95;
  const estimate = statistic(new Map(groups.map((g) => [g, 1])));
  if (groups.length === 0) return { estimate, lo: null, hi: null, valid: 0, resamples };
  const rng = createRng(options.seed);
  const values: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const weights = new Map<string, number>();
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[rng.int(groups.length)];
      if (g !== undefined) weights.set(g, (weights.get(g) ?? 0) + 1);
    }
    const value = statistic(weights);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    estimate,
    lo: quantile(values, alpha),
    hi: quantile(values, 1 - alpha),
    valid: values.length,
    resamples,
  };
}

/** Candidate − baseline on the same resampled groups (paired ΔAUC, spec 10 §4). */
export function pairedGroupBootstrap(
  groupIds: readonly string[],
  candidate: (weights: GroupWeights) => number | null,
  baseline: (weights: GroupWeights) => number | null,
  options: BootstrapOptions,
): BootstrapInterval {
  return groupBootstrap(
    groupIds,
    (weights) => {
      const a = candidate(weights);
      const b = baseline(weights);
      return a === null || b === null ? null : a - b;
    },
    options,
  );
}
