import { createFeed } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureDevUser, subscribeToFeed } from '../../src/ingest/dev-cli.js';
import { workerOutbox } from '../../src/outbox.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * The development CLI's worker-role helpers (M1-T9; spec 03 §10) against a real migrated database:
 * the dev user is created once, and a subscription always lands on a live feed.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

async function subscribe(email: string, url: string) {
  return ctx.worker.transaction(async (tx) => {
    const user = await ensureDevUser(tx, email);
    const sub = await subscribeToFeed(tx, workerOutbox(tx), {
      userId: user.id,
      url,
      fetchUrl: url,
      title: null,
    });
    return { user, ...sub };
  });
}

async function subscriptionFeeds(userId: string): Promise<string[]> {
  const result = await ctx.owner.query<{ feed_id: string }>(
    'SELECT feed_id::text AS feed_id FROM subscriptions WHERE user_id = $1 ORDER BY feed_id',
    [userId],
  );
  return result.rows.map((row) => row.feed_id);
}

describe('ensureDevUser and subscribeToFeed (M1-T9)', () => {
  it('creates the user and the feed once, and records a fetch each time', async () => {
    const url = 'https://dev-cli.example.test/feed.xml';
    const first = await subscribe('first@localhost', url);
    expect(first).toMatchObject({ createdFeed: true, createdSubscription: true });
    expect(first.user.created).toBe(true);
    const again = await subscribe('first@localhost', url);
    expect(again).toMatchObject({
      feedId: first.feedId,
      createdFeed: false,
      createdSubscription: false,
    });
    expect(again.user).toEqual({ id: first.user.id, created: false });
    const counts = await ctx.owner.query<{ subscriber_count: number }>(
      'SELECT subscriber_count FROM feeds WHERE id = $1',
      [first.feedId],
    );
    expect(counts.rows).toEqual([{ subscriber_count: 1 }]);
    const fetches = await ctx.owner.query(
      `SELECT 1 FROM job_outbox WHERE queue = 'feed.fetch' AND payload->>'feedId' = $1`,
      [first.feedId],
    );
    expect(fetches.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('subscribes to the live root of a feed merged more than once', async () => {
    const a = await createFeed(ctx.owner, { url: 'https://dev-cli.example.test/a.xml' });
    const b = await createFeed(ctx.owner, { url: 'https://dev-cli.example.test/b.xml' });
    const c = await createFeed(ctx.owner, { url: 'https://dev-cli.example.test/c.xml' });
    await ctx.owner.query(
      `UPDATE feeds SET status = 'dead', merged_into_id = CASE id WHEN $1 THEN $2 ELSE $3 END
        WHERE id IN ($1, $2)`,
      [a.id, b.id, c.id],
    );

    const sub = await subscribe('chain@localhost', a.url);
    expect(sub).toMatchObject({ feedId: c.id, createdFeed: false, createdSubscription: true });
    expect(await subscriptionFeeds(sub.user.id)).toEqual([c.id]);
  });

  it('waits for a running merge of the resolved feed and subscribes to its survivor', async () => {
    const source = await createFeed(ctx.owner, { url: 'https://dev-cli.example.test/racing.xml' });
    const survivor = await createFeed(ctx.owner, {
      url: 'https://dev-cli.example.test/survivor.xml',
    });
    const merging = await ctx.owner.connect();
    try {
      // A merge holds the source row as mergeFeeds does, then retires it.
      await merging.query('BEGIN');
      await merging.query('SELECT 1 FROM feeds WHERE id = $1 FOR NO KEY UPDATE', [source.id]);
      const pending = subscribe('racer@localhost', source.url);
      await untilLockWait();
      await merging.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
        source.id,
        survivor.id,
      ]);
      await merging.query('COMMIT');

      const sub = await pending;
      expect(sub).toMatchObject({
        feedId: survivor.id,
        createdFeed: false,
        createdSubscription: true,
      });
      expect(await subscriptionFeeds(sub.user.id)).toEqual([survivor.id]);
    } finally {
      await merging.query('ROLLBACK').catch(() => undefined);
      merging.release();
    }
  });
});

/** Resolve once some session of this database waits for a lock (fails after ~5 s). */
async function untilLockWait(): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    const waiting = await ctx.adminPool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no session started waiting for a lock');
}
