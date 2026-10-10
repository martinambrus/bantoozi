import { compareBigIntStrings, normalizeText, type Strength } from '@bantoozi/shared';

import { isCardApplicable, usableAnswer } from '../cards.js';
import type { ReadonlyRankerConfig } from '../config.js';
import { isProbability } from '../lanes.js';
import type { RankCard, RankItem } from '../types.js';
import {
  AUTHOR_BUCKETS,
  FEATURE_BINS,
  FEATURE_SPEC_V1_FACET_NAMES,
  FEATURE_SPEC_V1_NAMES,
  FEED_BUCKETS,
} from './feature-spec.js';
import { murmur3 } from './murmur3.js';

/**
 * The raw event-time snapshot (spec 06 §8.1, D-128): what the feature builder reads. Card answers
 * keep the strength held at event time; `p` is null for a card without a usable answer.
 */
export interface RawFeatureSnapshot {
  specSha: string;
  ratingSha: string;
  snapshotAt: string;
  cards: readonly {
    id: string;
    strength: Strength;
    p: number | null;
    engine: string | null;
  }[];
  values: {
    facets: Readonly<Record<string, number>> | null;
    facetsEngine: string | null;
    wordCount: number | null;
    ageHours: number;
    lang: string | null;
    hasImage?: boolean | null | undefined;
    hasVideo: boolean | null;
    bodyImageCount: number | null;
    clusterId: string | null;
    clusterSize: number;
    sourceFeedId: string | null;
    author: string | null;
  };
}

type FeatureConfig = Pick<ReadonlyRankerConfig, 'strengthWeights'> & {
  model: Pick<ReadonlyRankerConfig['model'], 'cardMatchP'>;
};
type SnapshotCard = RawFeatureSnapshot['cards'][number];

const STRENGTHS = ['must', 'love', 'like', 'never'] as const;
const LEN_NAMES = ['short', 'medium', 'long', 'very_long'] as const;
const AGE_NAMES = ['lt6h', 'lt24h', 'lt72h', 'older'] as const;
const LANGS: ReadonlySet<string> = new Set(['en', 'sk', 'cs']);

function usableP(card: SnapshotCard): number | null {
  return card.engine !== 'prefilter' && isProbability(card.p) ? card.p : null;
}

function binIndex(value: number, edges: readonly number[]): number {
  const index = edges.findIndex((edge) => value < edge);
  return index === -1 ? edges.length : index;
}

function imageBucket(count: number | null, words: number | null): string {
  if (count === null || words === null) return 'unknown';
  if (count === 0) return 'none';
  const { floorWords, light, heavy } = FEATURE_BINS.img;
  const density = (count * floorWords) / Math.max(words, floorWords);
  if (density < light) return 'light';
  return density >= heavy ? 'heavy' : 'moderate';
}

/**
 * The cards-only score of spec 06 §4.1 over a snapshot: the maximum of `strengthWeights[strength] ×
 * p` over the positive cards with a usable answer, or `null` when there is none.
 */
export function snapshotCardScore(
  snapshot: Pick<RawFeatureSnapshot, 'cards'>,
  strengthWeights: ReadonlyRankerConfig['strengthWeights'],
): number | null {
  let best: number | null = null;
  for (const card of snapshot.cards) {
    if (card.strength === 'never') continue;
    const p = usableP(card);
    if (p === null) continue;
    const score = strengthWeights[card.strength] * p;
    if (best === null || score > best) best = score;
  }
  return best;
}

/**
 * The `FEATURE_SPEC_V1` vector of a stored snapshot (spec 06 §8.1): the 124 fixed features plus
 * `card.<id>` and `known.card.<id>` for each own card input. Unknown inputs are 0 with a mask; the
 * facets copy each valid [0, 1] value and leave an absent or invalid one 0 (eligibility is the model's).
 */
export function snapshotFeatures(
  snapshot: RawFeatureSnapshot,
  config: FeatureConfig,
  ownInputIds: readonly string[],
): Record<string, number> {
  const vector: Record<string, number> = Object.fromEntries(
    FEATURE_SPEC_V1_NAMES.map((name) => [name, 0]),
  );
  const { values } = snapshot;

  const best: Record<string, number | undefined> = {};
  const neverCards = snapshot.cards.filter((card) => card.strength === 'never');
  let matched = 0;
  for (const card of snapshot.cards) {
    const p = usableP(card);
    if (p === null) continue;
    if (card.strength !== 'never' && p >= config.model.cardMatchP) matched += 1;
    const current = best[card.strength];
    if (current === undefined || p > current) best[card.strength] = p;
  }
  const neverComplete = neverCards.every((card) => usableP(card) !== null);
  for (const strength of STRENGTHS) {
    const value = best[strength];
    if (value === undefined || (strength === 'never' && !neverComplete)) continue;
    vector[`best.${strength}`] = value;
    vector[`known.best.${strength}`] = 1;
  }
  vector['matched_log'] = Math.log(1 + matched);
  vector['cardscore'] = snapshotCardScore(snapshot, config.strengthWeights) ?? 0;

  const { facets } = values;
  if (facets !== null && facets !== undefined) {
    for (const name of FEATURE_SPEC_V1_FACET_NAMES) {
      const value: unknown = Object.hasOwn(facets, name) ? facets[name] : undefined;
      vector[name] = isProbability(value) ? value : 0;
    }
  }

  if (values.wordCount === null) vector['len.unknown'] = 1;
  else {
    const name = LEN_NAMES[binIndex(values.wordCount, FEATURE_BINS.len)];
    vector[`len.${name}`] = 1;
  }
  vector[`age.${AGE_NAMES[binIndex(values.ageHours, FEATURE_BINS.ageHours)]}`] = 1;
  vector[`lang.${values.lang !== null && LANGS.has(values.lang) ? values.lang : 'other'}`] = 1;
  if (typeof values.hasVideo === 'boolean') {
    vector['has_video'] = values.hasVideo ? 1 : 0;
    vector['known.has_video'] = 1;
  }
  vector[`img.${imageBucket(values.bodyImageCount, values.wordCount)}`] = 1;
  vector['has_image'] = values.hasImage === true ? 1 : 0;
  vector['cluster_log'] = Math.log(1 + Math.max(1, values.clusterSize));

  if (values.sourceFeedId !== null) {
    vector[`feed.h${murmur3(values.sourceFeedId) % FEED_BUCKETS}`] = 1;
  }
  const author = values.author === null ? '' : normalizeText(values.author);
  if (author !== '') vector[`author.h${murmur3(author) % AUTHOR_BUCKETS}`] = 1;

  for (const id of ownInputIds) {
    const own = snapshot.cards.find((card) => card.id === id);
    const p = own === undefined ? null : usableP(own);
    vector[`card.${id}`] = p ?? 0;
    vector[`known.card.${id}`] = p === null ? 0 : 1;
  }
  return vector;
}

/**
 * The same vector for a live item (spec 06 §8.1): the item and the user's current cards are turned
 * into the snapshot shape (scope-excluded cards are absent, unusable answers are null) and run
 * through {@link snapshotFeatures}, so training and serving cannot drift.
 */
export function itemFeatures(
  cards: readonly RankCard[],
  item: RankItem,
  now: Date,
  config: FeatureConfig,
  ownInputIds: readonly string[],
): Record<string, number> {
  const snapshotCards = cards
    .filter((card) => isCardApplicable(card, item.inferenceFeedIds))
    .map((card): SnapshotCard => {
      const answer = usableAnswer(item.cardAnswers, card.cardId);
      return {
        id: card.cardId,
        strength: card.strength,
        p: answer?.p ?? null,
        engine: answer?.engine ?? null,
      };
    });
  const since = Math.min(item.firstSeenAt.getTime(), item.publishedAt?.getTime() ?? Infinity);
  const sourceFeedId = [...item.inferenceFeedIds].sort(compareBigIntStrings)[0] ?? null;
  return snapshotFeatures(
    {
      specSha: '',
      ratingSha: '',
      snapshotAt: now.toISOString(),
      cards: snapshotCards,
      values: {
        facets: item.facets ?? null,
        facetsEngine: item.facetsEngine ?? null,
        wordCount: item.wordCount,
        ageHours: Math.max(0, (now.getTime() - since) / 3_600_000),
        lang: item.lang,
        hasImage: item.hasImage,
        hasVideo: item.hasVideo,
        bodyImageCount: item.bodyImageCount,
        clusterId: item.clusterId ?? null,
        clusterSize: item.clusterSize,
        sourceFeedId,
        author: item.author,
      },
    },
    config,
    ownInputIds,
  );
}
