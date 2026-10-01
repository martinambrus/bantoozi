import { sha256Hex } from '@bantoozi/shared/server';

/**
 * The paired AUC comparison a replay reports (spec 10 §4, §6): ROC AUC as the Mann–Whitney
 * statistic with ties counted as ½, and a 95 % interval of ΔAUC from paired story-group bootstrap
 * resamples (the same resampled groups for both runs, every copy of a group together). Pure and
 * seeded. The G1 report uses the metrics library (M3a-T5); this small copy keeps `eval replay`
 * self-contained (D-113).
 */

export interface ScoredItem {
  /** 1 = liked, 0 = disliked. */
  label: 0 | 1;
  base: number;
  replay: number;
  group: string;
}

/** ROC AUC (Mann–Whitney U with average ranks); null with a single class. */
export function rocAuc(scores: readonly number[], labels: readonly (0 | 1)[]): number | null {
  const n = scores.length;
  let positives = 0;
  for (const label of labels) positives += label;
  const negatives = n - positives;
  if (positives === 0 || negatives === 0) return null;
  const order = scores.map((score, index) => ({ score, index })).sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1]?.score === order[i]?.score) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = order[k];
      if (entry !== undefined && labels[entry.index] === 1) rankSum += rank;
    }
    i = j + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** mulberry32 seeded from a string: the bootstrap's deterministic PRNG. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedAuc {
  n: number;
  positives: number;
  negatives: number;
  base: number | null;
  replay: number | null;
  delta: number | null;
  /** 95 % paired story-group bootstrap interval of the delta; null when unsupported. */
  ci: [number, number] | null;
}

export function pairedAuc(
  items: readonly ScoredItem[],
  options: { seed: string; resamples?: number },
): PairedAuc {
  const labels = items.map((item) => item.label);
  const base = rocAuc(
    items.map((item) => item.base),
    labels,
  );
  const replay = rocAuc(
    items.map((item) => item.replay),
    labels,
  );
  const positives = labels.filter((label) => label === 1).length;
  const result: PairedAuc = {
    n: items.length,
    positives,
    negatives: items.length - positives,
    base,
    replay,
    delta: base === null || replay === null ? null : replay - base,
    ci: null,
  };
  if (result.delta === null) return result;

  const groups = new Map<string, ScoredItem[]>();
  for (const item of items) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }
  const keys = [...groups.keys()].sort();
  const random = seededRandom(options.seed);
  const deltas: number[] = [];
  for (let r = 0; r < (options.resamples ?? 1000); r += 1) {
    const picked: ScoredItem[] = [];
    for (let g = 0; g < keys.length; g += 1) {
      const key = keys[Math.floor(random() * keys.length)];
      if (key !== undefined) picked.push(...(groups.get(key) ?? []));
    }
    const l = picked.map((item) => item.label);
    const a = rocAuc(
      picked.map((item) => item.base),
      l,
    );
    const b = rocAuc(
      picked.map((item) => item.replay),
      l,
    );
    if (a !== null && b !== null) deltas.push(b - a);
  }
  if (deltas.length > 0) {
    deltas.sort((x, y) => x - y);
    const at = (q: number) =>
      deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(q * (deltas.length - 1))))] ?? 0;
    result.ci = [at(0.025), at(0.975)];
  }
  return result;
}
