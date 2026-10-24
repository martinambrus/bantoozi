import { createHash } from 'node:crypto';

import { createArticle, createFeed, createSubscription, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  deleteSubscription,
  insertSubscription,
  insertSubscriptions,
} from '../src/api/subscriptions.js';
import { ingestItem, type IngestItemInput } from '../src/ingest/articles.js';
import { mergeArticles } from '../src/ingest/merge-articles.js';
import { mergeFeeds } from '../src/ingest/merge-feeds.js';
import { workerOutbox } from '../src/outbox.js';
import { loadEstimateRatings } from '../src/rank/context.js';
import { withTenant } from '../src/tenant.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;
beforeAll(async () => {
  ctx = await setupDbTest();
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  await ctx.owner.query('DELETE FROM job_outbox');
});

async function rate(userId: string, articleId: string, rating: number | null = 1) {
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)`,
    [userId, articleId, rating, rating === null ? null : new Date()],
  );
}
async function pending() {
  const res = await ctx.owner.query<{ user_id: string }>(
    `SELECT payload->>'userId' AS user_id FROM job_outbox WHERE queue = 'user.estimate' AND delivered_at IS NULL ORDER BY payload->>'userId'`,
  );
  return res.rows.map((r) => r.user_id);
}
async function world() {
  const low = await createFeed(ctx.owner);
  const high = await createFeed(ctx.owner);
  const user = await createUser(ctx.owner);
  const other = await createUser(ctx.owner);
  const unrelated = await createUser(ctx.owner);
  const unrelatedFeed = await createFeed(ctx.owner);
  const unrelatedArticle = await createArticle(ctx.owner, { feedIds: [unrelatedFeed.id] });
  await rate(unrelated.id, unrelatedArticle.id);
  const article = await createArticle(ctx.owner, { feedIds: [low.id, high.id] });
  await rate(user.id, article.id);
  await rate(other.id, article.id, null);
  return {
    low: low.id,
    high: high.id,
    user: user.id,
    other: other.id,
    unrelated: unrelated.id,
    article: article.id,
  };
}

it.each(['single', 'batch'] as const)(
  '%s subscribe and unsubscribe wake only the reader with an explicit rating on that feed',
  async (kind) => {
    const w = await world();
    await createSubscription(ctx.owner, { userId: w.user, feedId: w.high });
    const insert = (userId: string) =>
      withTenant(ctx.app, userId, async (tx) => {
        if (kind === 'single') await insertSubscription(tx, { feedId: w.low, folder: null });
        else await insertSubscriptions(tx, [{ feedId: w.low, folder: null }]);
      });
    expect((await loadEstimateRatings(ctx.worker, w.user, new Date(0)))[0]?.feedId).toBe(w.high);
    await insert(w.user);
    await insert(w.other);
    await insert(w.unrelated);
    expect((await loadEstimateRatings(ctx.worker, w.user, new Date(0)))[0]?.feedId).toBe(w.low);
    expect(await pending()).toEqual([w.user]);
    await ctx.owner.query('DELETE FROM job_outbox');
    await insert(w.user);
    expect(await pending()).toEqual([]);
    await withTenant(ctx.app, w.user, (tx) => deleteSubscription(tx, w.low));
    await withTenant(ctx.app, w.other, (tx) => deleteSubscription(tx, w.low));
    await withTenant(ctx.app, w.unrelated, (tx) => deleteSubscription(tx, w.low));
    expect(await pending()).toEqual([w.user]);
    expect((await loadEstimateRatings(ctx.worker, w.user, new Date(0)))[0]?.feedId).toBe(w.high);
  },
);

it('subscription state and its estimate intent roll back together under the API role', async () => {
  const w = await world();
  await expect(
    withTenant(ctx.app, w.user, async (tx) => {
      await insertSubscription(tx, { feedId: w.low, folder: null });
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await pending()).toEqual([]);
  expect((await loadEstimateRatings(ctx.worker, w.user, new Date(0)))[0]?.feedId).toBeNull();
});

it('article merges wake source and target raters, excluding implicit and unrelated readers', async () => {
  const w = await world();
  const target = await createArticle(ctx.owner, { feedIds: [w.high] });
  const targetRater = await createUser(ctx.owner);
  await rate(targetRater.id, target.id, -1);
  await ctx.worker.transaction((tx) =>
    mergeArticles(tx, workerOutbox(tx), w.article, target.id, { reason: 'redirect' }),
  );
  expect(await pending()).toEqual([w.user, targetRater.id].sort());
});

it('a merge coalescing two explicit ratings wakes their reader once', async () => {
  const w = await world();
  const target = await createArticle(ctx.owner, { feedIds: [w.high] });
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, -1, now() + interval '1 minute')`,
    [w.user, target.id],
  );
  await ctx.worker.transaction((tx) =>
    mergeArticles(tx, workerOutbox(tx), w.article, target.id, { reason: 'redirect' }),
  );
  expect(await pending()).toEqual([w.user]);
});

it('feed merges wake raters subscribed to either feed, including target-only subscribers rating moved articles', async () => {
  const w = await world();
  const sourceArticle = await createArticle(ctx.owner, { feedIds: [w.low] });
  const targetOnly = await createUser(ctx.owner);
  await rate(targetOnly.id, sourceArticle.id, -1);
  await createSubscription(ctx.owner, { userId: targetOnly.id, feedId: w.high });
  await createSubscription(ctx.owner, { userId: w.user, feedId: w.low });
  await createSubscription(ctx.owner, { userId: w.other, feedId: w.low });
  await createSubscription(ctx.owner, { userId: w.unrelated, feedId: w.low });
  await ctx.worker.transaction((tx) => mergeFeeds(tx, workerOutbox(tx), w.low, w.high));
  expect(await pending()).toEqual([w.user, targetOnly.id].sort());
});

function item(feedId: string): IngestItemInput {
  const url = `https://estimate.example.test/${feedId}`;
  return {
    feedId,
    urlKey: url,
    canonicalUrl: url,
    url,
    guid: null,
    title: 'Original title',
    titleNorm: 'original title',
    author: null,
    categories: [],
    excerpt: 'Original excerpt',
    excerptHtml: null,
    imageUrl: null,
    publishedAt: new Date(),
    contentHash: createHash('sha256').update(url).digest('hex'),
    feedBody: null,
    linkEnclosureType: null,
    media: { videoEvidence: false, feedBodyImageCount: null },
  };
}
const ingest = (input: IngestItemInput) =>
  ctx.worker.transaction((tx) =>
    ingestItem(tx, workerOutbox(tx), input, { maxAgeDays: 14, linkKey: (url) => url }),
  );

it.each(['title', 'excerpt'] as const)(
  'publisher %s changes wake only explicit raters; unchanged refetches do not',
  async (field) => {
    const feed = await createFeed(ctx.owner);
    const input = item(feed.id);
    const article = await ingest(input);
    const user = await createUser(ctx.owner);
    const implicit = await createUser(ctx.owner);
    await rate(user.id, article.articleId);
    await rate(implicit.id, article.articleId, null);
    await ingest(input);
    expect(await pending()).toEqual([]);
    await ingest({
      ...input,
      [field]: 'Changed words',
      contentHash: createHash('sha256').update(field).digest('hex'),
    });
    expect(await pending()).toEqual([user.id]);
  },
);

it('adding a carrier wakes only explicit raters of that article subscribed to the new feed', async () => {
  const low = await createFeed(ctx.owner);
  const high = await createFeed(ctx.owner);
  const input = item(high.id);
  const article = await ingest(input);
  const user = await createUser(ctx.owner);
  await rate(user.id, article.articleId);
  await createSubscription(ctx.owner, { userId: user.id, feedId: low.id });
  await createSubscription(ctx.owner, { userId: user.id, feedId: high.id });
  const unsubscribed = await createUser(ctx.owner);
  await rate(unsubscribed.id, article.articleId, -1);
  await createSubscription(ctx.owner, { userId: unsubscribed.id, feedId: high.id });
  const implicit = await createUser(ctx.owner);
  await rate(implicit.id, article.articleId, null);
  await createSubscription(ctx.owner, { userId: implicit.id, feedId: low.id });
  const unrelated = await createUser(ctx.owner);
  const otherArticle = await createArticle(ctx.owner, { feedIds: [low.id] });
  await rate(unrelated.id, otherArticle.id);
  await createSubscription(ctx.owner, { userId: unrelated.id, feedId: low.id });
  await ingest({ ...input, feedId: low.id });
  expect(await pending()).toEqual([user.id]);
  expect((await loadEstimateRatings(ctx.worker, user.id, new Date(0)))[0]?.feedId).toBe(low.id);
});
