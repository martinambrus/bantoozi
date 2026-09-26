import { enqueueFetch, newUserId, planMinIntervalMap, type JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { resolveLiveFeedId } from './feeds.js';

/**
 * Worker-role helpers for the development CLI (`pnpm worker-cli`, M1-T9; spec 03 §10). They are
 * never used by the API, whose subscription routes run under tenant RLS with quotas (spec 08 §4).
 */

/** The development user, created on first use (the CLI's default subscriber). */
export async function ensureDevUser(
  tx: Transaction,
  email: string,
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO users (id, email) VALUES (${newUserId()}::uuid, ${email})
    ON CONFLICT (email) DO NOTHING RETURNING id::text AS id`);
  const created = inserted.rows[0];
  if (created !== undefined) return { id: created.id, created: true };
  const existing = await tx.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM users WHERE email = ${email} AND deleted_at IS NULL`,
  );
  const row = existing.rows[0];
  if (row === undefined) throw new Error(`user ${email} is soft-deleted`);
  return { id: row.id, created: false };
}

/**
 * Subscribe `userId` to the feed with canonical `url` (created with `fetchUrl` when new, spec 03
 * §5 and §10 step 5), with inference `off` like every new subscription. In the same transaction:
 * refresh the feed's subscriber count and card cache, and record a `feed.fetch` intent.
 */
export async function subscribeToFeed(
  tx: Transaction,
  sender: JobSender,
  input: { userId: string; url: string; fetchUrl: string; title: string | null },
): Promise<{ feedId: string; createdFeed: boolean; createdSubscription: boolean }> {
  await tx.execute(sql`SELECT 1 FROM users WHERE id = ${input.userId}::uuid FOR NO KEY UPDATE`);
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO feeds (url, fetch_url, title) VALUES (${input.url}, ${input.fetchUrl}, ${input.title})
    ON CONFLICT (url) DO NOTHING RETURNING id::text AS id`);
  let feedId = inserted.rows[0]?.id;
  const createdFeed = feedId !== undefined;
  if (feedId === undefined) {
    const existing = await tx.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM feeds WHERE url = ${input.url}`,
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('feed disappeared during subscribe');
    // A retired identity may have been merged more than once: subscribe to the live root.
    const live = await resolveLiveFeedId(tx, row.id);
    if (live === null) throw new Error(`feed ${row.id} has a missing or cyclic merge chain`);
    feedId = live;
  }
  const subscribed = await tx.execute(sql`
    INSERT INTO subscriptions (user_id, feed_id) VALUES (${input.userId}::uuid, ${feedId}::bigint)
    ON CONFLICT (user_id, feed_id) DO NOTHING`);
  const ids = sql.param([feedId]);
  await tx.execute(
    sql`SELECT refresh_feed_subscribers(${ids}::bigint[], ${JSON.stringify(planMinIntervalMap())}::jsonb)`,
  );
  await tx.execute(sql`SELECT refresh_feed_cards(${ids}::bigint[])`);
  await enqueueFetch(sender, { feedId });
  return { feedId, createdFeed, createdSubscription: (subscribed.rowCount ?? 0) > 0 };
}

export interface FeedOverview {
  id: string;
  url: string;
  fetchUrl: string;
  title: string | null;
  status: string;
  langHint: string | null;
  subscriberCount: number;
  fetchIntervalS: number;
  nextFetchAt: Date;
  lastFetchAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  totalFetches: number;
  etag: string | null;
  articles: Array<{
    id: string;
    title: string;
    pipelineState: string;
    lang: string | null;
    wordCount: number | null;
    bodyStatus: string | null;
    publishedAt: Date | null;
  }>;
}

/** A feed's bookkeeping and its newest articles, for `feeds:show`. */
export async function feedOverview(
  db: Executor,
  feedId: string,
  limit = 20,
): Promise<FeedOverview | null> {
  const feed = await db.execute<{
    id: string;
    url: string;
    fetch_url: string;
    title: string | null;
    status: string;
    lang_hint: string | null;
    subscriber_count: number;
    fetch_interval_s: number;
    next_fetch_at: Date;
    last_fetch_at: Date | null;
    last_success_at: Date | null;
    last_error_code: string | null;
    total_fetches: number;
    etag: string | null;
  }>(sql`
    SELECT id::text AS id, url, fetch_url, title, status, lang_hint, subscriber_count,
           fetch_interval_s, next_fetch_at, last_fetch_at, last_success_at, last_error_code,
           total_fetches, etag
      FROM feeds WHERE id = ${feedId}::bigint`);
  const f = feed.rows[0];
  if (f === undefined) return null;
  const articles = await db.execute<{
    id: string;
    title: string;
    pipeline_state: string;
    lang: string | null;
    word_count: number | null;
    body_status: string | null;
    published_at: Date | null;
  }>(sql`
    SELECT a.id::text AS id, a.title, a.pipeline_state, a.lang, a.word_count,
           b.status AS body_status, a.published_at
      FROM feed_items fi
      JOIN articles a ON a.id = fi.article_id
      LEFT JOIN article_bodies b ON b.article_id = a.id
     WHERE fi.feed_id = ${feedId}::bigint
     ORDER BY a.published_at DESC NULLS LAST, a.id DESC
     LIMIT ${limit}`);
  const date = (d: Date | null) => (d === null ? null : new Date(d));
  return {
    id: f.id,
    url: f.url,
    fetchUrl: f.fetch_url,
    title: f.title,
    status: f.status,
    langHint: f.lang_hint,
    subscriberCount: f.subscriber_count,
    fetchIntervalS: f.fetch_interval_s,
    nextFetchAt: new Date(f.next_fetch_at),
    lastFetchAt: date(f.last_fetch_at),
    lastSuccessAt: date(f.last_success_at),
    lastErrorCode: f.last_error_code,
    totalFetches: f.total_fetches,
    etag: f.etag,
    articles: articles.rows.map((a) => ({
      id: a.id,
      title: a.title,
      pipelineState: a.pipeline_state,
      lang: a.lang,
      wordCount: a.word_count,
      bodyStatus: a.body_status,
      publishedAt: date(a.published_at),
    })),
  };
}

/** Articles of a feed still awaiting extraction (the CLI runs them inline after a fetch). */
export async function feedArticlesAwaitingExtraction(
  db: Executor,
  feedId: string,
): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT a.id::text AS id
      FROM feed_items fi JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${feedId}::bigint AND a.pipeline_state = 'ingested'
     ORDER BY a.id`);
  return result.rows.map((r) => r.id);
}
