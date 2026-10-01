import { createDatabase, seedQuestionSets } from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import { AnalysisInputSnapshotSchema } from '@bantoozi/shared';
import {
  createArticle,
  createFeed,
  createSubscription,
  type ArticleFixture,
  type FeedFixture,
} from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T4 selected training (spec 08 §4.1, spec 05 §1.1): `POST /subscriptions/:feedId/analyze`
 * creates exact frozen-input requests plus `analysis.process` intents for the caller's own
 * user/feed only, `GET /analysis-requests/:id` reads them, and unsubscribing keeps completed
 * requests for learning while pending ones are left for the worker to cancel.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function seedActiveQuestionSets(): Promise<void> {
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );
}

async function setup(): Promise<{
  alice: TestUser;
  feed: FeedFixture;
  articles: ArticleFixture[];
}> {
  const alice = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: alice.id, feedId: feed.id });
  const articles = [
    await createArticle(h.owner, { feedIds: [feed.id] }),
    await createArticle(h.owner, { feedIds: [feed.id] }),
  ];
  return { alice, feed, articles };
}

const selection = (articles: readonly ArticleFixture[]) =>
  articles.map((a) => ({ id: a.id, contentRevision: a.contentRevision }));

async function requestRows(userId: string) {
  const result = await h.owner.query<{
    id: string;
    article_id: string;
    status: string;
    inference_version: string;
    input_snapshot: unknown;
  }>(
    `SELECT id::text AS id, article_id::text AS article_id, status,
            inference_version::text AS inference_version, input_snapshot
       FROM analysis_requests WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return result.rows;
}

async function analysisIntents(ids: readonly string[]): Promise<string[]> {
  const result = await h.owner.query<{ id: string }>(
    `SELECT payload->>'analysisRequestId' AS id FROM job_outbox
      WHERE queue = 'analysis.process' AND payload->>'analysisRequestId' = ANY($1::text[])`,
    [ids],
  );
  return result.rows.map((r) => r.id).sort();
}

async function subscriptionMode(userId: string, feedId: string) {
  const result = await h.owner.query<{ mode: string; version: string }>(
    `SELECT inference_mode AS mode, inference_version::text AS version
       FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
    [userId, feedId],
  );
  return result.rows[0];
}

describe('POST /subscriptions/:feedId/analyze', () => {
  it('is a 409 conflict until classification question sets are active', async () => {
    const { alice, feed, articles } = await setup();
    const res = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles.slice(0, 1)),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(await requestRows(alice.id)).toHaveLength(0);
    expect(await subscriptionMode(alice.id, feed.id)).toEqual({ mode: 'off', version: '0' });
    await seedActiveQuestionSets();
  });

  it('off requires an explicit startTraining; nothing is created otherwise', async () => {
    const { alice, feed, articles } = await setup();
    const res = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles),
      expectedInferenceVersion: '0',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(await requestRows(alice.id)).toHaveLength(0);
  });

  it('startTraining enters training and creates exact frozen requests with their intents', async () => {
    const { alice, feed, articles } = await setup();
    const unselected = await createArticle(h.owner, { feedIds: [feed.id] });
    const res = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    const { requests } = res.json();
    expect(requests).toHaveLength(2);
    expect(requests.map((r: { articleId: string }) => r.articleId)).toEqual(
      articles.map((a) => a.id),
    );
    for (const request of requests) expect(request.status).toBe('pending');
    expect(await subscriptionMode(alice.id, feed.id)).toEqual({ mode: 'training', version: '1' });

    const rows = await requestRows(alice.id);
    expect(rows.map((r) => r.id).sort()).toEqual(requests.map((r: { id: string }) => r.id).sort());
    expect(rows.every((r) => r.inference_version === '1')).toBe(true);
    // Only the selected articles; the unselected one gets nothing.
    expect(rows.some((r) => r.article_id === unselected.id)).toBe(false);
    // The frozen pre-feedback input is a valid snapshot of the active configuration.
    for (const row of rows) {
      const snapshot = AnalysisInputSnapshotSchema.parse(row.input_snapshot);
      expect(snapshot.questionSets.enrich.version).toBe(LATEST_QUESTION_SETS.enrich.version);
      expect(snapshot.questionSets.match.version).toBe(LATEST_QUESTION_SETS.match.version);
    }
    expect(await analysisIntents(rows.map((r) => r.id))).toEqual(rows.map((r) => r.id).sort());
    // A selection is a ranking change for this user only.
    const rank = await h.owner.query(
      `SELECT payload FROM job_outbox WHERE queue = 'user.rank' AND payload->>'userId' = $1`,
      [alice.id],
    );
    expect(rank.rows.map((r) => r.payload)).toEqual([
      { userId: alice.id, reason: 'selection', full: true },
    ]);
    // No automatic demand: no enrich/match/backfill intents.
    const other = await h.owner.query(
      `SELECT 1 FROM job_outbox WHERE queue IN ('article.enrich', 'article.match', 'card.backfill')`,
    );
    expect(other.rowCount).toBe(0);

    // Repeating the selection reuses the current requests (no new rows or intents).
    const again = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles),
      expectedInferenceVersion: '1',
    });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().requests).toEqual(requests);
    expect(await requestRows(alice.id)).toHaveLength(2);
  });

  it('rejects stale versions and revisions, foreign articles and feeds, and bad bodies', async () => {
    const { alice, feed, articles } = await setup();
    const bob = await createTestUser(h);
    const elsewhere = await createArticle(h.owner, { feedIds: [(await createFeed(h.owner)).id] });
    const a = apiClient(h.server, alice);
    const url = `/subscriptions/${feed.id}/analyze`;

    const staleVersion = await a.post(url, {
      articles: selection(articles),
      expectedInferenceVersion: '5',
      startTraining: true,
    });
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json().error).toMatchObject({
      code: 'STALE_STATE',
      details: { currentVersion: '0' },
    });

    const staleRevision = await a.post(url, {
      articles: [
        { id: articles[0]!.id, contentRevision: articles[0]!.contentRevision },
        { id: articles[1]!.id, contentRevision: '7' },
      ],
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.json().error).toMatchObject({
      code: 'STALE_STATE',
      details: { articleIds: [articles[1]!.id] },
    });

    const notCarried = await a.post(url, {
      articles: selection([articles[0]!, elsewhere]),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(notCarried.statusCode).toBe(404);

    const foreign = await apiClient(h.server, bob).post(url, {
      articles: selection(articles),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(foreign.statusCode).toBe(404);

    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      id: String(i + 1),
      contentRevision: '1',
    }));
    for (const body of [
      { articles: [], expectedInferenceVersion: '0' },
      { articles: tooMany, expectedInferenceVersion: '0' },
      { articles: [selection(articles)[0], selection(articles)[0]], expectedInferenceVersion: '0' },
      { articles: selection(articles) },
      { articles: selection(articles), expectedInferenceVersion: '0', extra: true },
    ]) {
      expect((await a.post(url, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // All-or-nothing: no request was created and the mode never changed.
    expect(await requestRows(alice.id)).toHaveLength(0);
    expect(await subscriptionMode(alice.id, feed.id)).toEqual({ mode: 'off', version: '0' });
  });
});

describe('GET /analysis-requests/:id', () => {
  it('returns own requests and 404 for another user’s or an unknown id', async () => {
    const { alice, feed, articles } = await setup();
    const bob = await createTestUser(h);
    const created = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles.slice(0, 1)),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    const id = created.json().requests[0].id as string;
    const own = await apiClient(h.server, alice).get(`/analysis-requests/${id}`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({
      id,
      feedId: feed.id,
      articleId: articles[0]!.id,
      contentRevision: articles[0]!.contentRevision,
      status: 'pending',
      createdAt: expect.any(String),
      completedAt: null,
    });
    expect((await apiClient(h.server, bob).get(`/analysis-requests/${id}`)).statusCode).toBe(404);
    expect(
      (
        await apiClient(h.server, alice).get(
          '/analysis-requests/0190a8e0-0000-7000-8000-000000000000',
        )
      ).statusCode,
    ).toBe(404);
    expect((await apiClient(h.server, alice).get('/analysis-requests/nope')).statusCode).toBe(400);
  });
});

describe('unsubscribe keeps completed analysis requests (spec 08 §4.1)', () => {
  it('completed requests stay readable; pending ones are left for the worker to cancel', async () => {
    const { alice, feed, articles } = await setup();
    const created = await apiClient(h.server, alice).post(`/subscriptions/${feed.id}/analyze`, {
      articles: selection(articles),
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(created.statusCode, created.body).toBe(202);
    const [done, pending] = created.json().requests as { id: string }[];
    await h.owner.query(
      `UPDATE analysis_requests
          SET status = 'complete', result_snapshot = '{"answers":[]}'::jsonb, result_sha = 'sha',
              completed_at = now()
        WHERE id = $1`,
      [done!.id],
    );

    const res = await apiClient(h.server, alice).delete(`/subscriptions/${feed.id}`);
    expect(res.statusCode, res.body).toBe(204);
    const rows = await requestRows(alice.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual(
      expect.arrayContaining([
        [done!.id, 'complete'],
        [pending!.id, 'pending'],
      ]),
    );
    const read = await apiClient(h.server, alice).get(`/analysis-requests/${done!.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ status: 'complete', completedAt: expect.any(String) });
    // The pending request lost its demand: there is no subscription at its version any more.
    const live = await h.owner.query(
      `SELECT 1 FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
      [alice.id, feed.id],
    );
    expect(live.rowCount).toBe(0);
  });
});
