import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  FEATURE_SPEC_V1_DESCRIPTOR,
  FEATURE_SPEC_V1_NAMES,
  FEATURE_SPEC_V1_SHA,
  featureSpecSha,
  itemFeatures,
  type RankCard,
  type RankItem,
  type RawFeatureSnapshot,
  snapshotCardScore,
  snapshotFeatures,
} from '../../src/index.js';
import { answers, card } from '../support.js';

const cfg = DEFAULT_RANKER_CONFIG;
const CONTENT_TYPES = [
  'news_report',
  'analysis',
  'opinion',
  'tutorial',
  'review',
  'listicle',
  'press_release',
  'deal_or_ad',
  'job_or_event',
  'media',
  'interview',
  'other',
];
const TOPICS = [
  'technology',
  'science',
  'health',
  'business',
  'economy',
  'politics',
  'world',
  'local',
  'environment',
  'transport',
  'culture',
  'entertainment',
  'gaming',
  'sports',
  'lifestyle',
  'education',
  'society',
  'shopping',
  'diy',
  'other',
];
const SCOPES = ['global', 'national', 'regional_or_city', 'not_geographic'];
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

type Values = RawFeatureSnapshot['values'];
type SnapCard = RawFeatureSnapshot['cards'][number];

const snapCard = (id: string, strength: SnapCard['strength'], p: number | null): SnapCard => ({
  id,
  strength,
  p,
  engine: p === null ? null : 'typesafe',
});

function snap(cards: SnapCard[] = [], values: Partial<Values> = {}): RawFeatureSnapshot {
  return {
    specSha: 'a'.repeat(64),
    ratingSha: 'b'.repeat(64),
    snapshotAt: '2026-10-01T12:00:00.000Z',
    cards,
    values: {
      facets: {},
      facetsEngine: 'typesafe',
      wordCount: 800,
      ageHours: 30,
      lang: 'en',
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 0,
      clusterId: null,
      clusterSize: 0,
      sourceFeedId: null,
      author: null,
      ...values,
    },
  } as RawFeatureSnapshot;
}

const features = (cards: SnapCard[] = [], values: Partial<Values> = {}, own: string[] = []) =>
  snapshotFeatures(snap(cards, values), cfg, own);

/** The names of one one-hot group that are 1; the group must hold exactly one 1 and zeros else. */
function hot(vector: Record<string, number>, names: readonly string[]): string[] {
  for (const name of names) expect([0, 1]).toContain(vector[name]);
  return names.filter((name) => vector[name] === 1);
}

const LEN = ['len.short', 'len.medium', 'len.long', 'len.very_long', 'len.unknown'];
const AGE = ['age.lt6h', 'age.lt24h', 'age.lt72h', 'age.older'];
const LANG = ['lang.en', 'lang.sk', 'lang.cs', 'lang.other'];
const IMG = ['img.none', 'img.light', 'img.moderate', 'img.heavy', 'img.unknown'];
const FEED = range(32).map((k) => `feed.h${k}`);
const AUTHOR = range(16).map((k) => `author.h${k}`);

const SEEDED_FACETS = {
  'ct.news_report': 0.5,
  'ct.analysis': 0.25,
  't1.technology': 0.75,
  't1.science': 0.125,
  't2.technology.ai_ml': 0.5,
  't2_asked.technology': 1,
  depth: 0.5,
  depth_conf: 0.5,
  clickbait: 0.25,
  tone: 0.75,
  'scope.global': 0.5,
  'scope.national': 0.25,
};

/** Two love, one like and two never cards; card 10 is an own card input. */
const SEEDED_CARDS: SnapCard[] = [
  snapCard('10', 'love', 0.9),
  snapCard('11', 'love', 0.5),
  snapCard('12', 'like', 0.7),
  snapCard('13', 'never', 0.8),
  snapCard('14', 'never', 0.3),
];
const SEEDED_VALUES: Partial<Values> = {
  facets: SEEDED_FACETS,
  wordCount: 800,
  ageHours: 30,
  lang: 'sk',
  hasImage: true,
  hasVideo: false,
  bodyImageCount: 2,
  clusterId: '44',
  clusterSize: 3,
  sourceFeedId: '57',
  author: 'Ján Novák',
};

const SEEDED_VECTOR: Record<string, number> = {
  'best.must': 0,
  'best.love': 0.9,
  'best.like': 0.7,
  'best.never': 0.8,
  'known.best.must': 0,
  'known.best.love': 1,
  'known.best.like': 1,
  'known.best.never': 1,
  matched_log: Math.log(4),
  cardscore: 0.9,
  'ct.news_report': 0.5,
  'ct.analysis': 0.25,
  'ct.opinion': 0,
  'ct.tutorial': 0,
  'ct.review': 0,
  'ct.listicle': 0,
  'ct.press_release': 0,
  'ct.deal_or_ad': 0,
  'ct.job_or_event': 0,
  'ct.media': 0,
  'ct.interview': 0,
  'ct.other': 0,
  't1.technology': 0.75,
  't1.science': 0.125,
  't1.health': 0,
  't1.business': 0,
  't1.economy': 0,
  't1.politics': 0,
  't1.world': 0,
  't1.local': 0,
  't1.environment': 0,
  't1.transport': 0,
  't1.culture': 0,
  't1.entertainment': 0,
  't1.gaming': 0,
  't1.sports': 0,
  't1.lifestyle': 0,
  't1.education': 0,
  't1.society': 0,
  't1.shopping': 0,
  't1.diy': 0,
  't1.other': 0,
  depth: 0.5,
  depth_conf: 0.5,
  clickbait: 0.25,
  promotional: 0,
  time_sensitive: 0,
  evergreen: 0,
  paywall_teaser: 0,
  tone: 0.75,
  'scope.global': 0.5,
  'scope.national': 0.25,
  'scope.regional_or_city': 0,
  'scope.not_geographic': 0,
  'len.short': 0,
  'len.medium': 0,
  'len.long': 1,
  'len.very_long': 0,
  'len.unknown': 0,
  'age.lt6h': 0,
  'age.lt24h': 0,
  'age.lt72h': 1,
  'age.older': 0,
  'lang.en': 0,
  'lang.sk': 1,
  'lang.cs': 0,
  'lang.other': 0,
  has_video: 0,
  'known.has_video': 1,
  'img.none': 0,
  'img.light': 0,
  'img.moderate': 1,
  'img.heavy': 0,
  'img.unknown': 0,
  has_image: 1,
  cluster_log: Math.log(4),
  'feed.h0': 0,
  'feed.h1': 0,
  'feed.h2': 0,
  'feed.h3': 0,
  'feed.h4': 0,
  'feed.h5': 0,
  'feed.h6': 0,
  'feed.h7': 0,
  'feed.h8': 0,
  'feed.h9': 0,
  'feed.h10': 0,
  'feed.h11': 0,
  'feed.h12': 1,
  'feed.h13': 0,
  'feed.h14': 0,
  'feed.h15': 0,
  'feed.h16': 0,
  'feed.h17': 0,
  'feed.h18': 0,
  'feed.h19': 0,
  'feed.h20': 0,
  'feed.h21': 0,
  'feed.h22': 0,
  'feed.h23': 0,
  'feed.h24': 0,
  'feed.h25': 0,
  'feed.h26': 0,
  'feed.h27': 0,
  'feed.h28': 0,
  'feed.h29': 0,
  'feed.h30': 0,
  'feed.h31': 0,
  'author.h0': 0,
  'author.h1': 0,
  'author.h2': 0,
  'author.h3': 0,
  'author.h4': 0,
  'author.h5': 0,
  'author.h6': 0,
  'author.h7': 0,
  'author.h8': 0,
  'author.h9': 0,
  'author.h10': 0,
  'author.h11': 0,
  'author.h12': 0,
  'author.h13': 0,
  'author.h14': 0,
  'author.h15': 1,
  'card.10': 0.9,
  'known.card.10': 1,
};

describe('FEATURE_SPEC_V1_NAMES', () => {
  it('has 124 unique fixed names in the canonical order', () => {
    expect(FEATURE_SPEC_V1_NAMES).toHaveLength(124);
    expect(new Set(FEATURE_SPEC_V1_NAMES).size).toBe(124);
    expect(FEATURE_SPEC_V1_NAMES.slice(0, 10)).toEqual([
      'best.must',
      'best.love',
      'best.like',
      'best.never',
      'known.best.must',
      'known.best.love',
      'known.best.like',
      'known.best.never',
      'matched_log',
      'cardscore',
    ]);
    expect(FEATURE_SPEC_V1_NAMES.slice(10, 54)).toEqual([
      ...CONTENT_TYPES.map((x) => `ct.${x}`),
      ...TOPICS.map((x) => `t1.${x}`),
      'depth',
      'depth_conf',
      'clickbait',
      'promotional',
      'time_sensitive',
      'evergreen',
      'paywall_teaser',
      'tone',
      ...SCOPES.map((x) => `scope.${x}`),
    ]);
    expect(FEATURE_SPEC_V1_NAMES.slice(54)).toEqual([
      ...LEN,
      ...AGE,
      ...LANG,
      'has_video',
      'known.has_video',
      ...IMG,
      'has_image',
      'cluster_log',
      ...FEED,
      ...AUTHOR,
    ]);
    expect(FEATURE_SPEC_V1_NAMES[0]).toBe('best.must');
    expect(FEATURE_SPEC_V1_NAMES.at(-1)).toBe('author.h15');
  });
});

describe('snapshotFeatures: the seeded item', () => {
  it('produces exactly this vector', () => {
    expect(snapshotFeatures(snap(SEEDED_CARDS, SEEDED_VALUES), cfg, ['10'])).toEqual(SEEDED_VECTOR);
  });

  it('keys are the 124 names plus card.<id> and known.card.<id> for each own input', () => {
    const vector = features(SEEDED_CARDS, SEEDED_VALUES, ['10', '13']);
    expect(Object.keys(vector).sort()).toEqual(
      [...FEATURE_SPEC_V1_NAMES, 'card.10', 'known.card.10', 'card.13', 'known.card.13'].sort(),
    );
    for (const value of Object.values(vector)) expect(Number.isFinite(value)).toBe(true);
    expect(Object.keys(features(SEEDED_CARDS, SEEDED_VALUES)).sort()).toEqual(
      [...FEATURE_SPEC_V1_NAMES].sort(),
    );
  });

  it('does not mutate the snapshot and is deterministic', () => {
    const input = snap(SEEDED_CARDS, SEEDED_VALUES);
    const copy = structuredClone(input);
    const first = snapshotFeatures(input, cfg, ['10']);
    expect(input).toEqual(copy);
    expect(snapshotFeatures(input, cfg, ['10'])).toEqual(first);
  });
});

describe('media inputs', () => {
  it.each([
    [true, 1, 1],
    [false, 0, 1],
    [null, 0, 0],
  ])('hasVideo %s gives has_video %i and known.has_video %i', (hasVideo, value, known) => {
    const vector = features([], { hasVideo });
    expect(vector['has_video']).toBe(value);
    expect(vector['known.has_video']).toBe(known);
  });

  it.each([
    [0, 100, 'img.none'],
    [0, null, 'img.unknown'],
    [null, 100, 'img.unknown'],
    [null, null, 'img.unknown'],
    [0, 0, 'img.none'],
    [1, 100, 'img.moderate'],
    [1, 500, 'img.moderate'],
    [1, 501, 'img.light'],
    [1, 1000, 'img.light'],
    [2, 999, 'img.moderate'],
    [2, 500, 'img.moderate'],
    [3, 500, 'img.heavy'],
    [5, 1000, 'img.moderate'],
    [6, 1000, 'img.heavy'],
    [10, 200, 'img.heavy'],
    [10, 3000, 'img.moderate'],
  ])('bodyImageCount %s over %s words is %s', (count, words, bucket) => {
    const vector = features([], { bodyImageCount: count, wordCount: words });
    expect(hot(vector, IMG)).toEqual([bucket]);
  });

  it('has_image follows the thumbnail flag, and a missing flag is 0', () => {
    expect(features([], { hasImage: true })['has_image']).toBe(1);
    expect(features([], { hasImage: false })['has_image']).toBe(0);
    expect(features([], { hasImage: undefined })['has_image']).toBe(0);
  });
});

describe('length, freshness, language and cluster inputs', () => {
  it.each([
    [0, 'len.short'],
    [149, 'len.short'],
    [150, 'len.medium'],
    [599, 'len.medium'],
    [600, 'len.long'],
    [1499, 'len.long'],
    [1500, 'len.very_long'],
    [20000, 'len.very_long'],
    [null, 'len.unknown'],
  ])('wordCount %s is %s', (words, bucket) => {
    expect(hot(features([], { wordCount: words }), LEN)).toEqual([bucket]);
  });

  it.each([
    [0, 'age.lt6h'],
    [5.999, 'age.lt6h'],
    [6, 'age.lt24h'],
    [23.999, 'age.lt24h'],
    [24, 'age.lt72h'],
    [71.999, 'age.lt72h'],
    [72, 'age.older'],
    [5000, 'age.older'],
  ])('ageHours %s is %s', (age, bucket) => {
    expect(hot(features([], { ageHours: age }), AGE)).toEqual([bucket]);
  });

  it.each([
    ['en', 'lang.en'],
    ['sk', 'lang.sk'],
    ['cs', 'lang.cs'],
    ['de', 'lang.other'],
    ['und', 'lang.other'],
    [null, 'lang.other'],
  ])('lang %s is %s', (lang, name) => {
    expect(hot(features([], { lang }), LANG)).toEqual([name]);
  });

  it('cluster_log is ln(1 + clusterSize); an unclustered snapshot (size 0) counts as a story of one', () => {
    expect(features([], { clusterSize: 0 })['cluster_log']).toBeCloseTo(Math.log(2), 12);
    expect(features([], { clusterSize: 1 })['cluster_log']).toBeCloseTo(Math.log(2), 12);
    expect(features([], { clusterSize: 3 })['cluster_log']).toBeCloseTo(Math.log(4), 12);
  });
});

describe('source hashing', () => {
  it.each([
    ['1', 19],
    ['2', 23],
    ['9', 1],
    ['10', 31],
    ['57', 12],
  ])('feed %s falls in bucket murmur3 mod 32 = %i', (feedId, bucket) => {
    expect(hot(features([], { sourceFeedId: feedId }), FEED)).toEqual([`feed.h${bucket}`]);
  });

  it('a missing feed id sets no feed bucket', () => {
    expect(hot(features([], { sourceFeedId: null }), FEED)).toEqual([]);
  });

  it('author buckets use normalizeText, so case and diacritics do not matter', () => {
    const a = hot(features([], { author: 'Ján Novák' }), AUTHOR);
    expect(a).toEqual(['author.h15']);
    expect(hot(features([], { author: '  JAN   novak ' }), AUTHOR)).toEqual(a);
    expect(hot(features([], { author: 'Eva Horváthová' }), AUTHOR)).toEqual(['author.h6']);
  });

  it('a null or empty author sets no author bucket', () => {
    expect(hot(features([], { author: null }), AUTHOR)).toEqual([]);
    expect(hot(features([], { author: '' }), AUTHOR)).toEqual([]);
    expect(hot(features([], { author: '   ' }), AUTHOR)).toEqual([]);
  });
});

describe('facet inputs', () => {
  it('copies the 44 facet features and ignores level-2 keys; absent facets are 0', () => {
    const vector = features([], { facets: SEEDED_FACETS });
    expect(vector['ct.news_report']).toBe(0.5);
    expect(vector['t1.technology']).toBe(0.75);
    expect(vector['scope.global']).toBe(0.5);
    expect(vector['paywall_teaser']).toBe(0);
    expect(Object.keys(vector).some((name) => name.startsWith('t2'))).toBe(false);
    const empty = features([], { facets: {} });
    for (const name of FEATURE_SPEC_V1_NAMES.slice(10, 54)) expect(empty[name]).toBe(0);
  });
});

describe('card groups, masks, matched_log and cardscore', () => {
  const GROUPS = ['must', 'love', 'like', 'never'] as const;

  it('best.<s> is the highest p of that strength, with its mask', () => {
    const vector = features([
      snapCard('1', 'must', 0.3),
      snapCard('2', 'must', 0.6),
      snapCard('3', 'love', 0.2),
      snapCard('4', 'like', 0.4),
      snapCard('5', 'like', 0.9),
      snapCard('6', 'never', 0.1),
      snapCard('7', 'never', 0.5),
    ]);
    expect([
      vector['best.must'],
      vector['best.love'],
      vector['best.like'],
      vector['best.never'],
    ]).toEqual([0.6, 0.2, 0.9, 0.5]);
    for (const s of GROUPS) expect(vector[`known.best.${s}`]).toBe(1);
  });

  it('a strength group with no card is 0 with a 0 mask', () => {
    const vector = features([snapCard('1', 'love', 0.7)]);
    expect(vector['best.love']).toBe(0.7);
    expect(vector['known.best.love']).toBe(1);
    for (const s of ['must', 'like', 'never']) {
      expect(vector[`best.${s}`]).toBe(0);
      expect(vector[`known.best.${s}`]).toBe(0);
    }
    const none = features([]);
    for (const s of GROUPS) {
      expect(none[`best.${s}`]).toBe(0);
      expect(none[`known.best.${s}`]).toBe(0);
    }
    expect(none['matched_log']).toBe(0);
    expect(none['cardscore']).toBe(0);
    expect(snapshotCardScore(snap([]), cfg.strengthWeights)).toBeNull();
  });

  it('a positive card without a usable answer is ignored by its group', () => {
    const only = features([snapCard('1', 'love', null)]);
    expect(only['best.love']).toBe(0);
    expect(only['known.best.love']).toBe(0);
    const mixed = features([snapCard('1', 'love', null), snapCard('2', 'love', 0.4)]);
    expect(mixed['best.love']).toBe(0.4);
    expect(mixed['known.best.love']).toBe(1);
  });

  it('partial never coverage gives known.best.never 0 and best.never 0', () => {
    const partial = features([snapCard('1', 'never', 0.8), snapCard('2', 'never', null)]);
    expect(partial['known.best.never']).toBe(0);
    expect(partial['best.never']).toBe(0);
    const allUnknown = features([snapCard('1', 'never', null), snapCard('2', 'never', null)]);
    expect(allUnknown['known.best.never']).toBe(0);
    expect(allUnknown['best.never']).toBe(0);
    const full = features([snapCard('1', 'never', 0.1), snapCard('2', 'never', 0.8)]);
    expect(full['known.best.never']).toBe(1);
    expect(full['best.never']).toBe(0.8);
    const one = features([snapCard('1', 'never', 0)]);
    expect(one['known.best.never']).toBe(1);
    expect(one['best.never']).toBe(0);
  });

  it('matched_log counts positive cards at or above cardMatchP, boundary included', () => {
    expect(cfg.model.cardMatchP).toBe(0.5);
    const vector = features([
      snapCard('1', 'love', 0.5),
      snapCard('2', 'must', 0.5),
      snapCard('3', 'like', 0.4999),
      snapCard('4', 'like', null),
      snapCard('5', 'never', 0.99),
    ]);
    expect(vector['matched_log']).toBeCloseTo(Math.log(3), 12);
    expect(features([snapCard('1', 'love', 0.4999)])['matched_log']).toBe(0);
  });

  it('matched_log follows a configured cardMatchP', () => {
    const custom = { ...cfg, model: { ...cfg.model, cardMatchP: 0.8 } };
    const vector = snapshotFeatures(
      snap([snapCard('1', 'love', 0.8), snapCard('2', 'love', 0.79)]),
      custom,
      [],
    );
    expect(vector['matched_log']).toBeCloseTo(Math.log(2), 12);
  });

  it('cardscore is the cards-only score of spec 06 §4.1 under the strength weights', () => {
    const cards = [
      snapCard('1', 'must', 0.5),
      snapCard('2', 'love', 0.7),
      snapCard('3', 'like', 1),
      snapCard('4', 'never', 1),
      snapCard('5', 'love', null),
    ];
    expect(snapshotCardScore(snap(cards), cfg.strengthWeights)).toBeCloseTo(0.8, 12);
    expect(features(cards)['cardscore']).toBe(snapshotCardScore(snap(cards), cfg.strengthWeights));
    const light = [snapCard('1', 'like', 0.5)];
    expect(snapshotCardScore(snap(light), cfg.strengthWeights)).toBeCloseTo(0.4, 12);
    expect(features(light)['cardscore']).toBeCloseTo(0.4, 12);
    const weights = { must: 1, love: 0.5, like: 0.1 };
    expect(snapshotCardScore(snap(cards), weights)).toBeCloseTo(0.5, 12);
    const reweighted = snapshotFeatures(snap(cards), { ...cfg, strengthWeights: weights }, []);
    expect(reweighted['cardscore']).toBeCloseTo(0.5, 12);
  });

  it('never cards and unanswered cards give no card score', () => {
    expect(snapshotCardScore(snap([snapCard('1', 'never', 0.9)]), cfg.strengthWeights)).toBeNull();
    expect(snapshotCardScore(snap([snapCard('1', 'love', null)]), cfg.strengthWeights)).toBeNull();
  });

  it('own card inputs carry p with a mask, and are 0/0 when the card is absent or unanswered', () => {
    const vector = features(
      [snapCard('10', 'love', 0.9), snapCard('11', 'like', null), snapCard('13', 'never', 0.8)],
      {},
      ['10', '11', '13', '99'],
    );
    expect([vector['card.10'], vector['known.card.10']]).toEqual([0.9, 1]);
    expect([vector['card.11'], vector['known.card.11']]).toEqual([0, 0]);
    expect([vector['card.13'], vector['known.card.13']]).toEqual([0.8, 1]);
    expect([vector['card.99'], vector['known.card.99']]).toEqual([0, 0]);
    expect(vector).not.toHaveProperty('card.12');
  });

  it('cards that are not own inputs get no card.<id> key', () => {
    const vector = features([snapCard('10', 'love', 0.9)], {}, []);
    expect(Object.keys(vector).filter((name) => name.startsWith('card.'))).toEqual([]);
    expect(Object.keys(vector).filter((name) => name.startsWith('known.card.'))).toEqual([]);
  });
});

describe('snapshot strength', () => {
  it('uses the strength recorded in the snapshot, not the card’s current strength', () => {
    const recorded = snap([snapCard('10', 'love', 0.9)]);
    const stored = snapshotFeatures(recorded, cfg, ['10']);
    expect(stored['best.love']).toBe(0.9);
    expect(stored['best.like']).toBe(0);
    expect(stored['known.best.like']).toBe(0);
    expect(stored['cardscore']).toBe(0.9);

    const later: RankCard[] = [card('10', 'like')];
    const now = new Date('2026-10-10T12:00:00.000Z');
    const live = itemFeatures(
      later,
      liveItem({ cardAnswers: answers({ '10': 0.9 }) }, now),
      now,
      cfg,
      ['10'],
    );
    expect(live['best.like']).toBe(0.9);
    expect(live['best.love']).toBe(0);
    expect(live['cardscore']).toBeCloseTo(0.72, 12);

    expect(snapshotFeatures(recorded, cfg, ['10'])).toEqual(stored);
  });
});

const NOW = new Date('2026-10-10T12:00:00.000Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

function liveItem(over: Partial<RankItem> = {}, now: Date = NOW): RankItem {
  return {
    articleId: '500',
    feedIds: ['57'],
    inferenceFeedIds: ['57'],
    inferenceEligible: true,
    explicitSelection: false,
    domain: 'example.com',
    author: null,
    titleNorm: 'title',
    excerptNorm: 'excerpt',
    firstSeenAt: new Date(now.getTime() - 30 * 3_600_000),
    contentRevision: '3',
    wordCount: 800,
    hasImage: false,
    lang: 'en',
    hasVideo: false,
    bodyImageCount: 0,
    mediaRevision: '1',
    clusterSize: 0,
    pipelineState: 'ready',
    matchCoverage: 'complete',
    facets: {},
    facetsEngine: 'typesafe',
    cardAnswers: {},
    labelIds: [],
    ...over,
  };
}

const SEEDED_LIVE_CARDS: RankCard[] = [
  card('10', 'love'),
  card('11', 'love'),
  card('12', 'like'),
  card('13', 'never'),
  card('14', 'never'),
];

const seededLiveItem = (over: Partial<RankItem> = {}): RankItem =>
  liveItem({
    cardAnswers: answers({ '10': 0.9, '11': 0.5, '12': 0.7, '13': 0.8, '14': 0.3 }),
    facets: SEEDED_FACETS,
    lang: 'sk',
    hasImage: true,
    bodyImageCount: 2,
    clusterId: '44',
    clusterSize: 3,
    inferenceFeedIds: ['57'],
    feedIds: ['57'],
    author: 'Ján Novák',
    ...over,
  });

describe('itemFeatures: train and serve agree', () => {
  it('gives the seeded snapshot’s vector for an item that mirrors it', () => {
    const live = itemFeatures(SEEDED_LIVE_CARDS, seededLiveItem(), NOW, cfg, ['10']);
    expect(live).toEqual(SEEDED_VECTOR);
    expect(live).toEqual(snapshotFeatures(snap(SEEDED_CARDS, SEEDED_VALUES), cfg, ['10']));
  });

  it('takes the lowest numeric id of inferenceFeedIds, not the first or the lowest string', () => {
    const live = itemFeatures(
      [],
      liveItem({ inferenceFeedIds: ['120', '57'], feedIds: ['120', '57'] }),
      NOW,
      cfg,
      [],
    );
    expect(hot(live, FEED)).toEqual(['feed.h12']);
  });

  it('age is measured from the older of publishedAt and firstSeenAt at now', () => {
    const fresh = liveItem({ firstSeenAt: hoursAgo(2) });
    expect(hot(itemFeatures([], fresh, NOW, cfg, []), AGE)).toEqual(['age.lt6h']);
    const published = liveItem({ firstSeenAt: hoursAgo(2), publishedAt: hoursAgo(30) });
    expect(hot(itemFeatures([], published, NOW, cfg, []), AGE)).toEqual(['age.lt72h']);
    const lateFeed = liveItem({ firstSeenAt: hoursAgo(2), publishedAt: hoursAgo(1) });
    expect(hot(itemFeatures([], lateFeed, NOW, cfg, []), AGE)).toEqual(['age.lt6h']);
    expect(
      hot(itemFeatures([], fresh, new Date(NOW.getTime() + 4 * 3_600_000), cfg, []), AGE),
    ).toEqual(['age.lt24h']);
    const edge = liveItem({ firstSeenAt: hoursAgo(72) });
    expect(hot(itemFeatures([], edge, NOW, cfg, []), AGE)).toEqual(['age.older']);
  });

  it('media, length and language follow the item’s null handling', () => {
    const unknown = itemFeatures(
      [],
      liveItem({ hasVideo: null, bodyImageCount: null, wordCount: null, lang: 'de' }),
      NOW,
      cfg,
      [],
    );
    expect([unknown['has_video'], unknown['known.has_video']]).toEqual([0, 0]);
    expect(hot(unknown, IMG)).toEqual(['img.unknown']);
    expect(hot(unknown, LEN)).toEqual(['len.unknown']);
    expect(hot(unknown, LANG)).toEqual(['lang.other']);
    const video = itemFeatures(
      [],
      liveItem({ hasVideo: true, bodyImageCount: 6, wordCount: 1000 }),
      NOW,
      cfg,
      [],
    );
    expect([video['has_video'], video['known.has_video']]).toEqual([1, 1]);
    expect(hot(video, IMG)).toEqual(['img.heavy']);
  });

  it('a missing author or feed sets no source bucket', () => {
    const live = itemFeatures([], liveItem({ author: null, inferenceFeedIds: [] }), NOW, cfg, []);
    expect(hot(live, AUTHOR)).toEqual([]);
    expect(hot(live, FEED)).toEqual([]);
  });

  it('a scope-excluded card is missing; a scoped card in scope counts', () => {
    const cards = [card('1', 'love', { scopeFeedId: '999' }), card('2', 'like')];
    const out = itemFeatures(
      cards,
      liveItem({ cardAnswers: answers({ '1': 0.99, '2': 0.4 }) }),
      NOW,
      cfg,
      ['1'],
    );
    expect([out['best.love'], out['known.best.love']]).toEqual([0, 0]);
    expect([out['card.1'], out['known.card.1']]).toEqual([0, 0]);
    expect(out['best.like']).toBe(0.4);
    const inScope = itemFeatures(
      cards,
      liveItem({ cardAnswers: answers({ '1': 0.99, '2': 0.4 }), inferenceFeedIds: ['999'] }),
      NOW,
      cfg,
      ['1'],
    );
    expect([inScope['best.love'], inScope['card.1'], inScope['known.card.1']]).toEqual([
      0.99, 0.99, 1,
    ]);
  });

  it('a never card without a usable answer breaks never coverage', () => {
    const partial = itemFeatures(
      SEEDED_LIVE_CARDS,
      seededLiveItem({ cardAnswers: answers({ '10': 0.9, '12': 0.7, '13': 0.8 }) }),
      NOW,
      cfg,
      [],
    );
    expect([partial['best.never'], partial['known.best.never']]).toEqual([0, 0]);
    const prefilter = itemFeatures(
      SEEDED_LIVE_CARDS,
      seededLiveItem({
        cardAnswers: answers({
          '10': 0.9,
          '13': 0.8,
          '14': { p: 0.3, engine: 'prefilter' },
        }),
      }),
      NOW,
      cfg,
      ['14'],
    );
    expect([prefilter['best.never'], prefilter['known.best.never']]).toEqual([0, 0]);
    expect([prefilter['card.14'], prefilter['known.card.14']]).toEqual([0, 0]);
  });

  it('cluster_log is ln(1 + clusterSize); an unclustered live item has size 1', () => {
    const live = itemFeatures([], liveItem({ clusterId: undefined, clusterSize: 1 }), NOW, cfg, []);
    expect(live['cluster_log']).toBeCloseTo(Math.log(2), 12);
  });
});

describe('FEATURE_SPEC_V1 sha', () => {
  type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

  /** Clone with every leaf equal to `from` replaced by `to`; returns the clone and the hit count. */
  function replaceLeaf(value: Json, from: number | string, to: number | string): [Json, number] {
    if (Array.isArray(value)) {
      let hits = 0;
      const out = value.map((item) => {
        const [next, n] = replaceLeaf(item, from, to);
        hits += n;
        return next;
      });
      return [out, hits];
    }
    if (typeof value === 'object' && value !== null) {
      let hits = 0;
      const out: { [key: string]: Json } = {};
      for (const [key, item] of Object.entries(value)) {
        const [next, n] = replaceLeaf(item, from, to);
        hits += n;
        out[key] = next;
      }
      return [out, hits];
    }
    return value === from ? [to, 1] : [value, 0];
  }

  const descriptor = (): Json => structuredClone(FEATURE_SPEC_V1_DESCRIPTOR) as unknown as Json;

  it('is a 64-hex sha256 of the descriptor', () => {
    expect(FEATURE_SPEC_V1_SHA).toMatch(/^[0-9a-f]{64}$/);
    expect(featureSpecSha(FEATURE_SPEC_V1_DESCRIPTOR)).toBe(FEATURE_SPEC_V1_SHA);
  });

  it('is pinned', () => {
    expect(FEATURE_SPEC_V1_SHA).toBe('e60f151f433ce82bb85bd811df56a4588f6a2e7eefba6dd103a54e376638816c');
  });

  it('does not depend on object key order', () => {
    const shuffled = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(shuffled);
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, shuffled(item)]),
        );
      }
      return value;
    };
    expect(featureSpecSha(shuffled(descriptor()) as never)).toBe(FEATURE_SPEC_V1_SHA);
    expect(featureSpecSha(descriptor() as never)).toBe(FEATURE_SPEC_V1_SHA);
  });

  it.each([
    ['the short length edge', 150, 151],
    ['the medium length edge', 600, 601],
    ['the long length edge', 1500, 1501],
    ['the 6 h age edge', 6, 7],
    ['the 72 h age edge', 72, 73],
    ['the feed bucket count', 32, 31],
    ['the author bucket count', 16, 17],
    ['the image word floor', 500, 501],
    ['the image-density heavy edge', 3, 4],
  ])('changes when %s changes', (_name, from, to) => {
    const [changed, hits] = replaceLeaf(descriptor(), from, to);
    expect(hits).toBeGreaterThan(0);
    expect(featureSpecSha(changed as never)).not.toBe(FEATURE_SPEC_V1_SHA);
  });

  it.each([
    ['a card-group name', 'best.must', 'best.musk'],
    ['a facet name', 'ct.news_report', 'ct.news'],
    ['a media name', 'img.moderate', 'img.medium'],
  ])('changes when %s changes', (_name, from, to) => {
    const [changed, hits] = replaceLeaf(descriptor(), from, to);
    expect(hits).toBeGreaterThan(0);
    expect(featureSpecSha(changed as never)).not.toBe(FEATURE_SPEC_V1_SHA);
  });
});
