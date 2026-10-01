import { randomUUID } from 'node:crypto';

import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FixtureWeb, htmlWithFeeds, rssDocument } from './support/fixture-web.js';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T4 (spec 08 §4, spec 03 §10): subscribe through discovery (over the offline fixture web),
 * the `maxFeeds` quota, metadata and remembered image policy, feed preferences, inference mode
 * transitions, unsubscribe, folder rename, unread counts and cross-user isolation.
 */

let h: ApiHarness;
const web = new FixtureWeb();

/** Queues whose intents create provider demand or automatic card backfill (spec 08 §4.1). */
const PROVIDER_QUEUES = [
  'article.enrich',
  'article.enrich.laya',
  'article.match',
  'analysis.process',
  'analysis.process.laya',
  'card.backfill',
];

beforeAll(async () => {
  h = await createApiHarness({ discoverDeps: web.deps() });
});

afterAll(async () => {
  await h.close();
});

async function intents(
  queue: string,
  where: { userId?: string; feedId?: string } = {},
): Promise<Record<string, unknown>[]> {
  const result = await h.owner.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM job_outbox
      WHERE queue = $1
        AND ($2::text IS NULL OR payload->>'userId' = $2)
        AND ($3::text IS NULL OR payload->>'feedId' = $3)
      ORDER BY id`,
    [queue, where.userId ?? null, where.feedId ?? null],
  );
  return result.rows.map((row) => row.payload);
}

async function providerIntentCount(): Promise<number> {
  const result = await h.owner.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM job_outbox WHERE queue = ANY($1::text[])',
    [PROVIDER_QUEUES],
  );
  return result.rows[0]!.n;
}

async function rankRevision(userId: string): Promise<number> {
  const result = await h.owner.query<{ r: number }>(
    'SELECT rank_revision::int AS r FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]!.r;
}

async function feedRow(feedId: string) {
  const result = await h.owner.query<{ subscriber_count: number; unsubscribed_at: Date | null }>(
    'SELECT subscriber_count, unsubscribed_at FROM feeds WHERE id = $1',
    [feedId],
  );
  return result.rows[0]!;
}

async function subscriptionRow(userId: string, feedId: string) {
  const result = await h.owner.query<{
    inference_mode: string;
    inference_version: string;
    inference_activated_at: Date | null;
    folder: string | null;
  }>(
    `SELECT inference_mode, inference_version::text AS inference_version, inference_activated_at,
            folder
       FROM subscriptions WHERE user_id = $1 AND feed_id = $2`,
    [userId, feedId],
  );
  return result.rows[0];
}

/** `n` extra subscriptions for `userId` through the owner (quota fixtures). */
async function bulkSubscribe(userId: string, n: number, tag: string): Promise<void> {
  await h.owner.query(
    `WITH f AS (
       INSERT INTO feeds (url, fetch_url, title)
       SELECT u, u, 'Bulk' FROM (
         SELECT 'https://bulk.example.com/' || $2 || '/' || g || '.xml' AS u
           FROM generate_series(1, $3::int) g) s
       RETURNING id)
     INSERT INTO subscriptions (user_id, feed_id) SELECT $1, id FROM f`,
    [userId, tag, n],
  );
}

/** Serve a one-feed site and subscribe `user` to it; returns the subscription DTO. */
async function subscribeTo(user: TestUser, url: string, title: string, folder?: string) {
  web.route(url, { body: rssDocument(title), contentType: 'application/rss+xml' });
  const res = await apiClient(h.server, user).post('/subscriptions', {
    url,
    ...(folder === undefined ? {} : { folder }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().subscription as {
    feed: { id: string; url: string; title: string | null };
    folder: string | null;
    inferenceMode: string;
    inferenceVersion: string;
    inferenceActivatedAt: string | null;
    imagePolicy: string;
    effectiveImagesAllowed: boolean;
  };
}

describe('POST /subscriptions (discovery, spec 03 §10)', () => {
  it('runs discovery before any transaction, then subscribes with inference off', async () => {
    const alice = await createTestUser(h);
    web.feed('https://blog.example.com/feed/', 'rss2.xml');
    const events: string[] = [];
    const busyDuringFetch: number[] = [];
    web.onFetch = () => {
      events.push('fetch');
      busyDuringFetch.push(h.appPool.totalCount - h.appPool.idleCount);
    };
    const original = h.appDb.transaction.bind(h.appDb);
    const spy = vi.spyOn(h.appDb, 'transaction').mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      events.push('tx');
      return original(...args);
    }) as typeof original);
    try {
      const res = await apiClient(h.server, alice).post('/subscriptions', {
        url: 'https://blog.example.com/feed/',
        folder: 'Tech',
      });
      expect(res.statusCode, res.body).toBe(201);
      const { subscription } = res.json();
      expect(subscription).toMatchObject({
        folder: 'Tech',
        inferenceMode: 'off',
        inferenceVersion: '0',
        inferenceActivatedAt: null,
        imagePolicy: 'inherit',
        effectiveImagesAllowed: false,
        unread: { forYou: 0, maybe: 0, everything: 0, new: 0 },
      });
      expect(subscription.feed.title).toBe('Example Engineering Blog');
      // The spy: every fetch happened with no pooled connection checked out, and the subscribe
      // transaction was opened only after the last fetch.
      expect(busyDuringFetch.length).toBeGreaterThan(0);
      expect(busyDuringFetch.every((n) => n === 0)).toBe(true);
      expect(events.lastIndexOf('tx')).toBeGreaterThan(events.lastIndexOf('fetch'));
      expect(events.indexOf('fetch')).toBeLessThan(events.lastIndexOf('tx'));

      const feedId = subscription.feed.id as string;
      expect(await subscriptionRow(alice.id, feedId)).toMatchObject({
        inference_mode: 'off',
        inference_version: '0',
        inference_activated_at: null,
      });
      expect((await feedRow(feedId)).subscriber_count).toBe(1);
      expect(await intents('feed.fetch', { feedId })).toHaveLength(1);
      expect(await intents('user.rank', { userId: alice.id })).toEqual([
        { userId: alice.id, reason: 'subscription', full: true },
      ]);
    } finally {
      spy.mockRestore();
      web.onFetch = null;
    }
  });

  it('returns candidates to choose when a site advertises several feeds', async () => {
    const alice = await createTestUser(h);
    web
      .route('https://multi.example.com/', {
        body: htmlWithFeeds([
          { href: '/rss.xml', title: 'Posts' },
          { href: '/atom.xml', title: 'Notes', type: 'application/atom+xml' },
        ]),
        contentType: 'text/html; charset=utf-8',
      })
      .route('https://multi.example.com/rss.xml', {
        body: rssDocument('Multi posts'),
        contentType: 'application/rss+xml',
      })
      .feed('https://multi.example.com/atom.xml', 'atom.xml', 'application/atom+xml');
    const res = await apiClient(h.server, alice).post('/subscriptions', {
      url: 'https://multi.example.com/',
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status).toBe('choose');
    expect(body.candidates.map((c: { url: string }) => c.url).sort()).toEqual([
      'https://multi.example.com/atom.xml',
      'https://multi.example.com/rss.xml',
    ]);
    for (const candidate of body.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['title', 'type', 'url']);
    }
    const subs = await h.owner.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [alice.id]);
    expect(subs.rowCount).toBe(0);
  });

  it('maps discovery failures to 422 FEED_* without writing anything', async () => {
    const alice = await createTestUser(h);
    web.route('https://broken.example.com/feed.xml', { fail: 'FEED_HTTP_500', status: 500 });
    web.feed('https://plain.example.com/', 'not-a-feed.html', 'text/html; charset=utf-8');
    for (const url of ['https://broken.example.com/feed.xml', 'https://plain.example.com/']) {
      const res = await apiClient(h.server, alice).post('/subscriptions', { url });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toMatch(/^FEED_/);
    }
    const res = await apiClient(h.server, alice).post('/subscriptions', {
      url: 'ftp://files.example.com/feed.xml',
    });
    expect([400, 422]).toContain(res.statusCode);
    const subs = await h.owner.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [alice.id]);
    expect(subs.rowCount).toBe(0);
  });

  it('returns an existing subscription unchanged: 200, no quota, folder and mode kept', async () => {
    const alice = await createTestUser(h);
    const first = await subscribeTo(alice, 'https://again.example.com/feed.xml', 'Again', 'One');
    await h.owner.query(
      `UPDATE subscriptions SET inference_mode = 'training', inference_version = 1
        WHERE user_id = $1 AND feed_id = $2`,
      [alice.id, first.feed.id],
    );
    const res = await apiClient(h.server, alice).post('/subscriptions', {
      url: 'https://again.example.com/feed.xml',
      folder: 'Two',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().subscription).toMatchObject({
      folder: 'One',
      inferenceMode: 'training',
      inferenceVersion: '1',
    });
    expect((await feedRow(first.feed.id)).subscriber_count).toBe(1);
    expect(await intents('feed.fetch', { feedId: first.feed.id })).toHaveLength(1);
  });

  it('answers a retried subscribe from its receipt without repeating discovery', async () => {
    const alice = await createTestUser(h);
    const url = 'https://retry.example.com/feed.xml';
    web.route(url, { body: rssDocument('Retry'), contentType: 'application/rss+xml' });
    const key = randomUUID();
    const client = apiClient(h.server, alice);
    const first = await client.post('/subscriptions', { url }, { idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);
    // The feed is gone now; a retry with the same key must still get the committed result.
    web.route(url, { fail: 'FEED_HTTP_404', status: 404 });
    const fetchedBefore = web.fetched.length;
    const retry = await client.post('/subscriptions', { url }, { idempotencyKey: key });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(web.fetched.length).toBe(fetchedBefore);
    const other = await client.post(
      '/subscriptions',
      { url: 'https://other.example.com/feed.xml' },
      { idempotencyKey: key },
    );
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects invalid bodies with 400', async () => {
    const alice = await createTestUser(h);
    const client = apiClient(h.server, alice);
    for (const body of [
      {},
      { url: '' },
      { url: 'https://x.example.com/', extra: 1 },
      { url: 'https://x.example.com/', folder: 'f'.repeat(101) },
      { url: 'x'.repeat(8193) },
    ]) {
      const res = await client.post('/subscriptions', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('enforces maxFeeds at the boundary: max is accepted, max + 1 is 409', async () => {
    const bob = await createTestUser(h);
    await bulkSubscribe(bob.id, 199, 'quota');
    const at200 = await subscribeTo(bob, 'https://q200.example.com/feed.xml', 'Q200');
    expect(at200.inferenceMode).toBe('off');
    web.route('https://q201.example.com/feed.xml', {
      body: rssDocument('Q201'),
      contentType: 'application/rss+xml',
    });
    const over = await apiClient(h.server, bob).post('/subscriptions', {
      url: 'https://q201.example.com/feed.xml',
    });
    expect(over.statusCode, over.body).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxFeeds', used: 200, max: 200 },
    });
    // Re-subscribing to a held feed at the limit uses no quota.
    const again = await apiClient(h.server, bob).post('/subscriptions', {
      url: 'https://q200.example.com/feed.xml',
    });
    expect(again.statusCode, again.body).toBe(200);
  });
});

describe('inference is off by default (spec 08 §4.1)', () => {
  it('subscribe, import and reading create no provider demand or card backfill', async () => {
    const carol = await createTestUser(h);
    const alice = await createTestUser(h);
    const feed = await createFeed(h.owner, { url: 'https://shared.example.com/feed.xml' });
    await createSubscription(h.owner, { userId: carol.id, feedId: feed.id, mode: 'active' });
    await createArticle(h.owner, { feedIds: [feed.id] });
    await createArticle(h.owner, { feedIds: [feed.id] });
    const before = await providerIntentCount();

    web.route('https://shared.example.com/feed.xml', {
      body: rssDocument('Shared'),
      contentType: 'application/rss+xml',
    });
    const res = await apiClient(h.server, alice).post('/subscriptions', {
      url: 'https://shared.example.com/feed.xml',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().subscription.feed.id).toBe(feed.id);
    expect(res.json().subscription.inferenceMode).toBe('off');
    // Local bookkeeping works: subscriber count, first fetch, the unread list.
    expect((await feedRow(feed.id)).subscriber_count).toBe(2);
    expect(await intents('feed.fetch', { feedId: feed.id })).toHaveLength(1);
    const list = await apiClient(h.server, alice).get('/subscriptions');
    expect(list.statusCode).toBe(200);
    expect(list.json()[0].unread.new).toBe(2);
    expect((await apiClient(h.server, alice).get('/feed-preferences')).statusCode).toBe(200);
    expect((await apiClient(h.server, alice).get('/subscriptions/export-opml')).statusCode).toBe(
      200,
    );
    expect(await providerIntentCount()).toBe(before);
  });
});

describe('PATCH /subscriptions/:feedId', () => {
  it('updates metadata, clears with null, and ranks on a duplicate-policy change', async () => {
    const alice = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://meta.example.com/feed.xml', 'Meta');
    const client = apiClient(h.server, alice);
    const rankBefore = (await intents('user.rank', { userId: alice.id })).length;
    const res = await client.patch(`/subscriptions/${sub.feed.id}`, {
      titleOverride: 'My title',
      folder: 'Reading',
      hidden: true,
      allowDuplicates: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().subscription).toMatchObject({
      titleOverride: 'My title',
      folder: 'Reading',
      hidden: true,
      allowDuplicates: true,
      inferenceMode: 'off',
      inferenceVersion: '0',
    });
    const ranks = await intents('user.rank', { userId: alice.id });
    expect(ranks.slice(rankBefore)).toEqual([
      { userId: alice.id, reason: 'subscription:duplicates', full: true },
    ]);
    const cleared = await client.patch(`/subscriptions/${sub.feed.id}`, {
      titleOverride: null,
      folder: null,
    });
    expect(cleared.json().subscription).toMatchObject({ titleOverride: null, folder: null });
    // No duplicate-policy change → no rank intent.
    expect(await intents('user.rank', { userId: alice.id })).toHaveLength(ranks.length);
  });

  it('per-feed image allow overrides the global block for this reader only; inherit returns', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://images.example.com/feed.xml', 'Images');
    await createSubscription(h.owner, { userId: bob.id, feedId: sub.feed.id });
    const a = apiClient(h.server, alice);
    const b = apiClient(h.server, bob);
    const ranksBefore = (await intents('user.rank', { userId: alice.id })).length;

    // Global default: remote images blocked.
    const allow = await a.patch(`/subscriptions/${sub.feed.id}`, { imagePolicy: 'allow' });
    expect(allow.statusCode, allow.body).toBe(200);
    expect(allow.json().subscription).toMatchObject({
      imagePolicy: 'allow',
      effectiveImagesAllowed: true,
      inferenceMode: 'off',
      inferenceVersion: '0',
    });
    // Persisted, and only for alice.
    expect((await a.get('/feed-preferences')).json()).toEqual([
      { feedId: sub.feed.id, imagePolicy: 'allow', effectiveImagesAllowed: true },
    ]);
    const bobSub = (await b.get('/subscriptions')).json()[0];
    expect(bobSub).toMatchObject({ imagePolicy: 'inherit', effectiveImagesAllowed: false });
    expect((await b.get('/feed-preferences')).json()).toEqual([]);

    // inherit → the global behaviour again (blocked, then allowed once the global flag is on).
    const inherit = await a.patch(`/subscriptions/${sub.feed.id}`, { imagePolicy: 'inherit' });
    expect(inherit.json().subscription).toMatchObject({
      imagePolicy: 'inherit',
      effectiveImagesAllowed: false,
    });
    await a.patch('/me', { preferences: { loadRemoteImages: true } });
    const global = (await a.get('/subscriptions')).json()[0];
    expect(global).toMatchObject({ imagePolicy: 'inherit', effectiveImagesAllowed: true });
    const block = await a.patch(`/subscriptions/${sub.feed.id}`, { imagePolicy: 'block' });
    expect(block.json().subscription).toMatchObject({
      imagePolicy: 'block',
      effectiveImagesAllowed: false,
    });

    // Image policy never changes inference eligibility: same mode and version, no rank intent.
    expect(await subscriptionRow(alice.id, sub.feed.id)).toMatchObject({
      inference_mode: 'off',
      inference_version: '0',
    });
    expect(await intents('user.rank', { userId: alice.id })).toHaveLength(ranksBefore);
  });

  it('rejects empty and invalid patches with 400 and foreign feeds with 404', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://patch.example.com/feed.xml', 'Patch');
    const a = apiClient(h.server, alice);
    for (const body of [
      {},
      { imagePolicy: 'sometimes' },
      { folder: '' },
      { inferenceMode: 'active' },
    ]) {
      expect((await a.patch(`/subscriptions/${sub.feed.id}`, body)).statusCode).toBe(400);
    }
    expect((await a.patch('/subscriptions/abc', { hidden: true })).statusCode).toBe(400);
    const foreign = await apiClient(h.server, bob).patch(`/subscriptions/${sub.feed.id}`, {
      hidden: true,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('NOT_FOUND');
    expect((await a.patch('/subscriptions/999999999', { hidden: true })).statusCode).toBe(404);
  });
});

describe('feed preferences (spec 08 §4.2)', () => {
  it('remembers a policy for a bookmark origin feed and 404s for unrelated feeds', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const origin = await createFeed(h.owner);
    const article = await createArticle(h.owner, { feedIds: [origin.id] });
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status,
                                 bookmark_origin_feed_id)
       VALUES ($1, $2, now(), 'pending', $3)`,
      [alice.id, article.id, origin.id],
    );
    const put = await apiClient(h.server, alice).put(`/feed-preferences/${origin.id}`, {
      imagePolicy: 'allow',
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({
      feedId: origin.id,
      imagePolicy: 'allow',
      effectiveImagesAllowed: true,
    });
    expect((await apiClient(h.server, alice).get('/feed-preferences')).json()).toEqual([
      put.json(),
    ]);
    // Bob has no subscription, bookmark or preference for the feed.
    const foreign = await apiClient(h.server, bob).put(`/feed-preferences/${origin.id}`, {
      imagePolicy: 'allow',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await apiClient(h.server, bob).get('/feed-preferences')).json()).toEqual([]);
    const invalid = await apiClient(h.server, alice).put(`/feed-preferences/${origin.id}`, {
      imagePolicy: 'never',
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('POST /subscriptions/:feedId/inference (spec 08 §4.1)', () => {
  it('transitions modes with CAS, stamps activation, and ranks on each change', async () => {
    const alice = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://modes.example.com/feed.xml', 'Modes');
    const a = apiClient(h.server, alice);
    const url = `/subscriptions/${sub.feed.id}/inference`;
    const ranks = () => intents('user.rank', { userId: alice.id });
    const ranksBefore = (await ranks()).length;
    const revisionBefore = await rankRevision(alice.id);
    const providerBefore = await providerIntentCount();

    const training = await a.post(url, { mode: 'training', expectedVersion: '0' });
    expect(training.statusCode, training.body).toBe(200);
    expect(training.json().subscription).toMatchObject({
      inferenceMode: 'training',
      inferenceVersion: '1',
      inferenceActivatedAt: null,
    });

    // Reapplying the current mode is a no-op (same version, no rank intent).
    const same = await a.post(url, { mode: 'training', expectedVersion: '1' });
    expect(same.json().subscription.inferenceVersion).toBe('1');
    expect((await rankRevision(alice.id)) - revisionBefore).toBe(1);

    // A stale version is rejected.
    const stale = await a.post(url, { mode: 'active', expectedVersion: '0' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'STALE_STATE',
      details: { currentVersion: '1' },
    });

    const active = await a.post(url, { mode: 'active', expectedVersion: '1' });
    expect(active.statusCode, active.body).toBe(200);
    const row = await subscriptionRow(alice.id, sub.feed.id);
    expect(row?.inference_activated_at).not.toBeNull();
    expect(active.json().subscription).toMatchObject({
      inferenceMode: 'active',
      inferenceVersion: '2',
      inferenceActivatedAt: row!.inference_activated_at!.toISOString(),
    });

    const off = await a.post(url, { mode: 'off', expectedVersion: '2' });
    expect(off.json().subscription).toMatchObject({
      inferenceMode: 'off',
      inferenceVersion: '3',
      inferenceActivatedAt: null,
    });
    // Each of the three changes invalidated the ranking (`rank_revision`); undelivered full-rank
    // intents of one user coalesce into one outbox row.
    expect((await rankRevision(alice.id)) - revisionBefore).toBe(3);
    expect((await ranks()).slice(ranksBefore)).toEqual([
      { userId: alice.id, reason: 'inference_mode', full: true },
    ]);
    // Activation is prospective: no backfill or other provider demand is created by a mode change.
    expect(await providerIntentCount()).toBe(providerBefore);
  });

  it('validates the body and 404s for another user’s feed', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://modes2.example.com/feed.xml', 'Modes 2');
    const url = `/subscriptions/${sub.feed.id}/inference`;
    for (const body of [
      { mode: 'auto', expectedVersion: '0' },
      { mode: 'active' },
      { mode: 'active', expectedVersion: 'x' },
    ]) {
      expect((await apiClient(h.server, alice).post(url, body)).statusCode).toBe(400);
    }
    const foreign = await apiClient(h.server, bob).post(url, {
      mode: 'active',
      expectedVersion: '0',
    });
    expect(foreign.statusCode).toBe(404);
    expect((await subscriptionRow(alice.id, sub.feed.id))?.inference_mode).toBe('off');
  });
});

describe('DELETE /subscriptions/:feedId', () => {
  it('unsubscribes, refreshes the feed and ranks; a second delete and other users get 404', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const sub = await subscribeTo(alice, 'https://bye.example.com/feed.xml', 'Bye');
    expect(
      (await apiClient(h.server, bob).delete(`/subscriptions/${sub.feed.id}`)).statusCode,
    ).toBe(404);
    const res = await apiClient(h.server, alice).delete(`/subscriptions/${sub.feed.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await subscriptionRow(alice.id, sub.feed.id)).toBeUndefined();
    const feed = await feedRow(sub.feed.id);
    expect(feed.subscriber_count).toBe(0);
    expect(feed.unsubscribed_at).not.toBeNull();
    expect((await intents('user.rank', { userId: alice.id })).at(-1)).toEqual({
      userId: alice.id,
      reason: 'unsubscribe',
      full: true,
    });
    expect(
      (await apiClient(h.server, alice).delete(`/subscriptions/${sub.feed.id}`)).statusCode,
    ).toBe(404);
  });
});

describe('POST /subscriptions/folders/rename', () => {
  it('renames a folder across subscriptions and the folder order, for this user only', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const one = await subscribeTo(alice, 'https://f1.example.com/feed.xml', 'F1', 'Tech');
    const two = await subscribeTo(alice, 'https://f2.example.com/feed.xml', 'F2', 'Tech');
    const three = await subscribeTo(alice, 'https://f3.example.com/feed.xml', 'F3', 'News');
    await createSubscription(h.owner, { userId: bob.id, feedId: one.feed.id });
    await h.owner.query(
      `UPDATE subscriptions SET folder = 'Tech' WHERE user_id = $1 AND feed_id = $2`,
      [bob.id, one.feed.id],
    );
    const a = apiClient(h.server, alice);
    await a.patch('/me', { preferences: { folderOrder: ['News', 'Tech', 'Later'] } });

    const res = await a.post('/subscriptions/folders/rename', { from: 'Tech', to: 'Later' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
    const folders = Object.fromEntries(
      (await a.get('/subscriptions'))
        .json()
        .map((s: { feed: { id: string }; folder: string | null }) => [s.feed.id, s.folder]),
    );
    expect(folders).toEqual({
      [one.feed.id]: 'Later',
      [two.feed.id]: 'Later',
      [three.feed.id]: 'News',
    });
    expect((await a.get('/me')).json().preferences.folderOrder).toEqual(['News', 'Later']);
    expect((await subscriptionRow(bob.id, one.feed.id))?.folder).toBe('Tech');

    // Unknown folder: nothing renamed.
    expect(
      (await a.post('/subscriptions/folders/rename', { from: 'Nope', to: 'X' })).json(),
    ).toEqual({ count: 0 });
    for (const body of [{ from: 'A', to: 'A' }, { from: '', to: 'B' }, { from: 'A' }]) {
      expect((await a.post('/subscriptions/folders/rename', body)).statusCode).toBe(400);
    }
  });
});

describe('GET /subscriptions', () => {
  it('lists only own subscriptions with unread counts over the 14-day carrier window', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const feed = await createFeed(h.owner, { title: 'Counted' });
    await createSubscription(h.owner, { userId: alice.id, feedId: feed.id });
    const day = 86_400_000;
    await createArticle(h.owner, { feedIds: [feed.id] });
    await createArticle(h.owner, { feedIds: [feed.id] });
    const cached = await createArticle(h.owner, { feedIds: [feed.id] });
    const read = await createArticle(h.owner, { feedIds: [feed.id] });
    await createArticle(h.owner, {
      feedIds: [feed.id],
      firstSeenAt: new Date(Date.now() - 20 * day),
    });
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, lane, tier) VALUES ($1, $2, 'for_you', 5)`,
      [alice.id, cached.id],
    );
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, read_at) VALUES ($1, $2, now())`,
      [alice.id, read.id],
    );
    const list = (await apiClient(h.server, alice).get('/subscriptions')).json();
    expect(list).toHaveLength(1);
    // Off: a cached ranking is not shown (neutral `new`); read and out-of-window rows are excluded.
    expect(list[0]).toMatchObject({
      feed: { id: feed.id, title: 'Counted', status: 'active' },
      unread: { forYou: 0, maybe: 0, everything: 0, new: 3 },
    });
    expect((await apiClient(h.server, bob).get('/subscriptions')).json()).toEqual([]);
  });
});
