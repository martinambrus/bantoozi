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
  at: Date = new Date(Date.now() - 3_600_000),
  reason: string | null = null,
): Promise<string> {
  const article = await createArticle(h.owner, { feedIds: [feedId] });
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
        reason,
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

/** The user holds a card whose examples are the titles of `articleIds`, made at `madeAt`. */
async function holdCardMadeFrom(
  user: TestUser,
  articleIds: readonly string[],
  madeAt: Date,
  strength: 'like' | 'never' = 'like',
): Promise<string> {
  const titles = await h.owner.query<{ title: string }>(
    `SELECT title FROM articles WHERE id = ANY($1::bigint[])`,
    [articleIds],
  );
  const body = {
    interest: `Batteries and how they reach production (${strength} ${madeAt.getTime()})`,
    not_for: null,
    interest_en: null,
    not_for_en: null,
    examples_yes: titles.rows.map((row) => row.title),
    examples_no: [],
  };
  const card = await h.owner.query<{ id: string }>(
    `INSERT INTO interest_cards (kind, title, body, text_hash, lang, origin, visibility, owner_user_id, creator_user_id)
     VALUES ('interest', 'Made from articles', $1::jsonb, md5($1::text), 'en', 'fork', 'private', $2, $2)
     RETURNING id::text AS id`,
    [JSON.stringify(body), user.id],
  );
  await h.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength, created_at, class_since)
     VALUES ($1, $2, $4, $3, $3)`,
    [user.id, card.rows[0]!.id, madeAt, strength],
  );
  return card.rows[0]!.id;
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

  it('stops suggesting a card once the user holds one made from the feed articles, until newer likes', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    const other = await subscribe(user, 'training');
    const card = await createCard(h.owner, { title: 'Learning card' });
    const uncovered: string[] = [];
    for (let i = 0; i < 3; i += 1) uncovered.push(await rate(user, feedId, card.id, 1, 0.05));
    for (let i = 0; i < 3; i += 1) await rate(user, other, card.id, 1, 0.05);
    const before = await status(user);
    expect(before.feeds.map((f) => f.uncovered.suggest)).toEqual([true, true]);

    await holdCardMadeFrom(user, uncovered, new Date(Date.now() - 1_800_000));
    const after = await status(user);
    const mine = after.feeds.find((f) => f.feedId === feedId)!;
    expect(mine.uncovered).toEqual({ count: 0, suggest: false, articles: [] });
    expect(mine.likes).toBe(3);
    expect(after.feeds.find((f) => f.feedId === other)!.uncovered).toMatchObject({
      count: 3,
      suggest: true,
    });

    const later = await rate(user, feedId, card.id, 1, 0.05, new Date(Date.now() - 600_000));
    const counted = (await status(user)).feeds.find((f) => f.feedId === feedId)!;
    expect(counted.uncovered.count).toBe(1);
    expect(counted.uncovered.suggest).toBe(false);
    expect(counted.uncovered.articles.map((a) => a.id)).toEqual([later]);
  });

  it('suggests a Never card from topical dislikes no Never card caught, retired only by a Never card made from them', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    const card = await createCard(h.owner, { title: 'Learning card' });
    const unwanted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      unwanted.push(await rate(user, feedId, card.id, -1, 0.05, undefined, 'off_topic'));
    }
    await rate(user, feedId, card.id, -1, 0.05, undefined, 'clickbait');
    await rate(user, feedId, card.id, 1, 0.05);
    const titles = await h.owner.query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM articles WHERE id = ANY($1::bigint[])`,
      [unwanted],
    );
    const body = (await status(user)).feeds[0]!;
    expect(body.unwanted.count).toBe(3);
    expect(body.unwanted.suggest).toBe(true);
    expect([...body.unwanted.articles].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      titles.rows.sort((a, b) => a.id.localeCompare(b.id)),
    );

    await holdCardMadeFrom(user, unwanted, new Date(Date.now() - 1_800_000), 'like');
    const afterLike = (await status(user)).feeds[0]!;
    expect(afterLike.unwanted.count).toBe(3);
    expect(afterLike.unwanted.suggest).toBe(true);

    await holdCardMadeFrom(user, unwanted, new Date(Date.now() - 1_700_000), 'never');
    const afterNever = (await status(user)).feeds[0]!;
    expect(afterNever.unwanted).toEqual({ count: 0, suggest: false, articles: [] });
    expect(afterNever.dislikes).toBe(4);
  });

  it('counts only dislikes rated after a like card was converted to Never', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    const card = await createCard(h.owner, { title: 'Learning card' });
    const unwanted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      unwanted.push(await rate(user, feedId, card.id, -1, 0.05, undefined, 'off_topic'));
    }
    // Made as a like before the dislikes, so it does not cut them off while it stays a like.
    const cardId = await holdCardMadeFrom(user, unwanted, new Date(Date.now() - 7_200_000), 'like');
    expect((await status(user)).feeds[0]!.unwanted.count).toBe(3);

    const res = await apiClient(h.server, user).patch(`/cards/${cardId}`, { strength: 'never' });
    expect(res.statusCode).toBe(200);
    expect((await status(user)).feeds[0]!.unwanted).toEqual({
      count: 0,
      suggest: false,
      articles: [],
    });

    const later = await rate(
      user,
      feedId,
      card.id,
      -1,
      0.05,
      new Date(Date.now() + 60_000),
      'off_topic',
    );
    const after = (await status(user)).feeds[0]!;
    expect(after.unwanted.count).toBe(1);
    expect(after.unwanted.articles.map((article) => article.id)).toEqual([later]);
  });

  it('does not count likes as unwanted and lets a Never card not retire uncovered likes', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    const card = await createCard(h.owner, { title: 'Learning card' });
    const liked: string[] = [];
    for (let i = 0; i < 3; i += 1) liked.push(await rate(user, feedId, card.id, 1, 0.05));
    const before = (await status(user)).feeds[0]!;
    expect(before.unwanted).toEqual({ count: 0, suggest: false, articles: [] });
    expect(before.uncovered.suggest).toBe(true);
    await holdCardMadeFrom(user, liked, new Date(Date.now() - 1_800_000), 'never');
    expect((await status(user)).feeds[0]!.uncovered.suggest).toBe(true);
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
