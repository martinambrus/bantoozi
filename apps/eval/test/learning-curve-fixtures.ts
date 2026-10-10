import { ENRICH_V1, L1_IDS } from '@bantoozi/questions';

import { createRng } from '../src/metrics/index.js';
import type { RawAnswer, RawRun } from '../src/report/run-data.js';

/**
 * Synthetic learning-curve data: a hidden per-article truth drives every rater's rating, the card
 * answers (`perfect` copies the taste, `weak` is noise) and the facet answers (`informative` follows
 * the truth, `noise` does not). Ratings arrive in a shuffled order, interleaved across dev and test.
 */
export interface CurveFixtureOptions {
  raters?: number;
  devArticles?: number;
  testArticles?: number;
  cards?: 'perfect' | 'weak';
  facets?: 'informative' | 'noise';
  seed?: string;
  articleIds?: readonly string[];
  cardIds?: Readonly<Record<string, string>>;
  firstRatingAt?: string;
  dataset?: { version: string; snapshotSha: string; splitSha: string };
}

export interface CurveFixture {
  run: RawRun;
  answers: RawAnswer[];
  raterIds: string[];
  sampleRows: {
    articleId: string;
    lang: string;
    split: 'dev' | 'test';
    snapshot: Record<string, unknown>;
  }[];
  ratings: {
    raterId: string;
    articleId: string;
    rating: 1 | -1;
    reason: null;
    createdAt: string;
  }[];
  dataset: { version: string; snapshotSha: string; splitSha: string };
  cardIdOf: (raterId: string) => string;
}

const CONTENT_TYPES = Object.keys(ENRICH_V1.questions.content_type.criteria);
const SCOPES = Object.keys(ENRICH_V1.questions.local_scope.criteria);
const DEPTH_LEVELS = ENRICH_V1.questions.depth.criteria.length;
const TONE_LEVELS = ENRICH_V1.questions.tone.criteria.length;

function distribution(keys: readonly string[], rng: { next(): number }): Record<string, number> {
  const raw = keys.map(() => rng.next() + 0.01);
  const total = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((key, i) => [key, (raw[i] ?? 0) / total]));
}

export function buildCurveFixture(options: CurveFixtureOptions = {}): CurveFixture {
  const raterCount = options.raters ?? 2;
  const devArticles = options.devArticles ?? 120;
  const testArticles = options.testArticles ?? 60;
  const cardMode = options.cards ?? 'weak';
  const facetMode = options.facets ?? 'informative';
  const rng = createRng(options.seed ?? 'curve');
  const dataset = options.dataset ?? {
    version: 'golden-v3',
    snapshotSha: 'a'.repeat(64),
    splitSha: 'b'.repeat(64),
  };
  const raterIds = Array.from({ length: raterCount }, (_, i) => String(i + 1));
  const cardIdOf = (raterId: string): string => options.cardIds?.[raterId] ?? `90${raterId}`;
  const startAt = Date.parse(options.firstRatingAt ?? '2026-09-10T08:00:00.000Z');

  const total = devArticles + testArticles;
  const sampleRows: CurveFixture['sampleRows'] = [];
  const truth = new Map<string, number>();
  for (let i = 0; i < total; i += 1) {
    const articleId = options.articleIds?.[i] ?? String(2000 + i);
    const split = i < devArticles ? 'dev' : 'test';
    const group = `t${Math.floor(i / 2)}`;
    truth.set(articleId, rng.next());
    sampleRows.push({
      articleId,
      lang: 'en',
      split,
      snapshot: {
        v: 1,
        articleId,
        lang: 'en',
        input: {
          title: `Title ${articleId}`,
          author: `Author ${i % 5}`,
          wordCount: 200 + ((i * 37) % 900),
        },
        publishedAt: new Date(startAt - 3 * 3_600_000).toISOString(),
        firstSeenAt: new Date(startAt - 2 * 3_600_000).toISOString(),
        canonicalFeedId: '12',
        carrierFeeds: [
          { feedId: '12', title: null, firstSeenAt: new Date(startAt).toISOString() },
          { feedId: '7', title: null, firstSeenAt: new Date(startAt).toISOString() },
        ],
        storyGroupId: group,
      },
    });
  }

  const ratings: CurveFixture['ratings'] = [];
  const answers: RawAnswer[] = [];
  const tasteOf = (raterId: string, articleId: string): number => {
    const t = truth.get(articleId) ?? 0;
    return raterId === '2' ? (t + 0.15) % 1 : t;
  };
  for (const raterId of raterIds) {
    const order = sampleRows.map((row) => row.articleId);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = rng.int(i + 1);
      [order[i], order[j]] = [order[j] as string, order[i] as string];
    }
    order.forEach((articleId, k) => {
      const taste = tasteOf(raterId, articleId);
      ratings.push({
        raterId,
        articleId,
        rating: taste > 0.5 ? 1 : -1,
        reason: null,
        createdAt: new Date(startAt + k * 3_600_000).toISOString(),
      });
      answers.push({
        articleId,
        cardId: cardIdOf(raterId),
        questionKey: 'card',
        answer: {
          ok: true,
          p: cardMode === 'perfect' ? taste : rng.next(),
          engine: 'typesafe',
        },
      });
    });
  }

  for (const row of sampleRows) {
    const t = truth.get(row.articleId) ?? 0;
    const informative = facetMode === 'informative';
    const noul = (key: string, p: number): RawAnswer => ({
      articleId: row.articleId,
      cardId: null,
      questionKey: `enrich.${key}`,
      answer: { ok: true, answer: { type: 'noul', p }, engine: 'typesafe' },
    });
    const score = (key: string, levels: number, value: number): RawAnswer => ({
      articleId: row.articleId,
      cardId: null,
      questionKey: `enrich.${key}`,
      answer: {
        ok: true,
        answer: {
          type: 'score',
          score: Math.round(value * (levels - 1)),
          probabilities: Array.from({ length: levels }, () => 1 / levels),
          confidence: 0.5,
          levels,
        },
        engine: 'typesafe',
      },
    });
    const choice = (key: string, keys: readonly string[]): RawAnswer => {
      const probabilities = distribution(keys, rng);
      return {
        articleId: row.articleId,
        cardId: null,
        questionKey: `enrich.${key}`,
        answer: {
          ok: true,
          answer: { type: 'choice', choice: keys[0] ?? '', probabilities, confidence: 0.6 },
          engine: 'typesafe',
        },
      };
    };
    answers.push(
      choice('content_type', CONTENT_TYPES),
      choice('topic_l1', L1_IDS),
      choice('local_scope', SCOPES),
      score('depth', DEPTH_LEVELS, informative ? t : rng.next()),
      score('tone', TONE_LEVELS, rng.next()),
      noul('clickbait', informative ? 1 - t : rng.next()),
      noul('promotional', rng.next()),
      noul('time_sensitive', rng.next()),
      noul('evergreen', informative ? t : rng.next()),
      noul('paywall_teaser', rng.next()),
    );
  }

  const run: RawRun = {
    id: '34',
    experiment: 'E1',
    datasetVersion: dataset.version,
    gitSha: 'f'.repeat(40),
    startedAt: new Date('2026-09-25T00:00:00Z'),
    finishedAt: new Date('2026-09-25T01:00:00Z'),
    config: {
      experiment: 'E1',
      variant: { state: 'native', cards: 'as_written' },
      datasetVersion: dataset.version,
      snapshotSha: dataset.snapshotSha,
      splitSha: dataset.splitSha,
      configSha: 'c'.repeat(64),
      seed: 'fixture',
      langs: ['en'],
      raters: raterIds.map((raterId) => ({
        raterId,
        participantKey: 'owner',
        contextName: `ctx${raterId}`,
        langs: ['en'],
      })),
      cohort: { articleIds: sampleRows.map((r) => r.articleId), sha: 'd'.repeat(64) },
      ratings,
      cards: raterIds.map((raterId) => ({
        raterId,
        cardId: cardIdOf(raterId),
        strength: 'like',
        lang: 'en',
        interest: 'something',
      })),
      facetLabels: [],
      maxUsd: 10,
    },
    results: { status: 'complete' },
  };
  return { run, answers, raterIds, sampleRows, ratings, dataset, cardIdOf };
}
