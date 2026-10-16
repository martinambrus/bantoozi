import {
  bindReaderClock,
  cardsMadeFromFeedArticles,
  createDatabase,
  readerReleaseClock,
  withTenants,
} from '@bantoozi/db';
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
