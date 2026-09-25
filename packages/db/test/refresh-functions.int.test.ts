import { planMinIntervalMap } from '@bantoozi/shared';
import {
  createCard,
  createFeed,
  createSubscription,
  createUser,
  type Queryable,
} from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/tenant.js';
import { asTenant, setupDbTest, withConnection, type DbTestContext } from './support/test-db.js';

/**
 * refresh_feed_cards / refresh_feed_subscribers (spec 02 §6 "Tests"): correct rows when called as
 * bantoozi_app inside withTenant(A) with A and B subscribed, and as bantoozi_worker without a
 * tenant; never dropping B's rows; and two-connection concurrent mutations leave both caches equal
 * to a fresh aggregation of the source tables.
 */

const PLAN_MAP = JSON.stringify(planMinIntervalMap());

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

/** feed_cards as `card:holders` strings, for readable comparisons. */
async function feedCards(feedId: string): Promise<string[]> {
  const result = await ctx.owner.query<{ card_id: string; holders: number }>(
    'SELECT card_id::text AS card_id, holders FROM feed_cards WHERE feed_id = $1 ORDER BY card_id',
    [feedId],
  );
  return result.rows.map((r) => `${r.card_id}:${r.holders}`);
}

async function feedCounters(feedId: string) {
  const result = await ctx.owner.query<{ subscriber_count: number; min_interval_s: number }>(
    'SELECT subscriber_count, min_interval_s FROM feeds WHERE id = $1',
    [feedId],
  );
  return result.rows[0];
}

/** The caches recomputed from the source tables, for comparison with the materialized ones. */
async function freshAggregation(feedIds: readonly string[]) {
  const cards = await ctx.owner.query<{ feed_id: string; card_id: string; holders: number }>(
    `SELECT s.feed_id::text AS feed_id, x.card_id::text AS card_id, count(DISTINCT s.user_id)::int AS holders
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
       JOIN (SELECT user_id, card_id, scope_feed_id FROM user_cards
             UNION ALL SELECT user_id, card_id, NULL FROM user_labels) x
         ON x.user_id = s.user_id AND (x.scope_feed_id IS NULL OR x.scope_feed_id = s.feed_id)
       JOIN interest_cards c ON c.id = x.card_id AND c.retired_at IS NULL
      WHERE s.feed_id = ANY($1::bigint[]) AND s.inference_mode = 'active'
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [feedIds],
  );
  const counters = await ctx.owner.query<{ id: string; subscriber_count: number }>(
    `SELECT f.id::text AS id, (SELECT count(*)::int FROM subscriptions s JOIN users u ON u.id = s.user_id
                                  AND u.deleted_at IS NULL WHERE s.feed_id = f.id) AS subscriber_count
       FROM feeds f WHERE f.id = ANY($1::bigint[]) ORDER BY 1`,
    [feedIds],
  );
  return { cards: cards.rows, counters: counters.rows };
}

async function materialized(feedIds: readonly string[]) {
  const cards = await ctx.owner.query<{ feed_id: string; card_id: string; holders: number }>(
    `SELECT feed_id::text AS feed_id, card_id::text AS card_id, holders FROM feed_cards
      WHERE feed_id = ANY($1::bigint[]) ORDER BY 1, 2`,
    [feedIds],
  );
  const counters = await ctx.owner.query<{ id: string; subscriber_count: number }>(
    'SELECT id::text AS id, subscriber_count FROM feeds WHERE id = ANY($1::bigint[]) ORDER BY 1',
    [feedIds],
  );
  return { cards: cards.rows, counters: counters.rows };
}

async function refreshAsWorker(feedIds: readonly string[]): Promise<void> {
  await ctx.workerPool.query('SELECT refresh_feed_cards($1::bigint[])', [feedIds]);
  await ctx.workerPool.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
    feedIds,
    PLAN_MAP,
  ]);
}

/** Two subscribers of one feed with different cards (and a shared label held by both). */
async function twoSubscribers(db: Queryable) {
  const a = await createUser(db);
  const b = await createUser(db, { plan: 'admin' });
  const feed = await createFeed(db);
  await createSubscription(db, { userId: a.id, feedId: feed.id, mode: 'active' });
  await createSubscription(db, { userId: b.id, feedId: feed.id, mode: 'active' });
  const cardA = await createCard(db, { creatorUserId: a.id });
  const cardB = await createCard(db, { creatorUserId: b.id });
  const label = await createCard(db, { kind: 'label', creatorUserId: a.id });
  await db.query(
    'INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, $3), ($4, $5, $3)',
    [a.id, cardA.id, 'love', b.id, cardB.id],
  );
  await db.query(
    'INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $3, $4), ($2, $3, $4)',
    [a.id, b.id, label.id, 'Saved'],
  );
  return { a, b, feed, cardA, cardB, label };
}

describe('refresh functions in both calling contexts', () => {
  it('as the API inside withTenant(A): computes every subscriber, including B', async () => {
    const { a, feed, cardA, cardB, label } = await twoSubscribers(ctx.owner);
    await withTenant(ctx.app, a.id, async (tx) => {
      await tx.execute(sql`SELECT refresh_feed_cards(${sql.param([feed.id])}::bigint[])`);
      await tx.execute(
        sql`SELECT refresh_feed_subscribers(${sql.param([feed.id])}::bigint[], ${PLAN_MAP}::jsonb)`,
      );
    });
    expect(await feedCards(feed.id)).toEqual(
      [`${cardA.id}:1`, `${cardB.id}:1`, `${label.id}:2`].sort(),
    );
    // B's plan is admin (300 s): the feed polls at the fastest subscriber's plan interval.
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 2, min_interval_s: 300 });
  });

  it('as the worker without app.user_id: the same rows', async () => {
    const { feed, cardA, cardB, label } = await twoSubscribers(ctx.owner);
    await refreshAsWorker([feed.id]);
    expect(await feedCards(feed.id)).toEqual(
      [`${cardA.id}:1`, `${cardB.id}:1`, `${label.id}:2`].sort(),
    );
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 2, min_interval_s: 300 });
  });

  it("never drops B's rows when A unsubscribes and refreshes in A's tenant transaction", async () => {
    const { a, feed, cardB, label } = await twoSubscribers(ctx.owner);
    await refreshAsWorker([feed.id]);
    await withTenant(ctx.app, a.id, async (tx) => {
      await tx.execute(sql`DELETE FROM subscriptions WHERE feed_id = ${feed.id}`);
      await tx.execute(sql`SELECT refresh_feed_cards(${sql.param([feed.id])}::bigint[])`);
      await tx.execute(
        sql`SELECT refresh_feed_subscribers(${sql.param([feed.id])}::bigint[], ${PLAN_MAP}::jsonb)`,
      );
    });
    expect(await feedCards(feed.id)).toEqual([`${cardB.id}:1`, `${label.id}:1`].sort());
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 1, min_interval_s: 300 });
    // A's delete was tenant-scoped: B's subscription is untouched.
    const remaining = await ctx.owner.query('SELECT 1 FROM subscriptions WHERE feed_id = $1', [
      feed.id,
    ]);
    expect(remaining.rowCount).toBe(1);
  });

  it('respects scope, inactive subscriptions, retired cards and soft-deleted users', async () => {
    const { a, b, feed, cardA, cardB, label } = await twoSubscribers(ctx.owner);
    const other = await createFeed(ctx.owner);
    await createSubscription(ctx.owner, { userId: a.id, feedId: other.id, mode: 'active' });
    const scoped = await createCard(ctx.owner, { creatorUserId: a.id });
    await ctx.owner.query(
      'INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $2, $3, $4)',
      [a.id, scoped.id, 'like', other.id],
    );
    const training = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: training.id, feedId: feed.id, mode: 'training' });
    await ctx.owner.query(
      'INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, $3)',
      [training.id, cardA.id, 'like'],
    );
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [cardB.id]);
    await refreshAsWorker([feed.id, other.id]);
    // The training subscriber holds cardA but adds no demand; B's retired card is excluded.
    expect(await feedCards(feed.id)).toEqual([`${cardA.id}:1`, `${label.id}:2`].sort());
    expect(await feedCards(other.id)).toEqual(
      [`${cardA.id}:1`, `${scoped.id}:1`, `${label.id}:1`].sort(),
    );
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 3, min_interval_s: 300 });

    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [b.id]);
    await refreshAsWorker([feed.id]);
    expect(await feedCards(feed.id)).toEqual([`${cardA.id}:1`, `${label.id}:1`].sort());
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 2, min_interval_s: 900 });
  });

  it('marks a feed unsubscribed when its last subscriber leaves', async () => {
    const user = await createUser(ctx.owner);
    const feed = await createFeed(ctx.owner);
    await createSubscription(ctx.owner, { userId: user.id, feedId: feed.id });
    await refreshAsWorker([feed.id]);
    const subscribed = await ctx.owner.query<{ unsubscribed_at: Date | null }>(
      'SELECT unsubscribed_at FROM feeds WHERE id = $1',
      [feed.id],
    );
    expect(subscribed.rows[0]?.unsubscribed_at).toBeNull();
    await ctx.owner.query('DELETE FROM subscriptions WHERE feed_id = $1', [feed.id]);
    await refreshAsWorker([feed.id]);
    const after = await ctx.owner.query<{ subscriber_count: number; unsubscribed_at: Date | null }>(
      'SELECT subscriber_count, unsubscribed_at FROM feeds WHERE id = $1',
      [feed.id],
    );
    expect(after.rows[0]?.subscriber_count).toBe(0);
    expect(after.rows[0]?.unsubscribed_at).toBeInstanceOf(Date);
  });
});

describe('concurrent mutations (two connections)', () => {
  /**
   * One API mutation as spec 02 §6 "Callers" prescribes: READ COMMITTED, lock the user row, then the
   * affected feed rows in numeric order, mutate, refresh both caches for every affected feed, commit.
   */
  async function mutation(
    userId: string,
    feedIds: readonly string[],
    change: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    await asTenant(ctx.appPool, userId, async (client) => {
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
      await client.query(
        'SELECT id FROM feeds WHERE id = ANY($1::bigint[]) ORDER BY id FOR NO KEY UPDATE',
        [feedIds],
      );
      await change(client);
      // Widen the race window between the change and the refresh.
      await client.query('SELECT pg_sleep(0.02)');
      await client.query('SELECT refresh_feed_cards($1::bigint[])', [feedIds]);
      await client.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
        feedIds,
        PLAN_MAP,
      ]);
    });
  }

  it('concurrent subscribe/unsubscribe keeps both users in the caches', async () => {
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    const feed = await createFeed(ctx.owner);
    const cardA = await createCard(ctx.owner, { creatorUserId: a.id });
    const cardB = await createCard(ctx.owner, { creatorUserId: b.id });
    // Subscriptions are created off by the API; activation is a separate mode change (spec 02 §3.4).
    const subscribe = (userId: string, cardId: string) =>
      mutation(userId, [feed.id], async (client) => {
        await client.query('INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $2)', [
          userId,
          feed.id,
        ]);
        await client.query(
          `UPDATE subscriptions SET inference_mode = 'active', inference_version = inference_version + 1,
                  inference_activated_at = now() WHERE user_id = $1 AND feed_id = $2`,
          [userId, feed.id],
        );
        await client.query(
          'INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, $3)',
          [userId, cardId, 'like'],
        );
      });
    const unsubscribe = (userId: string) =>
      mutation(userId, [feed.id], async (client) => {
        await client.query('DELETE FROM user_cards WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2', [
          userId,
          feed.id,
        ]);
      });

    for (let round = 0; round < 5; round += 1) {
      await Promise.all([subscribe(a.id, cardA.id), subscribe(b.id, cardB.id)]);
      expect(await materialized([feed.id])).toEqual(await freshAggregation([feed.id]));
      expect(await feedCards(feed.id)).toEqual([`${cardA.id}:1`, `${cardB.id}:1`].sort());
      await Promise.all([unsubscribe(a.id), subscribe(a.id, cardA.id).catch(() => undefined)]);
      expect(await materialized([feed.id])).toEqual(await freshAggregation([feed.id]));
      await Promise.all([unsubscribe(a.id), unsubscribe(b.id)]);
      expect(await materialized([feed.id])).toEqual(await freshAggregation([feed.id]));
      expect(await feedCards(feed.id)).toEqual([]);
    }
  });

  it('concurrent scope changes and label edits match a fresh aggregation', async () => {
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    const f1 = await createFeed(ctx.owner);
    const f2 = await createFeed(ctx.owner);
    const feeds = [f1.id, f2.id].sort((x, y) => Number(BigInt(x) - BigInt(y)));
    for (const user of [a, b]) {
      for (const feedId of feeds)
        await createSubscription(ctx.owner, { userId: user.id, feedId, mode: 'active' });
    }
    const shared = await createCard(ctx.owner, { creatorUserId: a.id });
    const label = await createCard(ctx.owner, { kind: 'label', creatorUserId: b.id });
    await ctx.owner.query(
      'INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id) VALUES ($1, $3, $4, $5), ($2, $3, $4, $5)',
      [a.id, b.id, shared.id, 'love', f1.id],
    );
    await refreshAsWorker(feeds);

    const rescope = (userId: string, scope: string | null) =>
      mutation(userId, feeds, async (client) => {
        await client.query(
          'UPDATE user_cards SET scope_feed_id = $3 WHERE user_id = $1 AND card_id = $2',
          [userId, shared.id, scope],
        );
      });
    const toggleLabel = (userId: string) =>
      mutation(userId, feeds, async (client) => {
        const removed = await client.query(
          'DELETE FROM user_labels WHERE user_id = $1 AND card_id = $2',
          [userId, label.id],
        );
        if (removed.rowCount === 0) {
          await client.query(
            'INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)',
            [userId, label.id, 'Later'],
          );
        }
      });

    const scopes = [f2.id, null, f1.id, f2.id, null];
    for (const [i, scope] of scopes.entries()) {
      await Promise.all([
        rescope(a.id, scope),
        rescope(b.id, scopes[(i + 2) % scopes.length] ?? null),
        toggleLabel(a.id),
        toggleLabel(b.id),
      ]);
      expect(await materialized(feeds)).toEqual(await freshAggregation(feeds));
    }
    // A worker reconcile running alongside API mutations converges to the same state.
    await Promise.all([rescope(a.id, f1.id), refreshAsWorker(feeds), toggleLabel(b.id)]);
    expect(await materialized(feeds)).toEqual(await freshAggregation(feeds));
  });

  it('holds the feed locks until commit, so a concurrent refresh sees committed subscribers', async () => {
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    const feed = await createFeed(ctx.owner);
    const cardA = await createCard(ctx.owner, { creatorUserId: a.id });
    await createSubscription(ctx.owner, { userId: a.id, feedId: feed.id, mode: 'active' });
    await ctx.owner.query(
      'INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, $3)',
      [a.id, cardA.id, 'must'],
    );
    await withConnection(ctx.workerPool, async (holder) => {
      await holder.query('BEGIN');
      // The worker adds B's active subscription and refreshes, but has not committed yet.
      await holder.query(
        `INSERT INTO subscriptions (user_id, feed_id, inference_mode, inference_version, inference_activated_at)
         VALUES ($1, $2, 'active', 1, now())`,
        [b.id, feed.id],
      );
      await holder.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
        [feed.id],
        PLAN_MAP,
      ]);
      const waiting = asTenant(ctx.appPool, a.id, async (client) => {
        await client.query('SELECT refresh_feed_subscribers($1::bigint[], $2::jsonb)', [
          [feed.id],
          PLAN_MAP,
        ]);
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('COMMIT');
      await waiting;
    });
    expect(await feedCounters(feed.id)).toEqual({ subscriber_count: 2, min_interval_s: 900 });
  });
});
