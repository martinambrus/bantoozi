import { seededRandom } from '../../../src/index.js';
import type { TrainingSample } from './api.js';
import { OTHER_RATING_SHA, RATING_SHA, sample } from './synth.js';

export interface DriftBlock {
  /** Rating sha stamped on the rows of this block. */
  sha: string;
  n: number;
  /** Number of likes among the `n` rows. */
  nPos: number;
  /**
   * The facet relation: 1 = a like has a high `t1.technology` (the old world), -1 = inverted,
   * 0 = the facet carries no signal.
   */
  relation: 1 | -1 | 0;
  /** How strongly card A's p separates the classes (0 = not at all). */
  cardSignal: number;
  explicit?: boolean;
}

export interface DriftOpts {
  seed: string;
  blocks: DriftBlock[];
  /** Interleave the blocks in id order (default) instead of old-then-new. */
  interleave?: boolean;
  /** Rows of different blocks share a story group when true. */
  shareGroups?: boolean;
}

function rowSpec(
  b: DriftBlock,
  y: 0 | 1,
  r: () => number,
): { pA: number; tech: number; pB: number; pC: number } {
  const tech =
    b.relation === 0
      ? r()
      : (b.relation === 1 ? y === 1 : y === 0)
        ? 0.35 + 0.65 * r()
        : 0.65 * r();
  const pA =
    b.cardSignal === 0 ? r() : y === 1 ? 1 - (1 - b.cardSignal) * r() : (1 - b.cardSignal) * r();
  return { pA, tech, pB: r(), pC: r() };
}

/**
 * Seeded explicit ratings in blocks that differ in rating sha, facet relation and card signal.
 * Ids are assigned in the final order, so an interleaved fixture mixes the shas through the id
 * order, the folds and (with `shareGroups`) the story groups.
 */
export function driftSamples(o: DriftOpts): TrainingSample[] {
  const r = seededRandom(o.seed);
  const specs: { b: DriftBlock; y: 0 | 1; pA: number; tech: number; pB: number; pC: number }[][] =
    o.blocks.map((b) =>
      Array.from({ length: b.n }, (_, i) => {
        const y: 0 | 1 = i < b.nPos ? 1 : 0;
        return { b, y, ...rowSpec(b, y, r) };
      }),
    );
  const order: (typeof specs)[number] = [];
  if (o.interleave === false) {
    for (const s of specs) order.push(...s);
  } else {
    const cursors = specs.map(() => 0);
    let left = specs.reduce((a, s) => a + s.length, 0);
    while (left > 0) {
      for (let k = 0; k < specs.length; k += 1) {
        const s = specs[k] ?? [];
        const share = Math.max(1, Math.round(s.length / Math.min(...specs.map((x) => x.length))));
        for (let t = 0; t < share; t += 1) {
          const c = cursors[k] ?? 0;
          const row = s[c];
          if (row === undefined) break;
          order.push(row);
          cursors[k] = c + 1;
          left -= 1;
        }
      }
    }
  }
  const out: TrainingSample[] = [];
  order.forEach((row, i) => {
    const prev = out[i - 1];
    const joined = o.shareGroups === true && i % 3 === 1 && prev !== undefined && prev.y === row.y;
    out.push(
      sample(i, row.y, {
        pA: row.pA,
        pB: row.pB,
        pC: row.pC,
        pN: 0.1,
        facets: { 't1.technology': row.tech },
        ratingSha: row.b.sha,
        explicit: row.b.explicit ?? true,
        groupId: joined && prev !== undefined ? prev.groupId : `g-${i}`,
      }),
    );
  });
  return out;
}

/** Equal likes and dislikes of {@link DriftBlock}s. */
export function block(
  sha: string,
  n: number,
  relation: 1 | -1 | 0,
  cardSignal: number,
  nPos = Math.floor(n / 2),
): DriftBlock {
  return { sha, n, nPos, relation, cardSignal };
}

/** The decisive drift: the old world's facet relation is inverted on the newest 30 ratings. */
export function driftFixture(
  seed: string,
  nOld = 400,
  nNew = 30,
  o: Partial<DriftOpts> = {},
): TrainingSample[] {
  return driftSamples({
    seed,
    blocks: [block(OTHER_RATING_SHA, nOld, 1, 0), block(RATING_SHA, nNew, -1, 0.4)],
    ...o,
  });
}

/** Healthy: the facet relation of the old rows holds on the newest rows too. */
export function healthyFixture(
  seed: string,
  nOld = 150,
  nNew = 40,
  o: Partial<DriftOpts> = {},
): TrainingSample[] {
  return driftSamples({
    seed,
    blocks: [block(OTHER_RATING_SHA, nOld, 1, 0.3), block(RATING_SHA, nNew, 1, 0.3)],
    ...o,
  });
}
