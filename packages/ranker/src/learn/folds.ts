import { sha256Hex } from '@bantoozi/shared/server';

import type { TrainingSample } from './samples.js';

type Stratum = 'pos' | 'neg' | 'mixed' | 'none';
const STRATA: readonly Stratum[] = ['pos', 'neg', 'mixed', 'none'];

/**
 * Deterministic group-stratified fold assignment (spec 06 §8.3): groups are stratified by their
 * explicit class, ordered by sha256(seed‖groupId) and dealt round-robin per stratum; implicit
 * samples follow their group. Returns one fold index per sample.
 */
export function groupFolds(samples: readonly TrainingSample[], k: number, seed: string): number[] {
  const groups = new Map<string, { pos: boolean; neg: boolean }>();
  for (const s of samples) {
    const g = groups.get(s.groupId) ?? { pos: false, neg: false };
    if (s.explicit) {
      if (s.y === 1) g.pos = true;
      else g.neg = true;
    }
    groups.set(s.groupId, g);
  }
  const byStratum = new Map<Stratum, { id: string; key: string }[]>();
  for (const [id, g] of groups) {
    const stratum: Stratum = g.pos && g.neg ? 'mixed' : g.pos ? 'pos' : g.neg ? 'neg' : 'none';
    const list = byStratum.get(stratum) ?? [];
    list.push({ id, key: sha256Hex(`${seed}\u0000${id}`) });
    byStratum.set(stratum, list);
  }
  const foldOf = new Map<string, number>();
  let counter = 0;
  for (const stratum of STRATA) {
    const list = (byStratum.get(stratum) ?? []).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const g of list) {
      foldOf.set(g.id, k > 0 ? counter % k : 0);
      counter += 1;
    }
  }
  return samples.map((s) => foldOf.get(s.groupId) ?? 0);
}

export interface FoldPlan {
  k: number;
  folds: number[];
}

function bothClasses(samples: readonly TrainingSample[], folds: readonly number[], f: number, inside: boolean) {
  let pos = false;
  let neg = false;
  samples.forEach((s, i) => {
    if (!s.explicit || (folds[i] === f) !== inside) return;
    if (s.y === 1) pos = true;
    else neg = true;
  });
  return pos && neg;
}

/**
 * The grouped k-fold plan of spec 06 §8.3: `k = min(5, minority explicit-class group count)`, reduced
 * to 3 while a validation fold or its training partition lacks an explicit class; `null` when
 * impossible (`insufficient_validation`).
 */
export function planFolds(samples: readonly TrainingSample[], seed: string): FoldPlan | null {
  const pos = new Set<string>();
  const neg = new Set<string>();
  for (const s of samples) {
    if (s.explicit) (s.y === 1 ? pos : neg).add(s.groupId);
  }
  for (let k = Math.min(5, pos.size, neg.size); k >= 3; k -= 1) {
    const folds = groupFolds(samples, k, seed);
    let valid = true;
    for (let f = 0; valid && f < k; f += 1) {
      valid = bothClasses(samples, folds, f, true) && bothClasses(samples, folds, f, false);
    }
    if (valid) return { k, folds };
  }
  return null;
}
