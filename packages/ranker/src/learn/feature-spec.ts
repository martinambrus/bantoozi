import { canonicalSha256, sha256Hex } from '@bantoozi/shared/server';

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
] as const;

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
] as const;

const SCOPES = ['global', 'national', 'regional_or_city', 'not_geographic'] as const;

/** Bin edges and bucket counts of `FEATURE_SPEC_V1`; the builder and the descriptor share them. */
export const FEATURE_BINS = {
  len: [150, 600, 1500],
  ageHours: [6, 24, 72],
  img: { floorWords: 500, light: 1, heavy: 3 },
} as const;
export const FEED_BUCKETS = 32;
export const AUTHOR_BUCKETS = 16;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The 44 facet inputs of `FEATURE_SPEC_V1` in order (spec 06 §8.1); no level-2 feature. */
export const FEATURE_SPEC_V1_FACET_NAMES: readonly string[] = [
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
];

/** The 124 fixed feature names of `FEATURE_SPEC_V1` in canonical order (spec 06 §8.1). */
export const FEATURE_SPEC_V1_NAMES: readonly string[] = [
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
  ...FEATURE_SPEC_V1_FACET_NAMES,
  'len.short',
  'len.medium',
  'len.long',
  'len.very_long',
  'len.unknown',
  'age.lt6h',
  'age.lt24h',
  'age.lt72h',
  'age.older',
  'lang.en',
  'lang.sk',
  'lang.cs',
  'lang.other',
  'has_video',
  'known.has_video',
  'img.none',
  'img.light',
  'img.moderate',
  'img.heavy',
  'img.unknown',
  'has_image',
  'cluster_log',
  ...range(FEED_BUCKETS).map((k) => `feed.h${k}`),
  ...range(AUTHOR_BUCKETS).map((k) => `author.h${k}`),
];

/** The descriptor whose canonical sha identifies the feature spec (spec 06 §8.1). */
export const FEATURE_SPEC_V1_DESCRIPTOR = {
  name: 'FEATURE_SPEC_V1',
  engineFamily: 'typesafe',
  rawSnapshotSpec: 'bantoozi:feature-snapshot:raw-v1',
  facetBuilder: 'facets-v1',
  features: FEATURE_SPEC_V1_NAMES,
  dynamic: ['card.<id>', 'known.card.<id>'],
  bins: {
    len: FEATURE_BINS.len,
    ageHours: FEATURE_BINS.ageHours,
    img: FEATURE_BINS.img,
  },
  hash: {
    alg: 'murmur3_x86_32',
    seed: 0,
    feedBuckets: FEED_BUCKETS,
    authorBuckets: AUTHOR_BUCKETS,
    author: 'normalizeText',
  },
  groupRules: 'v1',
  ownInputRule: {
    version: 1,
    needsLikeAndDislike: true,
    keys: ['cardMatchP', 'cardMinMatched'],
  },
  clusterLog: 'ln(1+max(1,size))',
} as const;

/** The sha256 of a feature-spec descriptor's canonical JSON (spec 06 §8.1). */
export function featureSpecSha(descriptor: typeof FEATURE_SPEC_V1_DESCRIPTOR): string {
  return canonicalSha256(descriptor);
}

/** The sha stored with every model and snapshot that uses `FEATURE_SPEC_V1`. */
export const FEATURE_SPEC_V1_SHA: string = featureSpecSha(FEATURE_SPEC_V1_DESCRIPTOR);

/**
 * Identity of the raw event-time snapshot the API stamps as `features.specSha` (spec 06 §8.2, D-128);
 * FEATURE_SPEC_V1 derives its inputs from that snapshot at training time.
 */
export const RAW_SNAPSHOT_SPEC_SHA: string = sha256Hex('bantoozi:feature-snapshot:raw-v1');
