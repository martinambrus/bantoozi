import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSessionDatabase } from '../src/client.js';
import { loadEstimateRatings } from '../src/rank/context.js';
import { Scenario } from './learn/fixtures.js';
import { setupDbTest, withConnection, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const DAY = 24 * 3600 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const byNumericId = (a: string, b: string): number => Number(BigInt(a) - BigInt(b));

async function rate(
  userId: string,
  articleId: string,
  rating: 1 | -1 | null,
  ratedAt: Date | null,
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
    [userId, articleId, rating, ratedAt],
  );
}

const load = (userId: string, since: Date = new Date(0)) =>
  loadEstimateRatings(ctx.worker, userId, since);

describe('loadEstimateRatings', () => {
  it('(a) returns explicit ratings with title, excerpt, rating and time; not unrated or bookmarked articles', async () => {
    const s = await Scenario.create(ctx);
    const feedIds = [s.feedId];
    const liked = await createArticle(ctx.owner, {
      feedIds,
      title: 'Liked one',
      excerpt: 'Liked excerpt',
    });
    const disliked = await createArticle(ctx.owner, {
      feedIds,
      title: 'Disliked one',
      excerpt: null,
    });
    const plain = await createArticle(ctx.owner, { feedIds });
    const marked = await createArticle(ctx.owner, { feedIds });
    const at1 = ago(3 * DAY);
    const at2 = ago(2 * DAY);
    await rate(s.userId, liked.id, 1, at1);
    await rate(s.userId, disliked.id, -1, at2);
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status)
       VALUES ($1, $2, now(), 'pending')`,
      [s.userId, marked.id],
    );
    expect(plain.id).not.toBe(marked.id);
    expect(await load(s.userId)).toEqual([
      {
        articleId: liked.id,
        rating: 1,
        ratedAt: at1,
        title: 'Liked one',
        excerpt: 'Liked excerpt',
        feedId: s.feedId,
      },
      {
        articleId: disliked.id,
        rating: -1,
        ratedAt: at2,
        title: 'Disliked one',
        excerpt: null,
        feedId: s.feedId,
      },
    ]);
  });

  it('(b) since is inclusive and excludes older ratings', async () => {
    const s = await Scenario.create(ctx);
    const old = await s.article();
    const edge = await s.article();
    const fresh = await s.article();
    const since = new Date(Date.now() - 5 * DAY);
    await rate(s.userId, old, 1, new Date(since.getTime() - 1000));
    await rate(s.userId, edge, -1, since);
    await rate(s.userId, fresh, 1, ago(DAY));
    expect((await load(s.userId, since)).map((r) => r.articleId)).toEqual([edge, fresh]);
  });

  it('(c) carrier feed is the lowest-id subscribed carrier, null with no subscribed carrier', async () => {
    const s = await Scenario.create(ctx);
    const created = [await createFeed(ctx.owner), await createFeed(ctx.owner)];
    const [low, high] = created.map((f) => f.id).sort(byNumericId) as [string, string];
    const article = await createArticle(ctx.owner, { feedIds: [high, low] });
    await rate(s.userId, article.id, 1, ago(DAY));
    await ctx.owner.query(`DELETE FROM subscriptions WHERE user_id = $1`, [s.userId]);
    expect((await load(s.userId))[0]?.feedId).toBeNull();

    await createSubscription(ctx.owner, { userId: s.userId, feedId: high, mode: 'active' });
    expect((await load(s.userId))[0]?.feedId).toBe(high);

    await createSubscription(ctx.owner, { userId: s.userId, feedId: low, mode: 'training' });
    expect((await load(s.userId))[0]?.feedId).toBe(low);

    await ctx.owner.query(`DELETE FROM subscriptions WHERE user_id = $1`, [s.userId]);
    expect((await load(s.userId))[0]?.feedId).toBeNull();
  });

  it('(d) another user never appears', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    const x = await a.article();
    const y = await b.article();
    await rate(a.userId, x, 1, ago(DAY));
    await rate(b.userId, y, -1, ago(DAY));
    expect((await load(a.userId)).map((r) => r.articleId)).toEqual([x]);
    expect((await load(b.userId)).map((r) => r.articleId)).toEqual([y]);
  });

  it('(e) orders by rated_at, then by numeric article id', async () => {
    const s = await Scenario.create(ctx);
    await ctx.owner.query(
      `SELECT setval(pg_get_serial_sequence('articles', 'id'), greatest(nextval(pg_get_serial_sequence('articles', 'id')), 95))`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await s.article());
    const tie = ago(2 * DAY);
    for (const id of [...ids].reverse()) await rate(s.userId, id, 1, tie);
    const earlier = await s.article();
    await rate(s.userId, earlier, -1, ago(3 * DAY));
    const later = await s.article();
    await rate(s.userId, later, 1, ago(DAY));
    const numeric = [...ids].sort(byNumericId);
    expect(numeric).not.toEqual([...ids].sort());
    expect((await load(s.userId)).map((r) => r.articleId)).toEqual([earlier, ...numeric, later]);
  });

  it('(f) an un-rated article disappears and a re-rated one shows its current rating', async () => {
    const s = await Scenario.create(ctx);
    const keep = await s.article();
    const drop = await s.article();
    await rate(s.userId, keep, 1, ago(2 * DAY));
    await rate(s.userId, drop, -1, ago(DAY));
    expect(await load(s.userId)).toHaveLength(2);
    await rate(s.userId, drop, null, null);
    expect((await load(s.userId)).map((r) => r.articleId)).toEqual([keep]);
    const rerated = ago(DAY / 2);
    await rate(s.userId, keep, -1, rerated);
    const rows = await load(s.userId);
    expect(rows.map((r) => [r.rating, r.ratedAt])).toEqual([[-1, rerated]]);
  });

  it('(g) runs in a read-only transaction, in which a write is refused', async () => {
    const s = await Scenario.create(ctx);
    const article = await s.article();
    await rate(s.userId, article, 1, ago(DAY));
    await withConnection(ctx.workerPool, async (client) => {
      const db = createSessionDatabase(client);
      await client.query('BEGIN READ ONLY');
      try {
        const rows = await loadEstimateRatings(db, s.userId, new Date(0));
        expect(rows.map((r) => r.articleId)).toEqual([article]);
        await expect(
          client.query(`UPDATE users SET last_active_at = now() WHERE id = $1`, [s.userId]),
        ).rejects.toThrow(/read-only/i);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
