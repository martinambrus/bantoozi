import {
  DEFAULT_RANKER_CONFIG,
  FEATURE_SPEC_V1_FACET_NAMES,
  RAW_SNAPSHOT_SPEC_SHA,
  seededRandom,
} from '../../../src/index.js';
import type { RawFeatureSnapshot } from '../../../src/index.js';
import type { HeldCard, TrainArgs, TrainingSample } from './api.js';

export const NOW = new Date('2026-10-10T12:00:00Z');
export const RATING_SHA = 'a'.repeat(64);
export const CFG = DEFAULT_RANKER_CONFIG;
export const CONSENT = { implicitFeedback: false, implicitNegative: false };
export const DAY = 86_400_000;

/** Card ids of the synthetic user: A drives y, B is noise, C is a second love card, N is never. */
export const CARD_A = '101';
export const CARD_B = '102';
export const CARD_C = '103';
export const CARD_N = '104';

export const HELD: HeldCard[] = [
  { cardId: CARD_A, strength: 'love', scopeFeedId: null, cardInputSha256: 'h-a' },
  { cardId: CARD_B, strength: 'like', scopeFeedId: null, cardInputSha256: 'h-b' },
  { cardId: CARD_C, strength: 'love', scopeFeedId: null, cardInputSha256: 'h-c' },
  { cardId: CARD_N, strength: 'never', scopeFeedId: '7', cardInputSha256: 'h-n' },
];

export interface SnapOpts {
  pA?: number | null;
  pB?: number | null;
  pC?: number | null;
  pN?: number | null;
  facets?: Record<string, number>;
  ageHours?: number;
  clusterId?: string | null;
}

/** A valid raw snapshot with 44 valid facets and the four synthetic cards. */
export function snapshot(feedbackAt: Date, o: SnapOpts = {}): RawFeatureSnapshot {
  const facets: Record<string, number> = {};
  for (const n of FEATURE_SPEC_V1_FACET_NAMES) facets[n] = 0.1;
  Object.assign(facets, o.facets ?? {});
  const p = (v: number | null | undefined, d: number): number | null => (v === undefined ? d : v);
  return {
    specSha: RAW_SNAPSHOT_SPEC_SHA,
    ratingSha: RATING_SHA,
    snapshotAt: new Date(feedbackAt.getTime() - 60_000).toISOString(),
    cards: [
      {
        id: CARD_A,
        strength: 'love',
        p: p(o.pA, 0.3),
        engine: o.pA === null ? 'prefilter' : 'typesafe',
      },
      { id: CARD_B, strength: 'like', p: p(o.pB, 0.3), engine: 'typesafe' },
      { id: CARD_C, strength: 'love', p: p(o.pC, 0.3), engine: 'typesafe' },
      { id: CARD_N, strength: 'never', p: p(o.pN, 0.1), engine: 'typesafe' },
    ],
    values: {
      facets,
      facetsEngine: 'typesafe',
      wordCount: 700,
      ageHours: o.ageHours ?? 10,
      lang: 'en',
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 1,
      clusterId: o.clusterId ?? null,
      clusterSize: 1,
      sourceFeedId: '7',
      author: 'Jane Doe',
    },
  };
}

export function sample(
  i: number,
  y: 0 | 1,
  o: SnapOpts & {
    explicit?: boolean;
    weight?: number;
    groupId?: string;
    ageDays?: number;
    withSnapshot?: boolean;
  } = {},
): TrainingSample {
  const feedbackAt = new Date(NOW.getTime() - (o.ageDays ?? 1 + (i % 20)) * DAY);
  const explicit = o.explicit ?? true;
  return {
    articleId: `art-${i}`,
    eventId: String(1000 + i),
    signal: explicit ? 'rating' : 'bookmark',
    y,
    weight: o.weight ?? (explicit ? 1 : 0.3),
    explicit,
    feedbackAt,
    groupId: o.groupId ?? `g-${i}`,
    features: o.withSnapshot === false ? null : snapshot(feedbackAt, o),
  };
}

/**
 * Seeded synthetic ratings: y follows 8·(pA − .5) + 3·(technology − .5) − 3·(clickbait − .5) plus
 * small noise, so card A's p and two facets drive it; B and C are noise. About one in ten samples
 * shares a group with its predecessor, and every fifth is an implicit bookmark.
 */
export function drivenSamples(n: number, seed: string, noise = 0.5): TrainingSample[] {
  const r = seededRandom(seed);
  const out: TrainingSample[] = [];
  for (let i = 0; i < n; i += 1) {
    const pA = r();
    const tech = r();
    const click = r();
    const z = 8 * (pA - 0.5) + 3 * (tech - 0.5) - 3 * (click - 0.5) + noise * (r() - 0.5);
    const y: 0 | 1 = z > 0 ? 1 : 0;
    const prev = out[i - 1];
    const joined = i > 0 && r() < 0.1 && prev !== undefined && prev.y === y;
    out.push(
      sample(i, y, {
        pA,
        pB: r(),
        pC: r(),
        pN: r() * 0.4,
        facets: { 't1.technology': tech, clickbait: click },
        explicit: i % 5 !== 4,
        groupId: joined && prev !== undefined ? prev.groupId : `g-${i}`,
      }),
    );
  }
  return out;
}

/** Pure-noise ratings: y is independent of every input. */
export function noiseSamples(n: number, seed: string): TrainingSample[] {
  const r = seededRandom(seed);
  return Array.from({ length: n }, (_, i) =>
    sample(i, r() < 0.5 ? 0 : 1, {
      pA: r(),
      pB: r(),
      pC: r(),
      pN: r() * 0.4,
      facets: { clickbait: r() },
    }),
  );
}

export function trainArgs(samples: TrainingSample[], over: Partial<TrainArgs> = {}): TrainArgs {
  return {
    samples,
    now: NOW,
    config: CFG,
    heldCards: HELD,
    ratingSha: RATING_SHA,
    consent: CONSENT,
    seedMaterial: 'user-1|ctx|cutoff-1',
    feedbackCutoffEventId: '5000',
    ...over,
  };
}
