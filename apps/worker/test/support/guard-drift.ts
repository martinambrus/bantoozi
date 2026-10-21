import {
  FEATURE_SPEC_V1_FACET_NAMES,
  RAW_SNAPSHOT_SPEC_SHA,
  seededRandom,
  type TrainingSample,
} from '@bantoozi/ranker';

/**
 * JEV-4 T3 fixtures: ratings in blocks that differ in rating sha, in the relation between a facet
 * and the label and in how strongly one interest card separates the classes. A model fitted
 * mostly on an old block whose facet relation is inverted on the newest block does worse than the
 * cards on the newest ratings: the situation the upgrade guard exists for.
 */

export interface DriftBlock {
  sha: string;
  n: number;
  nPos: number;
  /** 1: a like has a high `t1.technology`; -1: inverted; 0: no signal. */
  relation: 1 | -1 | 0;
  /** How strongly card A's p separates the classes (0: not at all). */
  cardSignal: number;
}

/** Equal likes and dislikes. */
export const block = (
  sha: string,
  n: number,
  relation: 1 | -1 | 0,
  cardSignal: number,
  nPos = Math.floor(n / 2),
): DriftBlock => ({ sha, n, nPos, relation, cardSignal });

export interface DriftRow {
  y: 0 | 1;
  pA: number;
  pB: number;
  pC: number;
  tech: number;
  sha: string;
}

function rowOf(b: DriftBlock, y: 0 | 1, r: () => number): DriftRow {
  const tech =
    b.relation === 0
      ? r()
      : (b.relation === 1 ? y === 1 : y === 0)
        ? 0.35 + 0.65 * r()
        : 0.65 * r();
  const pA =
    b.cardSignal === 0 ? r() : y === 1 ? 1 - (1 - b.cardSignal) * r() : (1 - b.cardSignal) * r();
  return { y, pA, tech, pB: r(), pC: r(), sha: b.sha };
}

/** The rows of the blocks, one block after the other (`interleave`: mixed in proportion). */
export function driftRows(seed: string, blocks: DriftBlock[], interleave = false): DriftRow[] {
  const r = seededRandom(seed);
  const perBlock = blocks.map((b) =>
    Array.from({ length: b.n }, (_, i) => rowOf(b, i < b.nPos ? 1 : 0, r)),
  );
  if (!interleave) return perBlock.flat();
  const smallest = Math.min(...perBlock.map((rows) => rows.length));
  const cursors = perBlock.map(() => 0);
  const out: DriftRow[] = [];
  let left = perBlock.reduce((sum, rows) => sum + rows.length, 0);
  while (left > 0) {
    perBlock.forEach((rows, k) => {
      const share = Math.max(1, Math.round(rows.length / smallest));
      for (let t = 0; t < share; t += 1) {
        const row = rows[cursors[k] ?? 0];
        if (row === undefined) break;
        out.push(row);
        cursors[k] = (cursors[k] ?? 0) + 1;
        left -= 1;
      }
    });
  }
  return out;
}

export interface CardSpec {
  id: string;
  strength: 'must' | 'love' | 'like' | 'never';
  /** Which probability of the row the card carries (`pN`: a constant 0.1). */
  from: 'pA' | 'pB' | 'pC' | 'pN';
}

/** The raw snapshot (spec 06 §8.2) of a row rated at `at`. */
export function snapshotOf(row: DriftRow, at: Date, cards: CardSpec[], feedId: string) {
  const facets: Record<string, number> = {};
  for (const name of FEATURE_SPEC_V1_FACET_NAMES) facets[name] = 0.1;
  facets['t1.technology'] = row.tech;
  return {
    specSha: RAW_SNAPSHOT_SPEC_SHA,
    ratingSha: row.sha,
    snapshotAt: new Date(at.getTime() - 60_000).toISOString(),
    cards: cards.map((card) => ({
      id: card.id,
      strength: card.strength,
      p: card.from === 'pN' ? 0.1 : row[card.from],
      engine: 'typesafe',
    })),
    values: {
      facets,
      facetsEngine: 'typesafe',
      wordCount: 700,
      ageHours: 10,
      lang: 'en',
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 1,
      clusterId: null,
      clusterSize: 1,
      sourceFeedId: feedId,
      author: 'Jane Doe',
    },
    sourceManifest: { contentRevision: '1', mediaRevision: '1', inferenceFeedIds: [feedId] },
  };
}

/** Pure trainer input samples (ids in row order, one story group per row). */
export function trainingSamples(
  rows: DriftRow[],
  now: Date,
  cards: CardSpec[],
  feedId = '7',
): TrainingSample[] {
  return rows.map((row, i) => {
    const feedbackAt = new Date(now.getTime() - (1 + (i % 20)) * 86_400_000);
    return {
      articleId: `art-${i}`,
      eventId: String(1000 + i),
      groupId: `g-${i}`,
      y: row.y,
      weight: 1,
      explicit: true,
      signal: 'rating',
      reason: null,
      feedbackAt,
      features: snapshotOf(row, feedbackAt, cards, feedId),
    } as unknown as TrainingSample;
  });
}
