import { sql, type SQL } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';

import type { Executor, Transaction } from '../client.js';

/**
 * Feed scheduling and fetch bookkeeping (spec 03 §3, §7 "After all items", §8.3, §9). The worker's
 * `feed.schedule` handler lists due feeds; `feed.fetch` resolves a merged feed to its survivor,
 * takes the per-feed session lock on a dedicated connection, re-reads the row, and records the
 * outcome computed by `nextSchedule` (packages/feeds) in the "after all items" transaction.
 */

/** `feeds.status` (spec 02 `feeds`). */
type FeedStatus = 'active' | 'quarantined' | 'dead' | 'paused';

/** At most this many feeds are listed per `feed.schedule` run (spec 03 §3). */
export const FEED_SCHEDULE_BATCH = 300;

/** `publish_stats.recent_gaps_s` is computed from the newest ≤ 20 publication instants (spec 03 §7). */
export const RECENT_PUBLICATIONS = 20;

/**
 * `feeds.lang_hint` upkeep (spec 03 §8.3): at least 20 detected articles among the feed's newest
 * 200, and a majority language covering ≥ 70 % of them.
 */
export const LANG_HINT_MIN_ARTICLES = 20;
export const LANG_HINT_WINDOW = 200;
export const LANG_HINT_MAJORITY_PERCENT = 70;

/**
 * Due feeds (spec 03 §3): subscribed (`subscriber_count > 0`), `active` or `quarantined`, and
 * `next_fetch_at <= now()`, oldest due first, at most `limit` (default 300). `paused` and `dead`
 * feeds, merged tombstones included, are never listed; a quarantined feed becomes due at
 * `quarantined_until` because the fetch handler stores that as its `next_fetch_at`. Ties are broken
 * by id so the batch is deterministic.
 */
export async function dueFeedIds(
  db: Executor,
  limit: number = FEED_SCHEDULE_BATCH,
): Promise<string[]> {
  const batch = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : FEED_SCHEDULE_BATCH));
  const result = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM feeds
     WHERE subscriber_count > 0
       AND status IN ('active', 'quarantined')
       AND next_fetch_at <= now()
     ORDER BY next_fetch_at, id
     LIMIT ${batch}`);
  return result.rows.map((row) => row.id);
}

/**
 * The live root of a feed identity (spec 03 §3, §9; spec 02 §3.3): follows `merged_into_id` until a
 * feed that is not merged, so a job or redirect naming a retired feed reaches its survivor. A live
 * feed resolves to itself. A missing feed, or a corrupt pointer cycle, gives `null`.
 */
export async function resolveLiveFeedId(db: Executor, feedId: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE chain (id, merged_into_id, path) AS (
      SELECT f.id, f.merged_into_id, ARRAY[f.id]
        FROM feeds f WHERE f.id = ${feedId}::bigint
      UNION ALL
      SELECT f.id, f.merged_into_id, c.path || f.id
        FROM chain c JOIN feeds f ON f.id = c.merged_into_id
       WHERE NOT f.id = ANY(c.path)
    )
    SELECT id::text AS id FROM chain WHERE merged_into_id IS NULL LIMIT 1`);
  return result.rows[0]?.id ?? null;
}

/** A held per-feed fetch lock (spec 03 §3). */
export interface FeedFetchLock {
  readonly feedId: string;
  /**
   * Unlock and return the dedicated connection to the pool; call it in `finally`. Idempotent and
   * never throws: when the connection was lost (which already released the session lock), the
   * connection is destroyed instead of being reused.
   */
  release(): Promise<void>;
}

/**
 * The session advisory lock key of a feed's fetch (parameter `$1` = feed id): a 64-bit hash of a
 * namespaced text, so it cannot meet the other advisory lock users' keys by accident.
 */
const FETCH_LOCK_KEY = `hashtextextended('feed.fetch:' || ($1::bigint)::text, 0)`;

/**
 * The per-feed fetch lock (spec 03 §3): a **session** advisory lock keyed by the feed id, taken on
 * a dedicated pool connection that is held for the whole fetch. It is required across both worker
 * processes; queue singleton keys alone are not a business lock. Non-blocking: `null` when another
 * session holds it (the caller skips this job). Re-read the feed (`loadFeedForFetch`) after
 * acquiring it; a stale scheduled job is a no-op. Release it in `finally`; losing the connection
 * also releases it, and a connection error while it is held is recorded instead of crashing the
 * process.
 */
export async function tryLockFeedForFetch(
  pool: Pool,
  feedId: string,
): Promise<FeedFetchLock | null> {
  if (!/^[0-9]{1,19}$/.test(feedId)) throw new RangeError(`invalid feed id: ${feedId}`);
  const client: PoolClient = await pool.connect();
  let broken: Error | undefined;
  const onError = (error: Error): void => {
    broken = error;
  };
  // A checked-out client has no pool error listener: without this, a dropped connection would
  // surface as an unhandled 'error' event.
  client.on('error', onError);
  const giveBack = (): void => {
    client.removeListener('error', onError);
    // Releasing with an error destroys the connection (and with it any session lock).
    client.release(broken);
  };
  let locked: boolean;
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${FETCH_LOCK_KEY}) AS locked`,
      [feedId],
    );
    locked = result.rows[0]?.locked === true;
  } catch (error) {
    broken ??= error instanceof Error ? error : new Error(String(error));
    giveBack();
    throw error;
  }
  if (!locked) {
    giveBack();
    return null;
  }
  let released = false;
  return {
    feedId,
    async release() {
      if (released) return;
      released = true;
      if (broken === undefined) {
        try {
          await client.query(`SELECT pg_advisory_unlock(${FETCH_LOCK_KEY})`, [feedId]);
        } catch (error) {
          broken = error instanceof Error ? error : new Error(String(error));
        }
      }
      giveBack();
    },
  };
}

/** The feed row as `feed.fetch` needs it (spec 03 §3–§9); a superset of `nextSchedule`'s input. */
export interface FeedForFetch {
  id: string;
  /** Canonical identity (spec 03 §5). */
  url: string;
  /** What `feed.fetch` requests (tracking parameters kept, spec 03 §5). */
  fetchUrl: string;
  mergedIntoId: string | null;
  status: FeedStatus;
  subscriberCount: number;
  nextFetchAt: Date;
  etag: string | null;
  lastModified: string | null;
  /** `fetch_options.user_agent` (admin override), when it is a string. */
  userAgent: string | null;
  langHint: string | null;
  createdAt: Date;
  fetchIntervalS: number;
  minIntervalS: number;
  consecutiveErrors: number;
  consecutiveEmpty: number;
  quarantineCount: number;
  totalFetches: number;
  totalErrors: number;
  totalEmpty: number;
  lastNewItemAt: Date | null;
  firstErrorAt: Date | null;
  quarantinedUntil: Date | null;
  lastSuccessAt: Date | null;
  lastFetchAt: Date | null;
  /** The last error, which a success keeps (spec 08 `FeedInfo`; `nextSchedule` carries it over). */
  lastErrorCode: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** `publish_stats.recent_gaps_s` as stored (finite numbers only), `[]` when absent. */
  recentGapsS: number[];
}

type Timestamp = Date | string;

const toDate = (value: Timestamp): Date => (value instanceof Date ? value : new Date(value));
const toDateOrNull = (value: Timestamp | null): Date | null =>
  value === null ? null : toDate(value);
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The feed row, or `null` when it does not exist. It does not follow `merged_into_id`. */
export async function loadFeedForFetch(db: Executor, feedId: string): Promise<FeedForFetch | null> {
  const result = await db.execute<{
    id: string;
    url: string;
    fetch_url: string;
    merged_into_id: string | null;
    status: FeedStatus;
    subscriber_count: number;
    next_fetch_at: Timestamp;
    etag: string | null;
    last_modified: string | null;
    user_agent: string | null;
    lang_hint: string | null;
    created_at: Timestamp;
    fetch_interval_s: number;
    min_interval_s: number;
    consecutive_errors: number;
    consecutive_empty: number;
    quarantine_count: number;
    total_fetches: number;
    total_errors: number;
    total_empty: number;
    last_new_item_at: Timestamp | null;
    first_error_at: Timestamp | null;
    quarantined_until: Timestamp | null;
    last_success_at: Timestamp | null;
    last_fetch_at: Timestamp | null;
    last_error_code: string | null;
    last_error: string | null;
    last_error_at: Timestamp | null;
    recent_gaps_s: unknown;
  }>(sql`
    SELECT id::text AS id, url, fetch_url, merged_into_id::text AS merged_into_id, status,
           subscriber_count, next_fetch_at, etag, last_modified,
           CASE WHEN jsonb_typeof(fetch_options -> 'user_agent') = 'string'
                THEN fetch_options ->> 'user_agent' END AS user_agent,
           lang_hint, created_at, fetch_interval_s, min_interval_s, consecutive_errors,
           consecutive_empty, quarantine_count, total_fetches, total_errors, total_empty,
           last_new_item_at, first_error_at, quarantined_until, last_success_at, last_fetch_at,
           last_error_code, last_error, last_error_at,
           publish_stats -> 'recent_gaps_s' AS recent_gaps_s
      FROM feeds WHERE id = ${feedId}::bigint`);
  const row = result.rows[0];
  if (row === undefined) return null;
  const gaps = Array.isArray(row.recent_gaps_s) ? (row.recent_gaps_s as unknown[]) : [];
  return {
    id: row.id,
    url: row.url,
    fetchUrl: row.fetch_url,
    mergedIntoId: row.merged_into_id,
    status: row.status,
    subscriberCount: row.subscriber_count,
    nextFetchAt: toDate(row.next_fetch_at),
    etag: row.etag,
    lastModified: row.last_modified,
    userAgent: row.user_agent,
    langHint: row.lang_hint,
    createdAt: toDate(row.created_at),
    fetchIntervalS: row.fetch_interval_s,
    minIntervalS: row.min_interval_s,
    consecutiveErrors: row.consecutive_errors,
    consecutiveEmpty: row.consecutive_empty,
    quarantineCount: row.quarantine_count,
    totalFetches: row.total_fetches,
    totalErrors: row.total_errors,
    totalEmpty: row.total_empty,
    lastNewItemAt: toDateOrNull(row.last_new_item_at),
    firstErrorAt: toDateOrNull(row.first_error_at),
    quarantinedUntil: toDateOrNull(row.quarantined_until),
    lastSuccessAt: toDateOrNull(row.last_success_at),
    lastFetchAt: toDateOrNull(row.last_fetch_at),
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    lastErrorAt: toDateOrNull(row.last_error_at),
    recentGapsS: gaps.filter(
      (gap): gap is number => typeof gap === 'number' && Number.isFinite(gap),
    ),
  };
}

/** The `feeds` columns `nextSchedule` owns (packages/feeds `ScheduleUpdate`, spec 03 §9). */
export interface FeedScheduleColumns {
  status: FeedStatus;
  /** The stored interval, before jitter. */
  fetchIntervalS: number;
  nextFetchAt: Date;
  consecutiveErrors: number;
  consecutiveEmpty: number;
  quarantineCount: number;
  quarantinedUntil: Date | null;
  totalFetches: number;
  totalErrors: number;
  totalEmpty: number;
  lastFetchAt: Date;
  lastSuccessAt: Date | null;
  lastNewItemAt: Date | null;
  firstErrorAt: Date | null;
  lastErrorCode: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Feed metadata from a parsed 200 (spec 03 §6). An absent (or `undefined`) key keeps the stored
 * value; `null` clears it. `langHint` is the feed's `<language>` as an ISO 639-1 base language
 * (normalize it with `normalizeLanguageHint` first); leave it out when the feed has none, so the
 * detected majority (`refreshFeedLangHint`) is kept.
 */
export interface FeedMetaUpdate {
  title?: string | null | undefined;
  siteUrl?: string | null | undefined;
  description?: string | null | undefined;
  iconUrl?: string | null | undefined;
  langHint?: string | null | undefined;
}

export interface RecordFeedFetchInput {
  schedule: FeedScheduleColumns;
  meta?: FeedMetaUpdate | undefined;
  /** New `publish_stats.recent_gaps_s` (packages/feeds `recentGapsS`); absent keeps the stored one. */
  recentGapsS?: readonly number[] | undefined;
  /** New `publish_stats.items_7d` (see `feedItems7d`); absent keeps the stored one. */
  items7d?: number | undefined;
}

/**
 * The "after all items" feed update (spec 03 §7, §9), in the caller's transaction: the schedule
 * columns and validators computed by `nextSchedule`, feed metadata and `publish_stats`
 * (`recent_gaps_s`, `items_7d`; other keys are kept). It never touches `subscriber_count`,
 * `min_interval_s` or `unsubscribed_at` (the refresh functions own them) nor the feed's identity.
 *
 * Status guard: `dead` and `paused` change only through explicit resets (subscribe, admin reset),
 * never through a fetch outcome, so a stored `dead` or `paused` status (for example a merge or an
 * admin pause that committed while this fetch ran) is kept. A merged tombstone always stays `dead`
 * and keeps no validators (spec 03 §9). A missing feed is a no-op.
 */
export async function recordFeedFetch(
  tx: Transaction,
  feedId: string,
  input: RecordFeedFetchInput,
): Promise<void> {
  const s = input.schedule;
  const sets: SQL[] = [
    sql`status = CASE WHEN f.merged_into_id IS NOT NULL THEN 'dead'
                      WHEN f.status IN ('dead', 'paused') THEN f.status
                      ELSE ${s.status} END`,
    sql`fetch_interval_s = ${Math.max(1, Math.round(s.fetchIntervalS))}`,
    sql`next_fetch_at = ${iso(s.nextFetchAt)}::timestamptz`,
    sql`consecutive_errors = ${s.consecutiveErrors}`,
    sql`consecutive_empty = ${s.consecutiveEmpty}`,
    sql`quarantine_count = ${s.quarantineCount}`,
    sql`quarantined_until = ${iso(s.quarantinedUntil)}::timestamptz`,
    sql`total_fetches = ${s.totalFetches}`,
    sql`total_errors = ${s.totalErrors}`,
    sql`total_empty = ${s.totalEmpty}`,
    sql`last_fetch_at = ${iso(s.lastFetchAt)}::timestamptz`,
    sql`last_success_at = ${iso(s.lastSuccessAt)}::timestamptz`,
    sql`last_new_item_at = ${iso(s.lastNewItemAt)}::timestamptz`,
    sql`first_error_at = ${iso(s.firstErrorAt)}::timestamptz`,
    sql`last_error_code = ${s.lastErrorCode}`,
    sql`last_error = ${s.lastError}`,
    sql`last_error_at = ${iso(s.lastErrorAt)}::timestamptz`,
    sql`etag = CASE WHEN f.merged_into_id IS NULL THEN ${s.etag}::text END`,
    sql`last_modified = CASE WHEN f.merged_into_id IS NULL THEN ${s.lastModified}::text END`,
  ];
  const meta = input.meta ?? {};
  if (meta.title !== undefined) sets.push(sql`title = ${meta.title}`);
  if (meta.siteUrl !== undefined) sets.push(sql`site_url = ${meta.siteUrl}`);
  if (meta.description !== undefined) sets.push(sql`description = ${meta.description}`);
  if (meta.iconUrl !== undefined) sets.push(sql`icon_url = ${meta.iconUrl}`);
  if (meta.langHint !== undefined) sets.push(sql`lang_hint = ${meta.langHint}`);
  const stats: Record<string, unknown> = {};
  if (input.recentGapsS !== undefined) {
    stats['recent_gaps_s'] = input.recentGapsS
      .filter((gap) => Number.isFinite(gap) && gap > 0)
      .map((gap) => Math.round(gap))
      .slice(0, RECENT_PUBLICATIONS);
  }
  if (input.items7d !== undefined) stats['items_7d'] = Math.max(0, Math.round(input.items7d));
  if (Object.keys(stats).length > 0) {
    sets.push(sql`publish_stats = f.publish_stats || ${JSON.stringify(stats)}::jsonb`);
  }
  sets.push(sql`updated_at = now()`);
  await tx.execute(
    sql`UPDATE feeds f SET ${sql.join(sets, sql`, `)} WHERE f.id = ${feedId}::bigint`,
  );
}

/**
 * The newest ≤ `limit` (default 20) distinct `published_at` instants of the feed's items, newest
 * first, truncated to whole seconds as `recentGapsS` counts them (spec 03 §7, §9: gaps between
 * distinct valid dates). Items without a date are skipped.
 */
export async function feedRecentPublishedAt(
  db: Executor,
  feedId: string,
  limit: number = RECENT_PUBLICATIONS,
): Promise<Date[]> {
  const count = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : RECENT_PUBLICATIONS));
  const result = await db.execute<{ published_at: Timestamp }>(sql`
    SELECT DISTINCT date_trunc('second', a.published_at) AS published_at
      FROM feed_items fi JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${feedId}::bigint AND a.published_at IS NOT NULL
     ORDER BY 1 DESC
     LIMIT ${count}`);
  return result.rows.map((row) => toDate(row.published_at));
}

/**
 * Postpone a feed's next fetch until `until` without counting an error: the safe client sent no
 * request because the origin is cooling down or busy (`FEED_ORIGIN_COOLDOWN`, spec 03 §8.2, D-12).
 * Never brings a fetch forward.
 */
export async function deferFeedFetch(tx: Transaction, feedId: string, until: Date): Promise<void> {
  await tx.execute(sql`
    UPDATE feeds SET next_fetch_at = greatest(next_fetch_at, ${until.toISOString()}::timestamptz),
                     updated_at = now()
     WHERE id = ${feedId}::bigint`);
}

/** `publish_stats.items_7d`: the feed's items first seen in the last seven days. */
export async function feedItems7d(db: Executor, feedId: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM feed_items
     WHERE feed_id = ${feedId}::bigint AND first_seen_at > now() - interval '7 days'`);
  return result.rows[0]?.n ?? 0;
}

/**
 * `feeds.lang_hint` upkeep for a feed **without** `<language>` (spec 03 §8.3; the caller decides
 * that from the parsed feed, whose `<language>` is stored through `recordFeedFetch`). Among the
 * feed's newest 200 items (by arrival on this feed) whose article has a detected language other
 * than `und`: once there are at least 20, the majority language becomes the hint if it covers
 * ≥ 70 % of them; otherwise the stored hint is left as it is. Returns the resulting hint (`null`
 * for a feed without one, or a missing feed).
 */
export async function refreshFeedLangHint(tx: Transaction, feedId: string): Promise<string | null> {
  const stats = await tx.execute<{ lang: string; n: number; total: number }>(sql`
    WITH recent AS (
      SELECT a.lang
        FROM feed_items fi JOIN articles a ON a.id = fi.article_id
       WHERE fi.feed_id = ${feedId}::bigint AND a.lang IS NOT NULL AND a.lang <> 'und'
       ORDER BY fi.first_seen_at DESC, fi.article_id DESC
       LIMIT ${LANG_HINT_WINDOW}
    )
    SELECT lang, count(*)::int AS n, (sum(count(*)) OVER ())::int AS total
      FROM recent GROUP BY lang
     ORDER BY n DESC, lang
     LIMIT 1`);
  const top = stats.rows[0];
  if (
    top !== undefined &&
    top.total >= LANG_HINT_MIN_ARTICLES &&
    top.n * 100 >= LANG_HINT_MAJORITY_PERCENT * top.total
  ) {
    const updated = await tx.execute<{ lang_hint: string | null }>(sql`
      UPDATE feeds SET lang_hint = ${top.lang}, updated_at = now()
       WHERE id = ${feedId}::bigint AND lang_hint IS DISTINCT FROM ${top.lang}
      RETURNING lang_hint`);
    if (updated.rows[0] !== undefined) return updated.rows[0].lang_hint;
  }
  const current = await tx.execute<{ lang_hint: string | null }>(sql`
    SELECT lang_hint FROM feeds WHERE id = ${feedId}::bigint`);
  return current.rows[0]?.lang_hint ?? null;
}
