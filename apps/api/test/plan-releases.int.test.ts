import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { clusterOf } from './support/article-fixtures.js';

let h: ApiHarness;
let now: Date;
let initialNow: Date;
let reader: TestUser;
let feedId: string;
let oldId: string;
let freshId: string;

beforeAll(async () => {
  const date = new Date();
  now = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 7));
  initialNow = now;
  h = await createApiHarness({ clock: { now: () => now } });
  await h.owner.query("UPDATE plans SET release_interval_s = 900 WHERE key = 'beta'");
  reader = await createTestUser(h);
  await h.owner.query("UPDATE users SET timezone = 'UTC' WHERE id = $1", [reader.id]);
  const feed = await createFeed(h.owner);
  feedId = feed.id;
  await createSubscription(h.owner, { userId: reader.id, feedId });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [reader.id, now],
  );
  oldId = (
    await createArticle(h.owner, {
      feedIds: [feedId],
      firstSeenAt: new Date(now.getTime() - 8 * 60000),
      title: 'Released',
    })
  ).id;
  freshId = (
    await createArticle(h.owner, {
      feedIds: [feedId],
      firstSeenAt: new Date(now.getTime() - 2 * 60000),
      title: 'Waiting for release',
    })
  ).id;
});

beforeEach(() => {
  now = new Date(initialNow);
});

afterAll(async () => {
  await h.close();
});
const client = () => apiClient(h.server, reader);
const query = () => ({ lane: 'all', status: 'unread', feedId, minTier: '1' });

async function page() {
  const res = await client().get('/articles', { query: query() });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('stored plan release boundary', () => {
  it('keeps list, counts, unread badges and detail behind the same release', async () => {
    expect((await page()).items.map((item: { id: string }) => item.id)).toEqual([oldId]);
    const counts = await client().get('/articles/counts', { query: { feedId, minTier: '1' } });
    expect(counts.json().total).toBe(1);
    const subscriptions = await client().get('/subscriptions');
    expect(subscriptions.json()[0].unread.new).toBe(1);
    expect((await client().get(`/articles/${freshId}`)).statusCode).toBe(404);
    expect((await client().get(`/articles/${oldId}`)).statusCode).toBe(200);
  });

  it('cannot advance counts by supplying a future asOf', async () => {
    const res = await client().get('/articles/counts', {
      query: { feedId, minTier: '1', asOf: new Date(now.getTime() + 86400000).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().total).toBe(1);
    expect(Date.parse(res.json().asOf)).toBeLessThanOrEqual(now.getTime());
  });

  it('does not expose an unreleased article through a rating, draft, or explicit analysis', async () => {
    const rating = await client().post(`/articles/${freshId}/rating`, {
      stateVersion: '0',
      contentRevision: '1',
      rating: 1,
    });
    expect(rating.statusCode, rating.body).toBe(404);
    const draft = await client().post('/cards/drafts', { articleIds: [freshId] });
    expect(draft.statusCode, draft.body).toBe(404);
    const analysis = await client().post(`/subscriptions/${feedId}/analyze`, {
      articles: [{ id: freshId, contentRevision: '1' }],
      expectedInferenceVersion: '0',
      startTraining: true,
    });
    expect(analysis.statusCode, analysis.body).toBe(404);
    // Automatic ranking alone is not an engagement or an access grant.
    await h.owner.query(
      "INSERT INTO user_article (user_id, article_id, lane) VALUES ($1, $2, 'new') ON CONFLICT DO NOTHING",
      [reader.id, freshId],
    );
    expect((await client().post('/cards/drafts', { articleIds: [freshId] })).statusCode).toBe(404);
  });

  it('mark-read by a confirmed filter touches only released articles', async () => {
    const list = await page();
    const marked = await client().post('/articles/mark-read', {
      filter: { lane: 'all', feedId, minTier: 1, olderThan: list.asOf },
      datasetVersion: list.datasetVersion,
    });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().count).toBe(1);
    const fresh = await h.owner.query(
      'SELECT read_at FROM user_article WHERE user_id = $1 AND article_id = $2',
      [reader.id, freshId],
    );
    expect(fresh.rows[0]?.read_at ?? null).toBeNull();
  });

  it('releases the waiting article at the next boundary', async () => {
    now = new Date(now.getTime() + 8 * 60000);
    expect((await page()).items.map((item: { id: string }) => item.id)).toContain(freshId);
    expect((await client().get(`/articles/${freshId}`)).statusCode).toBe(200);
  });
});

it('shows a new subscription immediately and keeps grace articles visible after grace ends', async () => {
  const newcomer = await createTestUser(h);
  await h.owner.query("UPDATE users SET timezone = 'UTC' WHERE id = $1", [newcomer.id]);
  await createSubscription(h.owner, { userId: newcomer.id, feedId });
  const started = new Date(now.getTime() - 14 * 60000);
  await h.owner.query('UPDATE subscriptions SET created_at = $2 WHERE user_id = $1', [
    newcomer.id,
    started,
  ]);
  const arrival = new Date(now.getTime() - 60000);
  const item = await createArticle(h.owner, { feedIds: [feedId], firstSeenAt: arrival });
  const c = apiClient(h.server, newcomer);
  const load = async () =>
    (await c.get('/articles', { query: query() }))
      .json()
      .items.map((row: { id: string }) => row.id);
  expect(await load()).toContain(item.id);
  now = new Date(now.getTime() + 2 * 60000);
  expect(await load()).toContain(item.id);
});

async function following(plan: string, timezone = 'UTC') {
  const user = await createTestUser(h);
  await h.owner.query('UPDATE users SET plan = $2, timezone = $3 WHERE id = $1', [
    user.id,
    plan,
    timezone,
  ]);
  await createSubscription(h.owner, {
    userId: user.id,
    feedId,
    mode: 'active',
    activatedAt: new Date(now.getTime() - 2 * 86400000),
  });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [user.id, now],
  );
  return { user, api: apiClient(h.server, user) };
}

it('releases the same shared feed independently for each plan and applies plan changes live', async () => {
  await h.owner.query(
    "UPDATE plans SET release_interval_s = CASE key WHEN 'free' THEN 21600 WHEN 'premium' THEN 60 END WHERE key IN ('free', 'premium')",
  );
  const free = await following('free');
  const premium = await following('premium');
  const ids = async (api: ReturnType<typeof apiClient>) =>
    (await api.get('/articles', { query: query() }))
      .json()
      .items.map((row: { id: string }) => row.id);
  expect(await ids(free.api)).not.toContain(freshId);
  expect(await ids(premium.api)).toContain(freshId);
  await h.owner.query("UPDATE users SET plan = 'premium' WHERE id = $1", [free.user.id]);
  expect(await ids(free.api)).toContain(freshId);
  await h.owner.query("UPDATE users SET plan = 'free' WHERE id = $1", [free.user.id]);
  expect((await free.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
});

it('uses the account time zone for a six-hour release, including fractional offsets', async () => {
  await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
  const local = await following('free', 'Asia/Kathmandu');
  const ids = async () =>
    (await local.api.get('/articles', { query: query() }))
      .json()
      .items.map((row: { id: string }) => row.id);
  expect(await ids()).not.toContain(oldId);
  now = new Date(initialNow.getTime() + 8 * 60000); // 18:00 in Kathmandu
  expect(await ids()).toContain(oldId);
  expect(await ids()).toContain(freshId);
});

it('bounds shared fetch metadata and reports account cadence, publisher limits and next update', async () => {
  const account = await following('beta');
  const success = new Date(now.getTime() - 60000);
  const nextFetch = new Date(now.getTime() + 30 * 60000);
  await h.owner.query(
    "UPDATE feeds SET last_success_at = $2, next_fetch_at = $3, publish_stats = jsonb_build_object('publisher_min_interval_s', 1800) WHERE id = $1",
    [feedId, success, nextFetch],
  );
  const res = await account.api.get('/subscriptions');
  expect(res.statusCode, res.body).toBe(200);
  const feed = res.json()[0].feed;
  const boundary = new Date(now);
  boundary.setUTCMinutes(0, 0, 0);
  expect(feed.lastSuccessAt).toBe(boundary.toISOString());
  expect(feed).toMatchObject({ updateIntervalS: 1800, intervalReason: 'publisher' });
  expect(Date.parse(feed.nextUpdateAt)).toBeGreaterThanOrEqual(nextFetch.getTime());
  expect(new Date(feed.nextUpdateAt).getUTCMinutes()).toBe(45);
  const me = await account.api.get('/me');
  expect(me.json().planInfo).toMatchObject({ label: 'Beta', releaseIntervalS: 900 });
  expect(new Date(me.json().planInfo.nextUpdateAt).getUTCMinutes()).toBe(15);
});

it('does not reveal an unreleased story sibling in a released article detail', async () => {
  const account = await following('beta');
  const released = await createArticle(h.owner, {
    feedIds: [feedId],
    firstSeenAt: new Date(now.getTime() - 8 * 60000),
  });
  const hidden = await createArticle(h.owner, {
    feedIds: [feedId],
    firstSeenAt: new Date(now.getTime() - 60000),
    title: 'Secret sibling',
  });
  const clusterId = await clusterOf(h, [released.id, hidden.id]);
  await h.owner.query('UPDATE story_clusters SET representative_article_id = $2 WHERE id = $1', [
    clusterId,
    hidden.id,
  ]);
  const res = await account.api.get(`/articles/${released.id}`);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().clusterMembers).toEqual([]);
  expect(res.body).not.toContain('Secret sibling');
  const rule = await account.api.post('/rules', {
    kind: 'mute_story',
    value: clusterId,
    expiresInDays: 1,
  });
  expect(rule.statusCode, rule.body).toBe(201);
  expect(rule.body).not.toContain('Secret sibling');
  expect((await account.api.get('/rules')).body).not.toContain('Secret sibling');
  expect((await account.api.get(`/articles/${hidden.id}`)).statusCode).toBe(404);
});

it('refuses a story rule when its only carrier has not been released, even with a ranking row', async () => {
  const account = await following('beta');
  const hidden = await createArticle(h.owner, {
    feedIds: [feedId],
    firstSeenAt: new Date(now.getTime() - 60000),
  });
  const clusterId = await clusterOf(h, [hidden.id]);
  await h.owner.query(
    "INSERT INTO user_article (user_id, article_id, lane) VALUES ($1, $2, 'new')",
    [account.user.id, hidden.id],
  );
  const result = await account.api.post('/rules', {
    kind: 'mute_story',
    value: clusterId,
    expiresInDays: 1,
  });
  expect(result.statusCode, result.body).toBe(404);
});
