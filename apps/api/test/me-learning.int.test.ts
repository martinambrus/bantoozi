import { createDatabase, readRatingFingerprint } from '@bantoozi/db';
import { FEATURE_SPEC_V1_FACET_NAMES, RAW_SNAPSHOT_SPEC_SHA } from '@bantoozi/ranker';
import { LearningStatusSchema } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * `GET /me/learning`: the personal model's progress (counts, activation, the last attempt) and the
 * card-vs-ratings agreement of every training subscription, computed live from the tenant's rows.
 */

let h: ApiHarness;
let ratingSha: string;

beforeAll(async () => {
  h = await createApiHarness();
  ratingSha = await readRatingFingerprint(createDatabase(h.owner), {
    model: h.config.typesafeModel,
    languageModes: h.config.languageModes,
    cardTextMode: 'as_written',
  });
});

afterAll(async () => {
  await h.close();
});

async function status(user: TestUser) {
  const res = await apiClient(h.server, user).get('/me/learning');
  expect(res.statusCode, res.body).toBe(200);
  return LearningStatusSchema.parse(res.json());
}

async function subscribe(
  user: TestUser,
  mode: 'off' | 'training' | 'active',
  publishStats?: Record<string, unknown>,
): Promise<string> {
  const feed = await createFeed(h.owner);
  if (publishStats !== undefined) {
    await h.owner.query(`UPDATE feeds SET publish_stats = $2::jsonb WHERE id = $1`, [
      feed.id,
      JSON.stringify(publishStats),
    ]);
  }
  await createSubscription(h.owner, {
    userId: user.id,
    feedId: feed.id,
    mode,
    activatedAt: new Date(Date.now() - 30 * 86_400_000),
  });
  return feed.id;
}

/** An explicit rating whose stored snapshot scored the interest card `p`. */
async function rate(
  user: TestUser,
  feedId: string,
  cardId: string,
  rating: 1 | -1,
  p: number,
): Promise<string> {
  const article = await createArticle(h.owner, { feedIds: [feedId] });
  const at = new Date(Date.now() - 3_600_000);
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)`,
    [user.id, article.id, rating, at],
  );
  const facets = Object.fromEntries(FEATURE_SPEC_V1_FACET_NAMES.map((name) => [name, 0.5]));
  const features = {
    specSha: RAW_SNAPSHOT_SPEC_SHA,
    ratingSha,
    snapshotAt: at.toISOString(),
    cards: [{ id: cardId, strength: 'love', p, engine: 'typesafe' }],
    values: {
      facets,
      facetsEngine: 'typesafe',
      wordCount: 400,
      ageHours: 3,
      lang: 'en',
      hasImage: false,
      hasVideo: false,
      bodyImageCount: 0,
      clusterId: null,
      clusterSize: 0,
      sourceFeedId: feedId,
      author: null,
    },
    sourceManifest: { contentRevision: '1', mediaRevision: '1', inferenceFeedIds: [feedId] },
  };
  await h.owner.query(
    `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
     VALUES ($1, $2, 'rate', $3::jsonb, $4)`,
    [
      user.id,
      article.id,
      JSON.stringify({
        v: 1,
        rating,
        reason: null,
        hide: false,
        contentRevision: '1',
        signalOrigin: 'explicit',
        learningConsent: { implicitFeedback: false, implicitNegative: false },
        features,
      }),
      at,
    ],
  );
  return article.id;
}

async function storeModel(
  user: TestUser,
  version: number,
  active: boolean,
  metrics: Record<string, unknown>,
  trainedAt: Date,
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                              intercept, scaler, calibration, metrics, active, trained_at)
     VALUES ($1, $2, $3, 0, 0, 0, '{}', 0, '{}', '{}', $4::jsonb, $5, $6)`,
    [user.id, version, 'a'.repeat(64), JSON.stringify(metrics), active, trainedAt],
  );
}

describe('GET /me/learning', () => {
  it('is empty for a new account and needs a session', async () => {
    const user = await createTestUser(h);
    const body = await status(user);
    expect(body.model.counts).toEqual({ explicit: 0, likes: 0, dislikes: 0 });
    expect(body.model.thresholds.minExplicit).toBeGreaterThan(0);
    expect(body.model.active).toBeNull();
    expect(body.model.lastAttempt).toBeNull();
    expect(body.model.deactivated).toBeNull();
    expect(body.feeds).toEqual([]);
    expect((await apiClient(h.server).get('/me/learning')).statusCode).toBe(401);
  });

  it('reports a training feed whose card scores separate the ratings as ready', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training', { items_7d: 13.4 });
    const card = await createCard(h.owner, { title: 'Learning card' });
    for (let i = 0; i < 7; i += 1) await rate(user, feedId, card.id, 1, 0.9);
    for (let i = 0; i < 7; i += 1) await rate(user, feedId, card.id, -1, 0.1);
    const body = await status(user);
    expect(body.model.counts).toEqual({ explicit: 14, likes: 7, dislikes: 7 });
    expect(body.feeds).toHaveLength(1);
    expect(body.feeds[0]).toMatchObject({
      feedId,
      status: 'ready',
      likes: 7,
      dislikes: 7,
      ratedHigh: { total: 7, liked: 7 },
      ratedLow: { total: 7, disliked: 7 },
      articlesPerWeek: 13,
    });
    expect(body.feeds[0]!.auc).toBe(1);
    expect(body.feeds[0]!.aucLow).not.toBeNull();
  });

  it('lists the likes every card scored below Maybe with their titles and suggests a card (D-241)', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    const card = await createCard(h.owner, { title: 'Learning card' });
    const uncovered: string[] = [];
    for (let i = 0; i < 3; i += 1) uncovered.push(await rate(user, feedId, card.id, 1, 0.05));
    await rate(user, feedId, card.id, 1, 0.9);
    await rate(user, feedId, card.id, -1, 0.05);
    const titles = await h.owner.query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM articles WHERE id = ANY($1::bigint[])`,
      [uncovered],
    );
    const body = await status(user);
    expect(body.feeds[0]!.uncovered.count).toBe(3);
    expect(body.feeds[0]!.uncovered.suggest).toBe(true);
    expect([...body.feeds[0]!.uncovered.articles].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      titles.rows.sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('reports a training feed with two likes as collecting, and lists only training feeds', async () => {
    const user = await createTestUser(h);
    const training = await subscribe(user, 'training');
    await subscribe(user, 'off');
    await subscribe(user, 'active');
    const card = await createCard(h.owner, { title: 'Learning card' });
    await rate(user, training, card.id, 1, 0.9);
    await rate(user, training, card.id, 1, 0.8);
    const body = await status(user);
    expect(body.feeds.map((f) => f.feedId)).toEqual([training]);
    expect(body.feeds[0]).toMatchObject({
      status: 'collecting',
      likes: 2,
      dislikes: 0,
      articlesPerWeek: null,
    });
  });

  it('reports a stored rejected attempt with its reasons', async () => {
    const user = await createTestUser(h);
    const at = new Date(Date.now() - 3_600_000);
    await storeModel(
      user,
      1,
      false,
      {
        status: 'rejected',
        reason: 'cv_auc_below_threshold,too_few_dislikes',
        attemptAt: at.toISOString(),
        cvAuc: 0.55,
        baselineAuc: 0.6,
      },
      at,
    );
    const { model } = await status(user);
    expect(model.active).toBeNull();
    expect(model.lastAttempt).toEqual({
      at: at.toISOString(),
      status: 'rejected',
      reasons: ['cv_auc_below_threshold', 'too_few_dislikes'],
      cvAuc: 0.55,
      baselineAuc: 0.6,
    });
  });

  it('reports the active model with its version and training time', async () => {
    const user = await createTestUser(h);
    const trainedAt = new Date(Date.now() - 86_400_000);
    await storeModel(
      user,
      3,
      true,
      {
        status: 'activated',
        reason: null,
        attemptAt: trainedAt.toISOString(),
        cvAuc: 0.74,
        baselineAuc: 0.7,
      },
      trainedAt,
    );
    const { model } = await status(user);
    expect(model.active).toEqual({ version: 3, since: trainedAt.toISOString() });
    expect(model.deactivated).toBeNull();
    expect(model.lastAttempt).toMatchObject({ status: 'activated', reasons: [], cvAuc: 0.74 });
  });

  it('reports a deactivated model while none is active', async () => {
    const user = await createTestUser(h);
    const at = new Date(Date.now() - 86_400_000);
    const deactivatedAt = new Date(Date.now() - 3_600_000);
    await storeModel(
      user,
      1,
      false,
      {
        status: 'activated',
        reason: null,
        attemptAt: at.toISOString(),
        cvAuc: 0.74,
        baselineAuc: 0.7,
        deactivatedAt: deactivatedAt.toISOString(),
        deactivatedReason: 'lost_evidence',
      },
      at,
    );
    const { model } = await status(user);
    expect(model.active).toBeNull();
    expect(model.deactivated).toEqual({
      at: deactivatedAt.toISOString(),
      reason: 'lost_evidence',
    });
  });
});
