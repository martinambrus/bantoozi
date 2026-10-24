import { ESTIMATE_SPEC, estimateGate } from '@bantoozi/ranker';
import { LearningHistorySchema, LearningStatusSchema } from '@bantoozi/shared';
import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * PRG-1 (visible-learning §4.5): `GET /me/learning` reports each followed feed's word-estimate quality
 * and how many ratings still open the estimate gate; `GET /me/learning/history` returns the learning
 * milestones oldest first.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

const TRAINED_AT = new Date('2026-10-20T08:30:00.000Z');

async function storeModel(
  user: TestUser,
  options: { spec?: string; metrics?: Record<string, unknown> } = {},
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_estimate_models (user_id, version, spec, trained_at, n, n_pos, n_neg,
                                       intercept, weights, platt, metrics)
     VALUES ($1, 1, $2, $3, 20, 10, 10, -0.25, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [
      user.id,
      options.spec ?? ESTIMATE_SPEC,
      TRAINED_AT,
      JSON.stringify({ 't:battery': 0.5 }),
      JSON.stringify({ a: 1.1, b: -0.2 }),
      JSON.stringify(options.metrics ?? { auc: 0.71 }),
    ],
  );
}

async function subscribe(user: TestUser, mode: 'off' | 'training' | 'active'): Promise<string> {
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, {
    userId: user.id,
    feedId: feed.id,
    mode,
    activatedAt: new Date(Date.now() - 30 * 86_400_000),
  });
  return feed.id;
}

async function rateMany(user: TestUser, likes: number, dislikes: number): Promise<void> {
  const feed = await createFeed(h.owner);
  const ratings = [...Array<number>(likes).fill(1), ...Array<number>(dislikes).fill(-1)];
  for (const rating of ratings) {
    const article = await createArticle(h.owner, { feedIds: [feed.id] });
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)`,
      [user.id, article.id, rating, new Date(Date.now() - 3_600_000)],
    );
  }
}

async function read(user: TestUser) {
  const res = await apiClient(h.server, user).get('/me/learning');
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.json<Record<string, unknown>>();
  return { raw, status: LearningStatusSchema.parse(raw) };
}

describe('GET /me/learning per-feed estimate', () => {
  it('gives a Training feed estimate {n, auc} from the stored model', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    await storeModel(user, {
      metrics: { auc: 0.71, feeds: { [feedId]: { n: 14, nPos: 8, nNeg: 6, auc: 0.66 } } },
    });
    const { raw, status } = await read(user);
    const entry = (raw.feeds as Record<string, unknown>[]).find((f) => f.feedId === feedId);
    expect(entry).toHaveProperty('estimate', { n: 14, auc: 0.66 });
    expect(status.feeds).toHaveLength(1);
  });

  it('reports a null auc as null', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    await storeModel(user, {
      metrics: { auc: 0.71, feeds: { [feedId]: { n: 4, nPos: 4, nNeg: 0, auc: null } } },
    });
    const { raw } = await read(user);
    expect((raw.feeds as Record<string, unknown>[])[0]).toHaveProperty('estimate', {
      n: 4,
      auc: null,
    });
  });

  it('is null (key present) when the feed has no metrics', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    await storeModel(user, { metrics: { auc: 0.71, feeds: {} } });
    const { raw } = await read(user);
    const entry = (raw.feeds as Record<string, unknown>[]).find((f) => f.feedId === feedId);
    expect(entry).toHaveProperty('estimate', null);

    const noModel = await createTestUser(h);
    const otherFeed = await subscribe(noModel, 'training');
    const second = await read(noModel);
    expect(
      (second.raw.feeds as Record<string, unknown>[]).find((f) => f.feedId === otherFeed),
    ).toHaveProperty('estimate', null);
  });

  it('is null when the stored model has another spec', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    await storeModel(user, {
      spec: 'estimate-v0:0000000000000000',
      metrics: { auc: 0.71, feeds: { [feedId]: { n: 14, nPos: 8, nNeg: 6, auc: 0.66 } } },
    });
    const { raw } = await read(user);
    expect((raw.feeds as Record<string, unknown>[])[0]).toHaveProperty('estimate', null);
  });
});

describe('GET /me/learning estimate-only feed entries', () => {
  it('adds one agreement-free entry for an Off and for an Active subscription with metrics', async () => {
    const user = await createTestUser(h);
    const off = await subscribe(user, 'off');
    const active = await subscribe(user, 'active');
    const noMetrics = await subscribe(user, 'off');
    await storeModel(user, {
      metrics: {
        auc: 0.71,
        feeds: {
          [off]: { n: 12, nPos: 6, nNeg: 6, auc: 0.62 },
          [active]: { n: 30, nPos: 20, nNeg: 10, auc: null },
        },
      },
    });
    const { raw } = await read(user);
    const feeds = raw.feeds as Record<string, unknown>[];
    expect(feeds.filter((f) => f.feedId === off)).toEqual([
      { feedId: off, estimate: { n: 12, auc: 0.62 } },
    ]);
    expect(feeds.filter((f) => f.feedId === active)).toEqual([
      { feedId: active, estimate: { n: 30, auc: null } },
    ]);
    expect(feeds.some((f) => f.feedId === noMetrics)).toBe(false);
    expect(feeds).toHaveLength(2);
  });

  it('adds none for a feed the user does not follow', async () => {
    const user = await createTestUser(h);
    const other = await createTestUser(h);
    const foreign = await subscribe(other, 'off');
    const own = await subscribe(user, 'off');
    await storeModel(user, {
      metrics: {
        auc: 0.71,
        feeds: {
          [foreign]: { n: 12, nPos: 6, nNeg: 6, auc: 0.62 },
          [own]: { n: 12, nPos: 6, nNeg: 6, auc: 0.6 },
        },
      },
    });
    const { raw } = await read(user);
    const ids = (raw.feeds as Record<string, unknown>[]).map((f) => f.feedId);
    expect(ids).toEqual([own]);
  });

  it('adds none for a model of another spec', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'off');
    await storeModel(user, {
      spec: 'estimate-v0:0000000000000000',
      metrics: { auc: 0.71, feeds: { [feedId]: { n: 12, nPos: 6, nNeg: 6, auc: 0.62 } } },
    });
    const { raw } = await read(user);
    expect(raw.feeds).toEqual([]);
  });

  it('never lists a Training feed twice', async () => {
    const user = await createTestUser(h);
    const training = await subscribe(user, 'training');
    const off = await subscribe(user, 'off');
    await storeModel(user, {
      metrics: {
        auc: 0.71,
        feeds: {
          [training]: { n: 12, nPos: 6, nNeg: 6, auc: 0.62 },
          [off]: { n: 12, nPos: 6, nNeg: 6, auc: 0.6 },
        },
      },
    });
    const { raw } = await read(user);
    const feeds = raw.feeds as Record<string, unknown>[];
    const forTraining = feeds.filter((f) => f.feedId === training);
    expect(forTraining).toHaveLength(1);
    expect(forTraining[0]).toHaveProperty('status');
    expect(forTraining[0]).toHaveProperty('estimate', { n: 12, auc: 0.62 });
    expect(feeds.find((f) => f.feedId === off)).toEqual({
      feedId: off,
      estimate: { n: 12, auc: 0.6 },
    });
  });
});

describe('GET /me/learning estimateGate', () => {
  it('needs the full minimum for an account with no ratings', async () => {
    const user = await createTestUser(h);
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed: estimateGate({ n: 0, nPos: 0, nNeg: 0 }).needed });
  });

  it('counts the missing ratings: 4 explicit ratings need 6 more', async () => {
    const user = await createTestUser(h);
    await rateMany(user, 2, 2);
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed: 6 });
  });

  it('reports the class shortfall when all ratings are likes', async () => {
    const user = await createTestUser(h);
    await rateMany(user, 12, 0);
    const needed = estimateGate({ n: 12, nPos: 12, nNeg: 0 }).needed;
    expect(needed).toBe(3);
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed });
  });

  it('is 0 once a model is stored, whatever the ratings', async () => {
    const user = await createTestUser(h);
    await rateMany(user, 1, 1);
    await storeModel(user);
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed: 0 });
  });

  it('is 0 when the gate is open and no model exists yet', async () => {
    const user = await createTestUser(h);
    await rateMany(user, 5, 5);
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed: 0 });
  });

  it('still needs ratings when the stored model has another spec', async () => {
    const user = await createTestUser(h);
    await rateMany(user, 2, 2);
    await storeModel(user, { spec: 'estimate-v0:0000000000000000' });
    const { raw } = await read(user);
    expect(raw.estimateGate).toEqual({ needed: 6 });
  });
});

const BASE = new Date('2026-09-01T00:00:00.000Z');

async function addHistory(
  user: TestUser,
  row: {
    kind: 'model' | 'estimate';
    at: Date;
    n?: number;
    auc?: number | null;
    baselineAuc?: number | null;
    activated?: boolean;
    turnedOn?: boolean;
    engineModel?: string | null;
  },
): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_learning_history
       (user_id, at, kind, n, auc, baseline_auc, activated, turned_on, engine_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      user.id,
      row.at,
      row.kind,
      row.n ?? 10,
      row.auc ?? null,
      row.baselineAuc ?? null,
      row.activated ?? false,
      row.turnedOn ?? false,
      row.engineModel ?? null,
    ],
  );
}

async function addEstimateRows(user: TestUser, count: number): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_learning_history (user_id, at, kind, n)
     SELECT $1, $2::timestamptz + (g || ' minutes')::interval, 'estimate', g
       FROM generate_series(1, $3::int) AS g`,
    [user.id, BASE, count],
  );
}

describe('GET /me/learning/history', () => {
  it('exposes rejection reasons and nullable backfill provenance', async () => {
    const user = await createTestUser(h);
    await h.owner.query(
      `INSERT INTO user_learning_history (user_id, kind, n, activated, turned_on, reason) VALUES ($1, 'model', 10, NULL, NULL, 'low_auc,worse_logloss')`,
      [user.id],
    );
    const res = await apiClient(h.server, user).get('/me/learning/history');
    expect(res.statusCode, res.body).toBe(200);
    expect(LearningHistorySchema.parse(res.json()).items[0]).toMatchObject({
      reason: 'low_auc,worse_logloss',
      activated: null,
      turnedOn: null,
    });
  });
  it('answers 401 without a session', async () => {
    expect((await apiClient(h.server).get('/me/learning/history')).statusCode).toBe(401);
  });

  it('answers an empty history with both flags false', async () => {
    const user = await createTestUser(h);
    const res = await apiClient(h.server, user).get('/me/learning/history');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ items: [], truncated: { model: false, estimate: false } });
  });

  it("returns the caller's rows oldest first in the contract shape", async () => {
    const user = await createTestUser(h);
    const other = await createTestUser(h);
    const t1 = new Date(BASE.getTime() + 1_000);
    const t2 = new Date(BASE.getTime() + 2_000);
    const t3 = new Date(BASE.getTime() + 3_000);
    // inserted out of order on purpose
    await addHistory(user, {
      kind: 'model',
      at: t3,
      n: 55,
      auc: 0.74,
      baselineAuc: 0.7,
      activated: true,
      turnedOn: true,
      engineModel: 'jev-1',
    });
    await addHistory(user, { kind: 'estimate', at: t1, n: 12, auc: 0.6, turnedOn: true });
    await addHistory(user, { kind: 'model', at: t2, n: 45, auc: 0.55, baselineAuc: 0.6 });
    await addHistory(other, { kind: 'estimate', at: t2, n: 99, auc: 0.9 });

    const res = await apiClient(h.server, user).get('/me/learning/history');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([
      {
        at: t1.toISOString(),
        kind: 'estimate',
        n: 12,
        auc: 0.6,
        baselineAuc: null,
        activated: false,
        turnedOn: true,
        engineModel: null,
        reason: null,
      },
      {
        at: t2.toISOString(),
        kind: 'model',
        n: 45,
        auc: 0.55,
        baselineAuc: 0.6,
        activated: false,
        turnedOn: false,
        engineModel: null,
        reason: null,
      },
      {
        at: t3.toISOString(),
        kind: 'model',
        n: 55,
        auc: 0.74,
        baselineAuc: 0.7,
        activated: true,
        turnedOn: true,
        engineModel: 'jev-1',
        reason: null,
      },
    ]);
    expect(body.truncated).toEqual({ model: false, estimate: false });
    expect(LearningHistorySchema.parse(body).items).toHaveLength(3);
  });

  it('flags the estimate kind truncated at 200 rows, not at 199, and leaves model false', async () => {
    const short = await createTestUser(h);
    await addEstimateRows(short, 199);
    const full = await createTestUser(h);
    await addEstimateRows(full, 200);

    const shortRes = await apiClient(h.server, short).get('/me/learning/history');
    expect(shortRes.statusCode, shortRes.body).toBe(200);
    expect(shortRes.json().items).toHaveLength(199);
    expect(shortRes.json().truncated).toEqual({ model: false, estimate: false });

    const fullRes = await apiClient(h.server, full).get('/me/learning/history');
    expect(fullRes.statusCode, fullRes.body).toBe(200);
    expect(fullRes.json().items).toHaveLength(200);
    expect(fullRes.json().truncated).toEqual({ model: false, estimate: true });
    expect(LearningHistorySchema.parse(fullRes.json()).truncated.model).toBe(false);
  });
});

describe('GET /me/learning body', () => {
  it('still parses with LearningStatusSchema alongside a history row', async () => {
    const user = await createTestUser(h);
    const feedId = await subscribe(user, 'training');
    await subscribe(user, 'off');
    await storeModel(user, {
      metrics: { auc: 0.71, feeds: { [feedId]: { n: 14, nPos: 8, nNeg: 6, auc: 0.66 } } },
    });
    await addHistory(user, { kind: 'estimate', at: BASE, n: 20, auc: 0.71 });
    const { status } = await read(user);
    expect(status.estimateGate).toEqual({ needed: 0 });
  });
});
