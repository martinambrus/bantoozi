import { flattenFacets, type Answer } from '@bantoozi/questions';
import {
  RAW_SNAPSHOT_SPEC_SHA,
  type HeldCard,
  type RawFeatureSnapshot,
  type TrainingSample,
} from '@bantoozi/ranker';
import { compareBigIntStrings } from '@bantoozi/shared';
import { z } from 'zod';

import { raterCardResults, type RunData } from '../report/run-data.js';

const HOUR_MS = 3_600_000;

const SnapshotSchema = z.looseObject({
  storyGroupId: z.string().min(1).nullish(),
  firstSeenAt: z.string().min(1),
  publishedAt: z.string().nullish(),
  carrierFeeds: z.array(z.looseObject({ feedId: z.string().min(1) })).default([]),
  input: z.looseObject({ wordCount: z.number().nullish(), author: z.string().nullish() }).nullish(),
});

/** What the feature snapshot of an article needs from its frozen `eval.sample` row. */
export interface LearningArticle {
  articleId: string;
  lang: string;
  split: 'dev' | 'test';
  storyGroupId: string | null;
  /** Epoch ms. */
  firstSeenAt: number;
  publishedAt: number | null;
  wordCount: number | null;
  author: string | null;
  /** The lowest numeric carrier feed id. */
  sourceFeedId: string | null;
}

/** Parse one sample row into the fields the learning curve reads. */
export function learningArticle(row: {
  articleId: string;
  lang: string;
  split: string;
  snapshot: Record<string, unknown>;
}): LearningArticle {
  if (row.split !== 'dev' && row.split !== 'test') {
    throw new RangeError(`article ${row.articleId} has split ${row.split}`);
  }
  const snapshot = SnapshotSchema.parse(row.snapshot);
  const firstSeenAt = Date.parse(snapshot.firstSeenAt);
  const publishedAt = snapshot.publishedAt == null ? Number.NaN : Date.parse(snapshot.publishedAt);
  const feeds = snapshot.carrierFeeds
    .map((carrier) => carrier.feedId)
    .filter((id) => /^\d+$/.test(id))
    .sort(compareBigIntStrings);
  return {
    articleId: row.articleId,
    lang: row.lang,
    split: row.split,
    storyGroupId: snapshot.storyGroupId ?? null,
    firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : 0,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    wordCount: snapshot.input?.wordCount ?? null,
    author: snapshot.input?.author ?? null,
    sourceFeedId: feeds[0] ?? null,
  };
}

/** One rater's stored ratings as training samples: development in arrival order, test apart. */
export interface RaterSamples {
  raterId: string;
  participantKey: string;
  dev: TrainingSample[];
  test: TrainingSample[];
  heldCards: HeldCard[];
  /** The rater's last rating time: the trainer's `now`; null without ratings. */
  now: Date | null;
}

function facetsOf(
  run: RunData,
  articleId: string,
): { facets: Record<string, number> | null; engine: string | null } {
  const answers = run.enrich.get(articleId);
  if (answers === undefined) return { facets: null, engine: null };
  const present: Record<string, Answer> = {};
  for (const [key, answer] of answers) if (answer !== null) present[key] = answer;
  let facets: Record<string, number>;
  try {
    facets = flattenFacets(present, {});
  } catch {
    return { facets: null, engine: null };
  }
  const engines = new Set(run.enrichEngines.get(articleId)?.values());
  const foreign = ['llm', 'laya'].find((engine) => engines.has(engine));
  return { facets, engine: foreign ?? [...engines][0] ?? 'typesafe' };
}

/**
 * Build the raw-v1 snapshot samples of one rater from a stored run: its ratings in the frozen
 * sample, its cards with the run's card answers, the run's facet answers. No live table is read.
 */
export function buildRaterSamples(input: {
  run: RunData;
  raterId: string;
  articles: ReadonlyMap<string, LearningArticle>;
}): RaterSamples {
  const { run, raterId, articles } = input;
  const rater = run.config.raters.find((r) => r.raterId === raterId);
  const cards = run.config.cards.filter((card) => card.raterId === raterId);
  const cohort = new Set(run.config.cohort.articleIds);
  const groupSize = new Map<string, number>();
  for (const article of articles.values()) {
    if (article.storyGroupId === null) continue;
    groupSize.set(article.storyGroupId, (groupSize.get(article.storyGroupId) ?? 0) + 1);
  }

  const rated = new Map<string, { at: number; rating: 1 | -1 }>();
  for (const rating of run.config.ratings) {
    const article = articles.get(rating.articleId);
    if (rating.raterId !== raterId || article === undefined || !cohort.has(rating.articleId)) {
      continue;
    }
    const parsed = rating.createdAt == null ? Number.NaN : Date.parse(rating.createdAt);
    const at = Number.isFinite(parsed) ? parsed : article.firstSeenAt;
    const previous = rated.get(rating.articleId);
    if (previous === undefined || at >= previous.at)
      rated.set(rating.articleId, { at, rating: rating.rating });
  }

  const ordered = [...rated.entries()].sort(
    ([idA, a], [idB, b]) => a.at - b.at || compareBigIntStrings(idA, idB),
  );
  const dev: TrainingSample[] = [];
  const test: TrainingSample[] = [];
  let latest = Number.NEGATIVE_INFINITY;
  for (const [articleId, { at, rating }] of ordered) {
    const article = articles.get(articleId);
    if (article === undefined) continue;
    latest = Math.max(latest, at);
    const results = raterCardResults(run, raterId, articleId);
    const { facets, engine } = facetsOf(run, articleId);
    const seen = Math.min(article.publishedAt ?? article.firstSeenAt, article.firstSeenAt);
    const features: RawFeatureSnapshot = {
      specSha: RAW_SNAPSHOT_SPEC_SHA,
      ratingSha: 'learning-curve',
      snapshotAt: new Date(at).toISOString(),
      cards: cards.map((card) => {
        const result = results?.get(card.cardId);
        return {
          id: card.cardId,
          strength: card.strength,
          p: result?.ok === true ? result.p : null,
          engine: result?.ok === true ? result.engine : null,
        };
      }),
      values: {
        facets,
        facetsEngine: engine,
        wordCount: article.wordCount,
        ageHours: Math.max(0, (at - seen) / HOUR_MS),
        lang: article.lang,
        hasImage: false,
        hasVideo: null,
        bodyImageCount: null,
        clusterId: article.storyGroupId,
        clusterSize:
          article.storyGroupId === null ? 0 : Math.max(1, groupSize.get(article.storyGroupId) ?? 1),
        sourceFeedId: article.sourceFeedId,
        author: article.author,
      },
    };
    (article.split === 'dev' ? dev : test).push({
      articleId,
      y: rating === 1 ? 1 : 0,
      weight: 1,
      explicit: true,
      feedbackAt: new Date(at),
      groupId: article.storyGroupId ?? articleId,
      features,
    });
  }
  return {
    raterId,
    participantKey: rater?.participantKey ?? raterId,
    dev,
    test,
    heldCards: cards.map((card) => ({
      cardId: card.cardId,
      strength: card.strength,
      scopeFeedId: null,
      cardInputSha256: '',
    })),
    now: Number.isFinite(latest) ? new Date(latest) : null,
  };
}
