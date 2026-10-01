import type { RankItem, RankRule, UserRankContext } from '../src/index.js';
import { buildBm25Corpus, DEFAULT_RANKER_CONFIG } from '../src/index.js';

export const NOW = new Date('2026-10-01T12:00:00.000Z');
export const HOUR = 3_600_000;
export const CONTEXT_SHA = 'c'.repeat(64);
export const DEGRADED_SHA = 'd'.repeat(64);

/** Facets of an ordinary, unremarkable article (no quality flag triggers). */
export const PLAIN_FACETS: Readonly<Record<string, number>> = Object.freeze({
  'ct.news': 0.7,
  'ct.analysis': 0.2,
  't1.science': 0.6,
  't1.technology': 0.3,
  't2.science.energy': 0.4,
  't2.science.space': 0.1,
  depth: 0.5,
  depth_conf: 0.8,
  clickbait: 0.1,
  promotional: 0.05,
  time_sensitive: 0.2,
  evergreen: 0.6,
  paywall_teaser: 0.1,
  tone: 0.5,
});

/** An inference-eligible, matched article carried by feed 1, first seen an hour ago. */
export function item(overrides: Partial<RankItem> = {}): RankItem {
  return {
    articleId: '100',
    feedIds: ['1'],
    inferenceFeedIds: ['1'],
    inferenceEligible: true,
    explicitSelection: false,
    domain: 'example.com',
    author: 'Jana Nováková',
    titleNorm: 'battery prices fall again',
    excerptNorm: 'lithium cells are cheaper than ever',
    firstSeenAt: new Date(NOW.getTime() - HOUR),
    publishedAt: new Date(NOW.getTime() - 2 * HOUR),
    contentRevision: '3',
    wordCount: 600,
    hasImage: true,
    lang: 'en',
    hasVideo: false,
    bodyImageCount: 1,
    mediaRevision: '1',
    clusterSize: 1,
    pipelineState: 'matched',
    matchCoverage: 'complete',
    facets: PLAIN_FACETS,
    facetsEngine: 'typesafe',
    cardAnswers: {},
    labelIds: [],
    ...overrides,
  };
}

/** A user with default config and preferences, no cards, rules or history. */
export function context(overrides: Partial<UserRankContext> = {}): UserRankContext {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    rankRevision: '7',
    contextSha: CONTEXT_SHA,
    degradedContextSha: DEGRADED_SHA,
    config: DEFAULT_RANKER_CONFIG,
    cards: [],
    labels: [],
    rules: [],
    demote: { clickbait: 'auto', promotional: 'auto', shallow: 'auto', stale: 'auto' },
    reasonCounts90d: {},
    staleDislikes90d: 0,
    readClusterIds: new Set(),
    bm25: buildBm25Corpus([]),
    ...overrides,
  };
}

let nextRuleId = 1;

export function rule(
  kind: RankRule['kind'],
  value: string,
  extra: Partial<RankRule> = {},
): RankRule {
  nextRuleId += 1;
  return { id: String(nextRuleId), kind, value, ...extra };
}
