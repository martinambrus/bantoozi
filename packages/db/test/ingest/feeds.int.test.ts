import { createArticle, createFeed } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deferFeedFetch,
  dueFeedIds,
  feedItems7d,
  feedRecentPublishedAt,
  loadFeedForFetch,
  recordFeedFetch,
  refreshFeedLangHint,
  resolveLiveFeedId,
  tryLockFeedForFetch,
  FeedFetchLockLostError,
  type FeedScheduleColumns,
} from '../../src/ingest/feeds.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';

/**
 * Feed scheduling and fetch bookkeeping (M1-T7 lane C; spec 03 §3, §7 "After all items", §8.3,
 * §9) against a real migrated database as the worker role.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

async function feedWith(
  columns: Record<string, unknown>,
  options: { status?: string } = {},
): Promise<string> {
  const feed = await createFeed(ctx.owner, options);
  const names = Object.keys(columns);
  if (names.length > 0) {
    const sets = names.map((name, i) => `${name} = $${i + 2}`).join(', ');
    await ctx.owner.query(`UPDATE feeds SET ${sets} WHERE id = $1`, [
      feed.id,
      ...names.map((name) => columns[name]),
    ]);
  }
  return feed.id;
}

/** Retire `feedId` into `survivorId` (a merge tombstone). */
async function retire(feedId: string, survivorId: string): Promise<void> {
  await ctx.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
    feedId,
    survivorId,
  ]);
}

describe('dueFeedIds (spec 03 §3)', () => {
  it('lists subscribed active and quarantined feeds that are due, oldest first, up to the limit', async () => {
    const at = (s: number) => new Date(Date.UTC(2001, 0, 1, 0, 0, s));
    const quarantined = await feedWith(
      { subscriber_count: 1, next_fetch_at: at(1), quarantined_until: at(1) },
      { status: 'quarantined' },
    );
    const second = await feedWith({ subscriber_count: 3, next_fetch_at: at(2) });
    const third = await feedWith({ subscriber_count: 1, next_fetch_at: at(3) });
    const notYet = await feedWith({
      subscriber_count: 1,
      next_fetch_at: new Date(Date.now() + 3_600_000),
    });
    const stillQuarantined = await feedWith(
      {
        subscriber_count: 1,
        next_fetch_at: new Date(Date.now() + 86_400_000),
        quarantined_until: new Date(Date.now() + 86_400_000),
      },
      { status: 'quarantined' },
    );
    const unsubscribed = await feedWith({ subscriber_count: 0, next_fetch_at: at(0) });
    const paused = await feedWith(
      { subscriber_count: 1, next_fetch_at: at(0) },
      { status: 'paused' },
    );
    const dead = await feedWith({ subscriber_count: 1, next_fetch_at: at(0) }, { status: 'dead' });
    const tombstone = await feedWith({ subscriber_count: 1, next_fetch_at: at(0) });
    await retire(tombstone, second);

    const due = await dueFeedIds(ctx.worker);
    expect(due.slice(0, 3)).toEqual([quarantined, second, third]);
    for (const id of [notYet, stillQuarantined, unsubscribed, paused, dead, tombstone]) {
      expect(due).not.toContain(id);
    }
    expect(await dueFeedIds(ctx.worker, 2)).toEqual([quarantined, second]);
  });
});

describe('resolveLiveFeedId (spec 03 §3, §9)', () => {
  it('follows merge pointers to the live root and detects cycles', async () => {
    const a = await feedWith({});
    const b = await feedWith({});
    const c = await feedWith({});
    await retire(a, b);
    await retire(b, c);
    expect(await resolveLiveFeedId(ctx.worker, a)).toBe(c);
    expect(await resolveLiveFeedId(ctx.worker, b)).toBe(c);
    expect(await resolveLiveFeedId(ctx.worker, c)).toBe(c);
    expect(await resolveLiveFeedId(ctx.worker, '999999999')).toBeNull();

    // A corrupt cycle (no CHECK can forbid it across rows) resolves to nothing.
    const x = await feedWith({});
    const y = await feedWith({});
    const intoCycle = await feedWith({});
    await retire(x, y);
    await retire(y, x);
    await retire(intoCycle, x);
    expect(await resolveLiveFeedId(ctx.worker, x)).toBeNull();
    expect(await resolveLiveFeedId(ctx.worker, y)).toBeNull();
    expect(await resolveLiveFeedId(ctx.worker, intoCycle)).toBeNull();
  });
});

describe('tryLockFeedForFetch (spec 03 §3)', () => {
  it('holds a session lock per feed on a dedicated connection until release', async () => {
    const feed = await feedWith({});
    const other = await feedWith({});
    const first = await tryLockFeedForFetch(ctx.workerPool, feed);
    expect(first?.feedId).toBe(feed);
    // Another session (another connection, as in the second worker process) cannot take it.
    expect(await tryLockFeedForFetch(ctx.workerPool, feed)).toBeNull();
    const unrelated = await tryLockFeedForFetch(ctx.workerPool, other);
    expect(unrelated).not.toBeNull();
    await unrelated?.release();
    await first?.release();
    await first?.release();
    const again = await tryLockFeedForFetch(ctx.workerPool, feed);
    expect(again).not.toBeNull();
    await again?.release();
    // The connections went back to the pool.
    expect(ctx.workerPool.totalCount - ctx.workerPool.idleCount).toBe(0);
  });

  it('extends to a survivor feed on the same connection and releases both together', async () => {
    const source = await feedWith({});
    const survivor = await feedWith({});
    const busy = await feedWith({});
    const lock = await tryLockFeedForFetch(ctx.workerPool, source);
    expect(lock).not.toBeNull();
    const inUse = ctx.workerPool.totalCount - ctx.workerPool.idleCount;
    expect(await lock!.tryExtend(survivor)).toBe(true);
    expect(await lock!.tryExtend(survivor)).toBe(true); // already held: no second lock level
    // No second pool connection, and another session cannot take the survivor now.
    expect(ctx.workerPool.totalCount - ctx.workerPool.idleCount).toBe(inUse);
    expect(await tryLockFeedForFetch(ctx.workerPool, survivor)).toBeNull();
    // A feed another session is fetching cannot be taken over.
    const other = await tryLockFeedForFetch(ctx.workerPool, busy);
    expect(await lock!.tryExtend(busy)).toBe(false);
    await other?.release();
    await expect(lock!.tryExtend('not-a-feed-id')).rejects.toThrow(RangeError);

    await lock!.release();
    expect(await lock!.tryExtend(busy)).toBe(false); // released locks never extend
    for (const feed of [source, survivor]) {
      const again = await tryLockFeedForFetch(ctx.workerPool, feed);
      expect(again).not.toBeNull();
      await again?.release();
    }
    expect(ctx.workerPool.totalCount - ctx.workerPool.idleCount).toBe(0);
  });

  it('confirms in PostgreSQL that it holds every key, and fails once released', async () => {
    // Advisory keys are signed hashes: take one feed id of each sign.
    const ids = await ctx.adminPool.query<{ negative: string; positive: string }>(
      `SELECT (SELECT id::text FROM generate_series(1, 1000) AS id
                WHERE hashtextextended('feed.fetch:' || id::text, 0) < 0 LIMIT 1) AS negative,
              (SELECT id::text FROM generate_series(1, 1000) AS id
                WHERE hashtextextended('feed.fetch:' || id::text, 0) > 0 LIMIT 1) AS positive`,
    );
    const { negative, positive } = ids.rows[0]!;
    const lock = await tryLockFeedForFetch(ctx.workerPool, negative);
    expect(lock).not.toBeNull();
    expect(await lock!.tryExtend(positive)).toBe(true);
    await expect(ctx.worker.transaction((tx) => lock!.assertHeld(tx))).resolves.toBeUndefined();
    await expect(lock!.assertHeld()).resolves.toBeUndefined();
    expect(lock!.signal.aborted).toBe(false);
    await lock!.release();
    await expect(lock!.assertHeld()).rejects.toBeInstanceOf(FeedFetchLockLostError);
    await expect(ctx.worker.transaction((tx) => lock!.assertHeld(tx))).rejects.toBeInstanceOf(
      FeedFetchLockLostError,
    );
  });

  it('is released when its connection dies, without crashing the holder', async () => {
    const feed = await feedWith({});
    const applicationName = `feed-lock-test-${process.pid}`;
    const doomed = new pg.Pool({
      connectionString: ctx.testDb.urls.worker,
      max: 1,
      application_name: applicationName,
    });
    doomed.on('error', () => undefined);
    try {
      const lock = await tryLockFeedForFetch(doomed, feed);
      expect(lock).not.toBeNull();
      expect(await tryLockFeedForFetch(ctx.workerPool, feed)).toBeNull();
      const killed = await ctx.adminPool.query<{ ok: boolean }>(
        `SELECT pg_terminate_backend(pid, 5000) AS ok FROM pg_stat_activity
          WHERE application_name = $1`,
        [applicationName],
      );
      expect(killed.rows).toEqual([{ ok: true }]);
      // Nothing may be written for the fetch any more: PostgreSQL itself no longer grants the lock,
      // and the connection failure aborts the lock's signal.
      await expect(ctx.worker.transaction((tx) => lock!.assertHeld(tx))).rejects.toBeInstanceOf(
        FeedFetchLockLostError,
      );
      for (let i = 0; i < 100 && !lock!.signal.aborted; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(lock!.signal.aborted).toBe(true);
      await expect(lock!.assertHeld()).rejects.toBeInstanceOf(FeedFetchLockLostError);
      const after = await tryLockFeedForFetch(ctx.workerPool, feed);
      expect(after).not.toBeNull();
      await after?.release();
      await expect(lock?.release()).resolves.toBeUndefined();
    } finally {
      await doomed.end();
    }
  });
});

const schedule = (overrides: Partial<FeedScheduleColumns> = {}): FeedScheduleColumns => ({
  status: 'quarantined',
  fetchIntervalS: 1_800,
  nextFetchAt: new Date('2026-09-28T10:00:00.000Z'),
  consecutiveErrors: 10,
  consecutiveEmpty: 2,
  quarantineCount: 1,
  quarantinedUntil: new Date('2026-09-28T10:00:00.000Z'),
  totalFetches: 42,
  totalErrors: 11,
  totalEmpty: 5,
  lastFetchAt: new Date('2026-09-26T10:00:00.000Z'),
  lastSuccessAt: new Date('2026-09-20T10:00:00.000Z'),
  lastNewItemAt: new Date('2026-09-19T10:00:00.000Z'),
  firstErrorAt: new Date('2026-09-21T10:00:00.000Z'),
  lastErrorCode: 'FEED_HTTP_ERROR',
  lastError: 'HTTP 500',
  lastErrorAt: new Date('2026-09-26T10:00:00.000Z'),
  etag: 'W/"v2"',
  lastModified: 'Sat, 26 Sep 2026 10:00:00 GMT',
  ...overrides,
});

describe('loadFeedForFetch / recordFeedFetch (spec 03 §7, §9)', () => {
  it('round-trips the schedule, validators, metadata and publish stats', async () => {
    const id = await feedWith({
      subscriber_count: 3,
      min_interval_s: 300,
      unsubscribed_at: null,
      etag: 'W/"v1"',
      last_modified: 'Fri, 25 Sep 2026 10:00:00 GMT',
      description: 'Old description',
      icon_url: 'https://feeds.example.test/icon.png',
      lang_hint: 'en',
      fetch_options: JSON.stringify({ user_agent: 'Bantoozi-Test/1', translate_strong: true }),
      publish_stats: JSON.stringify({ recent_gaps_s: [3600, 7200], items_7d: 4, extra: 1 }),
    });
    const before = await loadFeedForFetch(ctx.worker, id);
    expect(before).toMatchObject({
      id,
      mergedIntoId: null,
      status: 'active',
      subscriberCount: 3,
      minIntervalS: 300,
      fetchIntervalS: 900,
      etag: 'W/"v1"',
      lastModified: 'Fri, 25 Sep 2026 10:00:00 GMT',
      userAgent: 'Bantoozi-Test/1',
      langHint: 'en',
      totalFetches: 0,
      lastFetchAt: null,
      lastErrorCode: null,
      recentGapsS: [3600, 7200],
    });
    expect(before?.url).toBe(before?.fetchUrl);
    expect(before?.createdAt).toBeInstanceOf(Date);
    expect(before?.nextFetchAt).toBeInstanceOf(Date);

    const update = schedule();
    await ctx.worker.transaction((tx) =>
      recordFeedFetch(tx, id, {
        schedule: update,
        meta: {
          title: 'Renamed feed',
          siteUrl: 'https://site.example.test/',
          iconUrl: null,
          langHint: 'sk',
        },
        recentGapsS: [60, 120.4, -5, 0],
        items7d: 9,
      }),
    );
    const after = await loadFeedForFetch(ctx.worker, id);
    expect(after).toMatchObject({
      ...update,
      langHint: 'sk',
      subscriberCount: 3,
      minIntervalS: 300,
      userAgent: 'Bantoozi-Test/1',
      recentGapsS: [60, 120],
    });
    const row = await ctx.owner.query(
      `SELECT title, site_url, description, icon_url, publish_stats, fetch_options,
              unsubscribed_at, subscriber_count, min_interval_s
         FROM feeds WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      title: 'Renamed feed',
      site_url: 'https://site.example.test/',
      description: 'Old description',
      icon_url: null,
      publish_stats: { recent_gaps_s: [60, 120], items_7d: 9, extra: 1 },
      fetch_options: { user_agent: 'Bantoozi-Test/1', translate_strong: true },
      unsubscribed_at: null,
      subscriber_count: 3,
      min_interval_s: 300,
    });

    // Absent stats and metadata keep what is stored; a success keeps the last error.
    await ctx.worker.transaction((tx) =>
      recordFeedFetch(tx, id, {
        schedule: schedule({ status: 'active', etag: null, lastModified: null }),
      }),
    );
    const kept = await ctx.owner.query(
      'SELECT status, title, lang_hint, etag, last_modified, publish_stats FROM feeds WHERE id = $1',
      [id],
    );
    expect(kept.rows[0]).toEqual({
      status: 'active',
      title: 'Renamed feed',
      lang_hint: 'sk',
      etag: null,
      last_modified: null,
      publish_stats: { recent_gaps_s: [60, 120], items_7d: 9, extra: 1 },
    });
  });

  it('ignores a non-string user agent and reports a missing feed as null', async () => {
    const id = await feedWith({ fetch_options: JSON.stringify({ user_agent: 5 }) });
    expect(await loadFeedForFetch(ctx.worker, id)).toMatchObject({
      userAgent: null,
      recentGapsS: [],
    });
    expect(await loadFeedForFetch(ctx.worker, '999999999')).toBeNull();
  });

  it('never revives a merged tombstone, a dead or a paused feed', async () => {
    const survivor = await feedWith({});
    const tombstone = await feedWith({ etag: 'W/"old"', last_modified: 'x' });
    await retire(tombstone, survivor);
    const paused = await feedWith({}, { status: 'paused' });
    const gone = await feedWith({}, { status: 'dead' });
    const dying = await feedWith({});
    await ctx.worker.transaction(async (tx) => {
      const active = schedule({ status: 'active', etag: 'W/"new"', lastModified: 'y' });
      await recordFeedFetch(tx, tombstone, { schedule: active });
      await recordFeedFetch(tx, paused, { schedule: active });
      await recordFeedFetch(tx, gone, { schedule: active });
      await recordFeedFetch(tx, dying, { schedule: schedule({ status: 'dead' }) });
      await recordFeedFetch(tx, '999999999', { schedule: active });
    });
    const rows = await ctx.owner.query(
      `SELECT id::text AS id, status, merged_into_id::text AS merged_into_id, etag, last_modified,
              total_fetches
         FROM feeds WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[tombstone, paused, gone, dying]],
    );
    expect(rows.rows).toEqual([
      {
        id: tombstone,
        status: 'dead',
        merged_into_id: survivor,
        etag: null,
        last_modified: null,
        total_fetches: 42,
      },
      {
        id: paused,
        status: 'paused',
        merged_into_id: null,
        etag: 'W/"new"',
        last_modified: 'y',
        total_fetches: 42,
      },
      {
        id: gone,
        status: 'dead',
        merged_into_id: null,
        etag: 'W/"new"',
        last_modified: 'y',
        total_fetches: 42,
      },
      {
        id: dying,
        status: 'dead',
        merged_into_id: null,
        etag: 'W/"v2"',
        last_modified: 'Sat, 26 Sep 2026 10:00:00 GMT',
        total_fetches: 42,
      },
    ]);
  });
});

describe('feedRecentPublishedAt / feedItems7d (spec 03 §7)', () => {
  it('returns the newest distinct publication instants of the feed, newest first', async () => {
    const feed = await feedWith({});
    const other = await feedWith({});
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    const hour = (h: number) => new Date(base + h * 3_600_000);
    for (let h = 0; h < 25; h += 1) {
      await createArticle(ctx.owner, { feedIds: [feed], publishedAt: hour(h) });
    }
    // The same second as the newest one, an undated item and another feed's newer item.
    await createArticle(ctx.owner, {
      feedIds: [feed],
      publishedAt: new Date(base + 24 * 3_600_000 + 400),
    });
    await createArticle(ctx.owner, { feedIds: [feed], publishedAt: null });
    await createArticle(ctx.owner, { feedIds: [other], publishedAt: hour(100) });

    const dates = await feedRecentPublishedAt(ctx.worker, feed);
    expect(dates).toHaveLength(20);
    expect(dates[0]).toEqual(hour(24));
    expect(dates[19]).toEqual(hour(5));
    expect(await feedRecentPublishedAt(ctx.worker, feed, 3)).toEqual([
      hour(24),
      hour(23),
      hour(22),
    ]);
    expect(await feedRecentPublishedAt(ctx.worker, '999999999')).toEqual([]);
  });

  it('counts the items first seen in the last seven days', async () => {
    const feed = await feedWith({});
    await createArticle(ctx.owner, { feedIds: [feed], firstSeenAt: daysAgo(8) });
    await createArticle(ctx.owner, { feedIds: [feed], firstSeenAt: daysAgo(6) });
    await createArticle(ctx.owner, { feedIds: [feed], firstSeenAt: hoursAgo(1) });
    expect(await feedItems7d(ctx.worker, feed)).toBe(2);
  });

  it('defers the next fetch after a politeness cooldown without counting an error (D-12)', async () => {
    const feed = await feedWith({});
    const until = new Date(Date.now() + 30 * 60_000);
    await ctx.worker.transaction((tx) => deferFeedFetch(tx, feed, until));
    const row = await ctx.owner.query<{ next: Date; errors: number; fetches: number }>(
      'SELECT next_fetch_at AS next, consecutive_errors AS errors, total_fetches AS fetches FROM feeds WHERE id = $1',
      [feed],
    );
    expect(new Date(row.rows[0]!.next).getTime()).toBe(until.getTime());
    expect(row.rows[0]).toMatchObject({ errors: 0, fetches: 0 });
    // Never brings a fetch forward.
    await ctx.worker.transaction((tx) => deferFeedFetch(tx, feed, new Date(Date.now() + 60_000)));
    const again = await ctx.owner.query<{ next: Date }>(
      'SELECT next_fetch_at AS next FROM feeds WHERE id = $1',
      [feed],
    );
    expect(new Date(again.rows[0]!.next).getTime()).toBe(until.getTime());
  });
});

describe('refreshFeedLangHint (spec 03 §8.3)', () => {
  let seedSeq = 0;

  /** Carry one article per entry of `langs` (detected language, or null) on the feed. */
  async function seed(feedId: string, langs: ReadonlyArray<string | null>, firstSeenAt: Date) {
    seedSeq += 1;
    await ctx.owner.query(
      `WITH src AS (
         SELECT l.lang, l.i, 'https://lang.example.test/' || $2 || '/' || l.i AS url
           FROM unnest($3::text[]) WITH ORDINALITY AS l(lang, i)),
       ins AS (
         INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash, lang,
                               first_seen_at)
         SELECT url, url, substr(url, 9), 'T ' || i, 't ' || i, md5(url), lang, $4 FROM src
         RETURNING id)
       INSERT INTO feed_items (feed_id, article_id, first_seen_at) SELECT $1, id, $4 FROM ins`,
      [feedId, `${feedId}-${seedSeq}`, langs, firstSeenAt],
    );
  }

  const times = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

  async function refresh(feedId: string): Promise<{ result: string | null; stored: unknown }> {
    const result = await ctx.worker.transaction((tx) => refreshFeedLangHint(tx, feedId));
    const row = await ctx.owner.query('SELECT lang_hint FROM feeds WHERE id = $1', [feedId]);
    return { result, stored: row.rows[0]?.lang_hint };
  }

  it('waits for 20 detected articles', async () => {
    const feed = await feedWith({});
    await seed(feed, times(19, 'sk'), hoursAgo(1));
    expect(await refresh(feed)).toEqual({ result: null, stored: null });
    await seed(feed, ['sk'], hoursAgo(1));
    expect(await refresh(feed)).toEqual({ result: 'sk', stored: 'sk' });
  });

  it('sets a majority of at least 70 % and leaves a weaker one alone', async () => {
    const seventy = await feedWith({});
    await seed(seventy, [...times(14, 'sk'), ...times(6, 'en')], hoursAgo(1));
    expect(await refresh(seventy)).toEqual({ result: 'sk', stored: 'sk' });

    const sixty = await feedWith({ lang_hint: 'en' });
    await seed(sixty, [...times(12, 'cs'), ...times(8, 'de')], hoursAgo(1));
    expect(await refresh(sixty)).toEqual({ result: 'en', stored: 'en' });
  });

  it('ignores und and undetected articles', async () => {
    const feed = await feedWith({});
    await seed(
      feed,
      [...times(14, 'de'), ...times(6, 'en'), ...times(10, 'und'), ...times(5, null)],
      hoursAgo(1),
    );
    expect(await refresh(feed)).toEqual({ result: 'de', stored: 'de' });
  });

  it('looks at the newest 200 detected articles only', async () => {
    const feed = await feedWith({ lang_hint: 'en' });
    await seed(feed, times(150, 'en'), daysAgo(10));
    await seed(feed, [...times(150, 'fr'), ...times(50, 'en')], hoursAgo(1));
    expect(await refresh(feed)).toEqual({ result: 'fr', stored: 'fr' });
  });
});
