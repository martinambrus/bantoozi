import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { HEARTBEAT_KEY } from '../heartbeat.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Golden collection (spec 10 §2.1, M3a-T2): what `eval ingest-sample` and `eval sample` read. The
 * golden feeds are the feeds the evaluation user subscribes to (`ensureEvalUser`, subscribed with
 * `subscribeToFeed`); the candidate articles are the articles those feeds carry. Subscriptions
 * follow feed merges, so a feed that redirected to another stays golden through its survivor.
 */

/**
 * Pipeline states that never enter a sample: not extracted yet, older than `INGEST_MAX_AGE_DAYS`
 * at ingestion (`stale`, spec 03 §9) or failed. Every other state has the extracted input.
 */
export const SAMPLE_EXCLUDED_STATES = ['ingested', 'stale', 'failed'] as const;
export type SampleExclusionState = (typeof SAMPLE_EXCLUDED_STATES)[number];

/** The raw `settings['worker.heartbeat']` value (null when no worker ever wrote one). */
export async function readWorkerHeartbeats(db: Executor): Promise<unknown> {
  const result = await db.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = ${HEARTBEAT_KEY}`,
  );
  return result.rows[0]?.value ?? null;
}

export interface EvalFeedRow {
  feedId: string;
  url: string;
  fetchUrl: string;
  title: string | null;
  status: string;
  langHint: string | null;
  lastFetchAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  /** Articles the feed carries (`feed_items`). */
  articles: number;
}

/** The evaluation user's feeds, by feed id. */
export async function listEvalFeeds(db: Executor, userId: string): Promise<EvalFeedRow[]> {
  const result = await db.execute<{
    feed_id: string;
    url: string;
    fetch_url: string;
    title: string | null;
    status: string;
    lang_hint: string | null;
    last_fetch_at: RawTimestamp | null;
    last_success_at: RawTimestamp | null;
    last_error_code: string | null;
    articles: string;
  }>(sql`
    SELECT f.id::text AS feed_id, f.url, f.fetch_url, f.title, f.status, f.lang_hint,
           f.last_fetch_at, f.last_success_at, f.last_error_code,
           (SELECT count(*) FROM feed_items fi WHERE fi.feed_id = f.id)::text AS articles
      FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
     WHERE s.user_id = ${userId}::uuid
     ORDER BY f.id`);
  return result.rows.map((row) => ({
    feedId: row.feed_id,
    url: row.url,
    fetchUrl: row.fetch_url,
    title: row.title,
    status: row.status,
    langHint: row.lang_hint,
    lastFetchAt: toDateOrNull(row.last_fetch_at),
    lastSuccessAt: toDateOrNull(row.last_success_at),
    lastErrorCode: row.last_error_code,
    articles: Number(row.articles),
  }));
}

/**
 * The live feeds the user is subscribed to for each of `urls` (canonical feed URLs): the feed with
 * the URL, or the live feed it was merged into (followed through at most 20 merges). URLs the user
 * is not subscribed to are absent from the map.
 */
export async function subscribedFeedsByUrl(
  db: Executor,
  userId: string,
  urls: readonly string[],
): Promise<Map<string, { feedId: string; status: string }>> {
  if (urls.length === 0) return new Map();
  const result = await db.execute<{ listed: string; feed_id: string; status: string }>(sql`
    WITH RECURSIVE chain AS (
      SELECT f.url AS listed, f.id, f.merged_into_id, 0 AS depth
        FROM feeds f WHERE f.url = ANY(${sql.param([...urls])}::text[])
      UNION ALL
      SELECT c.listed, f.id, f.merged_into_id, c.depth + 1
        FROM chain c JOIN feeds f ON f.id = c.merged_into_id
       WHERE c.depth < 20)
    SELECT DISTINCT ON (c.listed) c.listed, f.id::text AS feed_id, f.status
      FROM chain c JOIN feeds f ON f.id = c.id
     WHERE c.merged_into_id IS NULL
       AND EXISTS (SELECT 1 FROM subscriptions s
                    WHERE s.user_id = ${userId}::uuid AND s.feed_id = c.id)
     ORDER BY c.listed, c.depth`);
  return new Map(result.rows.map((r) => [r.listed, { feedId: r.feed_id, status: r.status }]));
}

/** Queue backlog that collection waits for (spec 10 §2.1: "until the extract queue has drained"). */
export interface CollectionProgress {
  feeds: number;
  /** Golden feeds with a fetch attempt at or after `since`. */
  fetchedSince: number;
  /** Golden feeds not fetched now (`paused`, `dead` or `quarantined`): never waited for. */
  inactive: number;
  /** Active golden feeds without a fetch attempt since `since` (what collection still waits for). */
  awaitingFetch: number;
  /** Undelivered `job_outbox` intents per queue (feed.fetch, article.extract). */
  pendingIntents: Record<string, number>;
  /** pg-boss jobs per queue in `created`, `retry` or `active`. */
  pendingJobs: Record<string, number>;
  /** Articles of golden feeds still in `ingested` (extraction not done). */
  awaitingExtraction: number;
}

const DRAIN_QUEUES = ['feed.fetch', 'article.extract'];

export async function collectionProgress(
  db: Executor,
  userId: string,
  since: Date,
): Promise<CollectionProgress> {
  const after = since.toISOString();
  const feeds = await db.execute<{
    feeds: string;
    fetched: string;
    inactive: string;
    awaiting: string;
  }>(sql`
    SELECT count(*)::text AS feeds,
           count(*) FILTER (WHERE f.last_fetch_at >= ${after}::timestamptz)::text AS fetched,
           count(*) FILTER (WHERE f.status IN ('paused', 'dead', 'quarantined'))::text AS inactive,
           count(*) FILTER (WHERE f.status NOT IN ('paused', 'dead', 'quarantined')
                              AND (f.last_fetch_at IS NULL
                                   OR f.last_fetch_at < ${after}::timestamptz))::text AS awaiting
      FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
     WHERE s.user_id = ${userId}::uuid`);
  const intents = await db.execute<{ queue: string; n: string }>(sql`
    SELECT queue, count(*)::text AS n FROM job_outbox
     WHERE delivered_at IS NULL AND queue = ANY(${sql.param(DRAIN_QUEUES)}::text[])
     GROUP BY queue`);
  const jobs = await db.execute<{ queue: string; n: string }>(sql`
    SELECT name AS queue, count(*)::text AS n FROM pgboss.job
     WHERE name = ANY(${sql.param(DRAIN_QUEUES)}::text[])
       AND state IN ('created', 'retry', 'active')
     GROUP BY name`);
  const waiting = await db.execute<{ n: string }>(sql`
    SELECT count(DISTINCT a.id)::text AS n
      FROM subscriptions s
      JOIN feed_items fi ON fi.feed_id = s.feed_id
      JOIN articles a ON a.id = fi.article_id
     WHERE s.user_id = ${userId}::uuid AND a.pipeline_state = 'ingested'`);
  const row = feeds.rows[0];
  const byQueue = (rows: { queue: string; n: string }[]) =>
    Object.fromEntries(
      DRAIN_QUEUES.map((q) => [q, Number(rows.find((r) => r.queue === q)?.n ?? 0)]),
    );
  return {
    feeds: Number(row?.feeds ?? 0),
    fetchedSince: Number(row?.fetched ?? 0),
    inactive: Number(row?.inactive ?? 0),
    awaitingFetch: Number(row?.awaiting ?? 0),
    pendingIntents: byQueue(intents.rows),
    pendingJobs: byQueue(jobs.rows),
    awaitingExtraction: Number(waiting.rows[0]?.n ?? 0),
  };
}

/** Collected articles of one detected language (`und` when none was detected). */
export interface CollectionLangCount {
  lang: string;
  articles: number;
  /** Eligible for a sample (extracted, not stale, not failed). */
  eligible: number;
  pending: number;
  stale: number;
  failed: number;
}

export async function collectionLangCounts(
  db: Executor,
  userId: string,
): Promise<CollectionLangCount[]> {
  const result = await db.execute<{
    lang: string;
    articles: string;
    pending: string;
    stale: string;
    failed: string;
  }>(sql`
    SELECT coalesce(a.lang, 'und') AS lang, count(*)::text AS articles,
           count(*) FILTER (WHERE a.pipeline_state = 'ingested')::text AS pending,
           count(*) FILTER (WHERE a.pipeline_state = 'stale')::text AS stale,
           count(*) FILTER (WHERE a.pipeline_state = 'failed')::text AS failed
      FROM articles a
     WHERE a.id IN (SELECT fi.article_id FROM subscriptions s
                      JOIN feed_items fi ON fi.feed_id = s.feed_id
                     WHERE s.user_id = ${userId}::uuid)
     GROUP BY 1 ORDER BY 1`);
  return result.rows.map((row) => {
    const articles = Number(row.articles);
    const pending = Number(row.pending);
    const stale = Number(row.stale);
    const failed = Number(row.failed);
    return {
      lang: row.lang,
      articles,
      eligible: articles - pending - stale - failed,
      pending,
      stale,
      failed,
    };
  });
}

/** One collected article, as `eval sample` stratifies it. */
export interface SampleCandidate {
  articleId: string;
  /** Detected language, or null. */
  lang: string | null;
  pipelineState: string;
  /** The golden feed that first carried it (oldest `feed_items` row, then lowest feed id). */
  feedId: string;
  /** Every golden feed carrying it, in that order (`feedId` first). */
  carrierFeedIds: string[];
  firstSeenAt: Date;
}

/**
 * Holds every feed–article association still until the transaction ends: `SHARE` mode lets readers
 * through but makes the ingest worker's `feed_items` writes wait, so the carrier sets a sample draw
 * selects by are the ones its snapshots freeze. Must run inside a transaction.
 */
export async function lockSampleCarriers(tx: Executor): Promise<void> {
  await tx.execute(sql`LOCK TABLE feed_items IN SHARE MODE`);
}

/**
 * Every article the user's feeds carry, ordered by id (eligible or not: exclusions are counted).
 * Inside a transaction the articles stay share-locked until it ends, so the ingest-only worker
 * cannot change an article's language or pipeline state between the draw and its snapshot.
 */
export async function loadSampleCandidates(
  db: Executor,
  userId: string,
): Promise<SampleCandidate[]> {
  await db.execute(sql`
    SELECT a.id
      FROM articles a
     WHERE a.id IN (SELECT fi.article_id
                      FROM subscriptions s
                      JOIN feed_items fi ON fi.feed_id = s.feed_id
                     WHERE s.user_id = ${userId}::uuid)
     ORDER BY a.id
       FOR SHARE OF a`);
  const result = await db.execute<{
    article_id: string;
    lang: string | null;
    pipeline_state: string;
    feed_ids: string[];
    first_seen_at: RawTimestamp;
  }>(sql`
    SELECT a.id::text AS article_id, a.lang, a.pipeline_state, a.first_seen_at,
           array_agg(fi.feed_id::text ORDER BY fi.first_seen_at, fi.feed_id) AS feed_ids
      FROM subscriptions s
      JOIN feed_items fi ON fi.feed_id = s.feed_id
      JOIN articles a ON a.id = fi.article_id
     WHERE s.user_id = ${userId}::uuid
     GROUP BY a.id
     ORDER BY a.id`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    lang: row.lang,
    pipelineState: row.pipeline_state,
    feedId: row.feed_ids[0] ?? '',
    carrierFeedIds: row.feed_ids,
    firstSeenAt: toDate(row.first_seen_at),
  }));
}
