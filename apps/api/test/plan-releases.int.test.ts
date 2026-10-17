import {
  bindReaderClock,
  cardsMadeFromFeedArticles,
  createDatabase,
  insertSubscription,
  insertSubscriptions,
  readerReleaseClock,
  seedQuestionSets,
  withTenants,
} from '@bantoozi/db';
import { ALL_QUESTION_SETS, LATEST_QUESTION_SETS } from '@bantoozi/questions';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
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

beforeEach(async () => {
  now = new Date(initialNow);
  await h.owner.query("UPDATE plans SET release_interval_s = 60 WHERE key = 'premium'");
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

async function following(plan: string, timezone = 'UTC', mode: 'active' | 'training' = 'active') {
  const user = await createTestUser(h);
  await h.owner.query('UPDATE users SET plan = $2, timezone = $3 WHERE id = $1', [
    user.id,
    plan,
    timezone,
  ]);
  await createSubscription(h.owner, {
    userId: user.id,
    feedId,
    mode,
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

it('keeps a monotonic release cutoff across repeated timezone edits and reports the held boundary', async () => {
  await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
  const account = await following('free');
  now = new Date(initialNow.getTime() + 30 * 60000); // 12:37 UTC, after Kathmandu's 12:15 boundary
  const unfetched = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: account.user.id, feedId: unfetched.id });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [account.user.id, now],
  );
  await h.owner.query('UPDATE feeds SET next_fetch_at = $2 WHERE id = $1', [
    unfetched.id,
    new Date(now.getTime() + 60000),
  ]);
  const patch = await account.api.patch('/me', { timezone: 'Asia/Kathmandu' });
  expect(patch.statusCode, patch.body).toBe(200);
  const held = new Date(now);
  held.setUTCHours(18, 15, 0, 0);
  expect(patch.json().timezone).toBe('Asia/Kathmandu');
  expect(patch.json().planInfo.nextUpdateAt).toBe(held.toISOString());
  expect((await account.api.get(`/articles/${oldId}`)).statusCode).toBe(200);
  expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
  const feeds = await account.api.get('/subscriptions');
  expect(
    feeds.json().map((row: { feed: { nextUpdateAt: string } }) => row.feed.nextUpdateAt),
  ).toEqual([held.toISOString(), held.toISOString()]);
  // Switching to an aligned zone and back cannot consume the pending interval early.
  const back = await account.api.patch('/me', { timezone: 'UTC' });
  const aligned = new Date(held);
  aligned.setUTCMinutes(0);
  expect(back.json().planInfo.nextUpdateAt).toBe(aligned.toISOString());
  await account.api.patch('/me', { timezone: 'Asia/Kathmandu' });
  expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
  now = new Date(held.getTime() - 1);
  expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
  now = held;
  expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
  const newlyReleased = await createArticle(h.owner, {
    feedIds: [feedId],
    firstSeenAt: new Date(held.getTime() - 60000),
  });
  expect((await account.api.get(`/articles/${newlyReleased.id}`)).statusCode).toBe(200);
  // Moving to an earlier wall-clock window must not hide anything already released.
  const earlier = await account.api.patch('/me', { timezone: 'UTC' });
  expect(earlier.statusCode, earlier.body).toBe(200);
  expect((await account.api.get(`/articles/${newlyReleased.id}`)).statusCode).toBe(200);
});

it.each([60, null])(
  'applies a changed plan cadence %s immediately despite a timezone hold',
  async (cadence) => {
    await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
    const account = await following('free');
    await account.api.patch('/me', { timezone: 'Asia/Kathmandu' });
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
    await h.owner.query("UPDATE plans SET release_interval_s = $1 WHERE key = 'premium'", [
      cadence,
    ]);
    await h.owner.query("UPDATE users SET plan = 'premium' WHERE id = $1", [account.user.id]);
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
    const patched = await account.api.patch('/me', { timezone: 'UTC' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
  },
);

it.each(['assignment', 'cadence'])(
  'does not reactivate a timezone hold after a plan %s round trip',
  async (change) => {
    await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
    const account = await following('free');
    now = new Date(initialNow.getTime() + 30 * 60000);
    await account.api.patch('/me', { timezone: 'Asia/Kathmandu' });
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
    // A cosmetic edit must preserve the active hold.
    await h.owner.query("UPDATE plans SET label = label, version = version + 1 WHERE key = 'free'");
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
    if (change === 'assignment') {
      await h.owner.query("UPDATE users SET plan = 'premium' WHERE id = $1", [account.user.id]);
    } else {
      await h.owner.query("UPDATE plans SET release_interval_s = 60 WHERE key = 'free'");
    }
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
    if (change === 'assignment') {
      await h.owner.query("UPDATE users SET plan = 'free' WHERE id = $1", [account.user.id]);
    } else {
      await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
    }
    // The normal 12:15 boundary applies; the old 18:15 hold must stay invalid.
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
  },
);

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
  // The shared feed already has a waiting article. Release it at 12:15 even if the next source
  // fetch is at 12:37 (whose arrivals would wait until 12:45).
  expect(new Date(feed.nextUpdateAt).getUTCMinutes()).toBe(15);
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
  const source = await createFeed(h.owner, { title: 'Released sibling source' });
  await createSubscription(h.owner, { userId: account.user.id, feedId: source.id, mode: 'off' });
  const visible = await createArticle(h.owner, {
    feedIds: [source.id],
    firstSeenAt: new Date(now.getTime() - 3600000),
  });
  // The lower-id feed carries this member too, but its copy is not yet released.
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES ($1, $2, 'waiting-copy', $3)`,
    [feedId, visible.id, new Date(now.getTime() - 60000)],
  );
  const clusterId = await clusterOf(h, [released.id, hidden.id, visible.id]);
  await h.owner.query('UPDATE story_clusters SET representative_article_id = $2 WHERE id = $1', [
    clusterId,
    hidden.id,
  ]);
  const res = await account.api.get(`/articles/${released.id}`);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().clusterMembers).toMatchObject([
    { id: visible.id, feedTitle: 'Released sibling source' },
  ]);
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

it('estimates a future fetch boundary when the source has no waiting articles', async () => {
  const account = await following('beta');
  const empty = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: account.user.id, feedId: empty.id });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [account.user.id, now],
  );
  const nextFetch = new Date(now.getTime() + 30 * 60000);
  await h.owner.query(
    "UPDATE feeds SET last_success_at = $2, next_fetch_at = $3, publish_stats = jsonb_build_object('publisher_min_interval_s', 1800) WHERE id = $1",
    [empty.id, now, nextFetch],
  );
  const result = await account.api.get('/subscriptions');
  expect(result.statusCode, result.body).toBe(200);
  const feed = result.json().find((row: { feed: { id: string } }) => row.feed.id === empty.id).feed;
  expect(new Date(feed.nextUpdateAt).getUTCMinutes()).toBe(45);
  expect(feed.intervalReason).toBe('publisher');
});

it('reports a fast feed that robots slowed as limited by the source (D-267)', async () => {
  const account = await following('premium');
  const slowed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: account.user.id, feedId: slowed.id });
  const subscriptions = async () => {
    const result = await account.api.get('/subscriptions');
    expect(result.statusCode, result.body).toBe(200);
    return result.json().find((row: { feed: { id: string } }) => row.feed.id === slowed.id).feed;
  };
  expect(await subscriptions()).toMatchObject({ updateIntervalS: 60, intervalReason: 'plan' });
  await h.owner.query(
    "UPDATE feeds SET publish_stats = jsonb_build_object('robots_slow_since', $2::text) WHERE id = $1",
    [slowed.id, now.toISOString()],
  );
  expect(await subscriptions()).toMatchObject({ updateIntervalS: 300, intervalReason: 'source' });
});

it('keeps plan metadata separate when a worker transaction visits multiple tenants', async () => {
  const free = await following('free');
  const premium = await following('premium');
  const clocks = await withTenants(
    createDatabase(h.owner),
    [free.user.id, premium.user.id, free.user.id],
    async (tx) => {
      bindReaderClock(tx, now);
      return readerReleaseClock(tx);
    },
  );
  expect(clocks.map((clock) => clock.intervalS)).toEqual([21600, 60, 21600]);
  expect(clocks.every((clock) => clock.now.getTime() === now.getTime())).toBe(true);
});

async function selectForFixture(userId: string, articleId: string) {
  const client = await h.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query(
      `INSERT INTO analysis_requests (id, user_id, feed_id, article_id, article_revision,
      inference_version, input_snapshot, input_sha) VALUES (gen_random_uuid(), $1, $2, $3, 1, 1, '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'))`,
      [userId, feedId, articleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

it('does not let a waiting active carrier authorize inference for an earlier off-feed arrival', async () => {
  const account = await following('beta');
  const off = await createFeed(h.owner, { title: 'Released off source' });
  await createSubscription(h.owner, { userId: account.user.id, feedId: off.id, mode: 'off' });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [account.user.id, now],
  );
  const article = await createArticle(h.owner, {
    feedIds: [off.id],
    firstSeenAt: new Date(now.getTime() - 3600000),
  });
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES ($1, $2, 'waiting-active', $3)`,
    [feedId, article.id, new Date(now.getTime() - 120000)],
  );
  await h.owner.query(
    `INSERT INTO user_article (user_id, article_id, lane, tier, p_like, score_version)
    VALUES ($1, $2, 'for_you', 5, 0.9, '2:0')`,
    [account.user.id, article.id],
  );
  const load = async () => {
    const res = await account.api.get('/articles', {
      query: { lane: 'all', status: 'all', minTier: '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items.find((item: { id: string }) => item.id === article.id);
  };
  // A still-live selected request made while this carrier was visible must respect the new plan too.
  await selectForFixture(account.user.id, article.id);
  expect(await load()).toMatchObject({ lane: 'new', pLike: null, feed: { id: off.id } });
  now = new Date(now.getTime() + 8 * 60000);
  expect(await load()).toMatchObject({ lane: 'for_you', pLike: 0.9, feed: { id: feedId } });
});

it('keeps saved articles globally available without exposing a waiting feed or folder association', async () => {
  const account = await following('beta');
  const source = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: account.user.id, feedId: source.id, mode: 'off' });
  await h.owner.query(
    "UPDATE subscriptions SET folder = 'Waiting copies' WHERE user_id = $1 AND feed_id = $2",
    [account.user.id, feedId],
  );
  const article = await createArticle(h.owner, {
    feedIds: [source.id],
    firstSeenAt: new Date(now.getTime() - 3600000),
  });
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES ($1, $2, 'waiting-bookmark', $3)`,
    [feedId, article.id, new Date(now.getTime() - 60000)],
  );
  await h.owner.query(
    "INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status) VALUES ($1, $2, $3, 'pending')",
    [account.user.id, article.id, now],
  );
  const saved = async (scope: Record<string, string>) => {
    const res = await account.api.get('/articles', {
      query: { lane: 'bookmarks', status: 'all', ...scope },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items.map((item: { id: string }) => item.id);
  };
  expect(await saved({})).toContain(article.id);
  for (const scope of [{ feedId }, { folder: 'Waiting copies' }]) {
    expect(await saved(scope)).not.toContain(article.id);
    const counts = await account.api.get('/articles/counts', { query: scope });
    expect(counts.statusCode, counts.body).toBe(200);
    expect(counts.json().bookmarks).toBe(0);
  }
  now = new Date(now.getTime() + 8 * 60000);
  expect(await saved({ feedId })).toContain(article.id);
  expect(await saved({ folder: 'Waiting copies' })).toContain(article.id);
});

it('captures rating features only from released active and selected carriers', async () => {
  const account = await following('beta');
  const visible = await createFeed(h.owner);
  await createSubscription(h.owner, {
    userId: account.user.id,
    feedId: visible.id,
    mode: 'active',
    activatedAt: new Date(now.getTime() - 86400000),
  });
  const card = await createCard(h.owner);
  await h.owner.query(
    "INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $2, 'like', $3)",
    [account.user.id, card.id, feedId],
  );
  const articleTitle = 'Visible learning example';
  const article = await createArticle(h.owner, {
    title: articleTitle,
    feedIds: [visible.id],
    firstSeenAt: new Date(now.getTime() - 3600000),
  });
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
    VALUES ($1, $2, 'waiting-rating', $3)`,
    [feedId, article.id, new Date(now.getTime() - 60000)],
  );
  await selectForFixture(account.user.id, article.id);
  const rated = await account.api.post(`/articles/${article.id}/rating`, {
    stateVersion: '0',
    contentRevision: '1',
    rating: 1,
  });
  expect(rated.statusCode, rated.body).toBe(200);
  const event = await h.owner.query<{
    value: {
      features: { sourceManifest: { inferenceFeedIds: string[] }; cards: { id: string }[] };
    };
  }>("SELECT value FROM feedback_events WHERE user_id = $1 AND article_id = $2 AND kind = 'rate'", [
    account.user.id,
    article.id,
  ]);
  expect(event.rows[0]!.value.features.sourceManifest.inferenceFeedIds).toEqual([visible.id]);
  expect(event.rows[0]!.value.features.cards.map((item) => item.id)).not.toContain(card.id);
  // The sidebar's card/example agreement must not reveal the later carrier either.
  const exampleCard = await account.api.post('/cards/from-article', {
    articleId: article.id,
    interest: 'Card from a released learning example',
    strength: 'like',
  });
  expect(exampleCard.statusCode, exampleCard.body).toBe(201);
  const made = async () =>
    (
      await withTenants(createDatabase(h.owner), [account.user.id], async (tx) => {
        bindReaderClock(tx, now);
        return cardsMadeFromFeedArticles(tx, [visible.id, feedId]);
      })
    )[0]!;
  expect((await made()).has(visible.id)).toBe(true);
  expect((await made()).has(feedId)).toBe(false);
  now = new Date(now.getTime() + 8 * 60000);
  expect((await made()).has(feedId)).toBe(true);
});

it('rounds fetches after subscription grace ends while keeping in-grace arrivals immediate', async () => {
  const account = await following('free');
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '5 minutes' WHERE user_id = $1",
    [account.user.id, now],
  );
  for (const [minutes, expected] of [
    [30, '18:00:00.000Z'],
    [2, '12:09:00.000Z'],
    [10, '12:17:00.000Z'],
  ] as const) {
    await h.owner.query(
      "UPDATE feeds SET next_fetch_at = $2, publish_stats = '{}'::jsonb WHERE id = $1",
      [feedId, new Date(now.getTime() + minutes * 60000)],
    );
    const res = await account.api.get('/subscriptions');
    expect(res.statusCode, res.body).toBe(200);
    expect(
      res.json().find((row: { feed: { id: string } }) => row.feed.id === feedId).feed.nextUpdateAt,
    ).toBe(`${now.toISOString().slice(0, 11)}${expected}`);
  }
});

it('rejects a retained selected-request ID when its carrier becomes unreleased after a plan change', async () => {
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(
      tx,
      ALL_QUESTION_SETS,
      Object.fromEntries(
        Object.entries(LATEST_QUESTION_SETS).map(([kind, set]) => [kind, set.version]),
      ),
    ),
  );
  const account = await following('premium', 'UTC', 'training');
  const off = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: account.user.id, feedId: off.id, mode: 'off' });
  await h.owner.query(
    "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
    [account.user.id, now],
  );
  const article = await createArticle(h.owner, {
    feedIds: [off.id],
    firstSeenAt: new Date(now.getTime() - 3600000),
  });
  await h.owner.query(
    `INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
     VALUES ($1, $2, 'retained-request', $3)`,
    [feedId, article.id, new Date(now.getTime() - 60000)],
  );
  const selection = await account.api.post(`/subscriptions/${feedId}/analyze`, {
    articles: [{ id: article.id, contentRevision: article.contentRevision }],
    expectedInferenceVersion: '1',
  });
  expect(selection.statusCode, selection.body).toBe(202);
  const requestId = selection.json().requests[0].id;
  await h.owner.query("UPDATE users SET plan = 'free' WHERE id = $1", [account.user.id]);
  expect((await account.api.get(`/articles/${article.id}`)).statusCode).toBe(200);
  const payload = {
    stateVersion: '0',
    contentRevision: article.contentRevision,
    rating: 1,
    analysisRequestId: requestId,
  };
  const waiting = await account.api.post(`/articles/${article.id}/rating`, payload);
  expect(waiting.statusCode, waiting.body).toBe(409);
  expect(waiting.json().error.details.reason).toBe('obsolete_request');
  const events = await h.owner.query(
    'SELECT id FROM feedback_events WHERE user_id = $1 AND article_id = $2',
    [account.user.id, article.id],
  );
  expect(events.rowCount).toBe(0);
  now = new Date(now);
  now.setUTCHours(18, 0, 0, 0);
  const released = await account.api.post(`/articles/${article.id}/rating`, payload);
  expect(released.statusCode, released.body).toBe(200);
});

it.each(['single', 'opml'])(
  'does not renew release grace on re-subscription through %s, including after resetting image policy',
  async (method) => {
    const account = await following('free');
    const original = await h.owner.query(
      'SELECT created_at FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [account.user.id, feedId],
    );
    const removed = await account.api.delete(`/subscriptions/${feedId}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const preference = await account.api.put(`/feed-preferences/${feedId}`, {
      imagePolicy: 'inherit',
    });
    expect(preference.statusCode, preference.body).toBe(200);
    await withTenants(createDatabase(h.owner), [account.user.id], async (tx) => {
      if (method === 'single') {
        expect(await insertSubscription(tx, { feedId, folder: null })).toBe(true);
      } else {
        expect(await insertSubscriptions(tx, [{ feedId, folder: null }])).toEqual([feedId]);
      }
    });
    const restored = await h.owner.query(
      'SELECT created_at FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [account.user.id, feedId],
    );
    expect(restored.rows[0].created_at).toEqual(original.rows[0].created_at);
    expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(404);
    const me = await account.api.get('/me');
    const feed = (await account.api.get('/subscriptions'))
      .json()
      .find((s: { feed: { id: string } }) => s.feed.id === feedId).feed;
    expect(feed.nextUpdateAt).toBe(me.json().planInfo.nextUpdateAt);
  },
);

it.each([null, 0])(
  'keeps immediate-plan %s predictions on the account cadence instead of a faster shared fetch',
  async (cadence) => {
    await h.owner.query("UPDATE plans SET release_interval_s = $1 WHERE key = 'free'", [cadence]);
    try {
      const account = await following('free');
      await h.owner.query(
        "UPDATE feeds SET last_success_at = $2, next_fetch_at = $3, publish_stats = '{}'::jsonb WHERE id = $1",
        [feedId, new Date(now.getTime() - 30000), new Date(now.getTime() + 60000)],
      );
      const boundary = new Date(now);
      boundary.setUTCHours(18, 0, 0, 0);
      for (let check = 0; check < 2; check += 1) {
        const res = await account.api.get('/subscriptions');
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()[0].feed).toMatchObject({
          updateIntervalS: 21600,
          intervalReason: 'plan',
          nextUpdateAt: boundary.toISOString(),
        });
        now = new Date(now.getTime() + 60000);
      }
      // The forecast floor is not an article access gate on an explicitly immediate plan.
      expect((await account.api.get(`/articles/${freshId}`)).statusCode).toBe(200);
    } finally {
      await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
    }
  },
);

it.each([null, 900])(
  'honors both fetch and release floors %s, applying grace only to in-grace fetches',
  async (cadence) => {
    await h.owner.query("UPDATE plans SET release_interval_s = $1 WHERE key = 'free'", [cadence]);
    try {
      const account = await following('free');
      const empty = await createFeed(h.owner);
      await createSubscription(h.owner, { userId: account.user.id, feedId: empty.id });
      await h.owner.query(
        "UPDATE subscriptions SET created_at = $2::timestamptz - interval '1 day' WHERE user_id = $1",
        [account.user.id, now],
      );
      const load = async () => {
        const res = await account.api.get('/subscriptions');
        expect(res.statusCode, res.body).toBe(200);
        return res.json();
      };
      const boundary = new Date(now);
      boundary.setUTCHours(18, 0, 0, 0);
      await h.owner.query(
        "UPDATE feeds SET last_success_at = $2, next_fetch_at = $3, publish_stats = '{}'::jsonb WHERE id = $1",
        [empty.id, new Date(now.getTime() - 30000), new Date(now.getTime() + 60000)],
      );
      const rows = await load();
      expect(rows.find((s: { feed: { id: string } }) => s.feed.id === empty.id).feed).toMatchObject(
        {
          updateIntervalS: 21600,
          intervalReason: 'plan',
          nextUpdateAt: boundary.toISOString(),
        },
      );
      if (cadence !== null) {
        // Already fetched articles still release at 12:15; the fetch forecast cannot delay them.
        const release = new Date(now);
        release.setUTCMinutes(15, 0, 0);
        expect(
          rows.find((s: { feed: { id: string } }) => s.feed.id === feedId).feed.nextUpdateAt,
        ).toBe(release.toISOString());
      }
      await h.owner.query(
        "UPDATE subscriptions SET created_at = $2::timestamptz - interval '5 minutes' WHERE user_id = $1 AND feed_id = $3",
        [account.user.id, now, empty.id],
      );
      for (const minutes of [2, 30]) {
        const fetch = new Date(now.getTime() + minutes * 60000);
        await h.owner.query('UPDATE feeds SET next_fetch_at = $2 WHERE id = $1', [empty.id, fetch]);
        expect(
          (await load()).find((s: { feed: { id: string } }) => s.feed.id === empty.id).feed
            .nextUpdateAt,
        ).toBe((minutes === 2 ? fetch : boundary).toISOString());
      }
    } finally {
      await h.owner.query("UPDATE plans SET release_interval_s = 21600 WHERE key = 'free'");
    }
  },
);
