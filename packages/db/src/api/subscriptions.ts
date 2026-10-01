import {
  enqueueFetch,
  planMinIntervalMap,
  type ImagePolicy,
  type InferenceMode,
  type JobSender,
} from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { resolveLiveFeedId } from '../ingest/feeds.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Subscriptions, remembered feed preferences, folders, OPML rows and selected-article analysis
 * requests of the signed-in user (spec 08 §4, spec 02 §4). Everything runs in the caller's tenant
 * transaction, so RLS scopes every per-user table; shared `feeds`/`feed_items`/`articles` reads are
 * always joined through the user's own subscription, bookmark or preference.
 *
 * Lock order (spec 02 §6 "Callers"): the caller locks its `users` row first (`readOwnUser(tx,
 * {lock: true})`), then this module locks feed rows in id order before changing subscriptions, and
 * both refresh functions take the same feed locks again.
 */

/** The fixed reading window of lists and counts (spec 08 §5.1, spec 06 §11 `RANK_WINDOW_DAYS`). */
export const READER_WINDOW_DAYS = 14;

export type FeedStatus = 'active' | 'quarantined' | 'dead' | 'paused';

/** `FeedInfo` (spec 08 §4) with `Date` timestamps. */
export interface FeedInfoRow {
  id: string;
  url: string;
  siteUrl: string | null;
  title: string | null;
  iconUrl: string | null;
  status: FeedStatus;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
}

/** One of the user's subscriptions with its feed and remembered image policy. */
export interface SubscriptionRow {
  feed: FeedInfoRow;
  titleOverride: string | null;
  folder: string | null;
  allowDuplicates: boolean;
  hidden: boolean;
  inferenceMode: InferenceMode;
  inferenceVersion: string;
  inferenceActivatedAt: Date | null;
  /** `user_feed_preferences.image_policy`, `inherit` without a row. */
  imagePolicy: ImagePolicy;
  createdAt: Date;
}

type SubscriptionDbRow = {
  feed_id: string;
  url: string;
  site_url: string | null;
  title: string | null;
  icon_url: string | null;
  status: FeedStatus;
  last_success_at: RawTimestamp | null;
  last_error_code: string | null;
  last_error_at: RawTimestamp | null;
  title_override: string | null;
  folder: string | null;
  allow_duplicates: boolean;
  hidden: boolean;
  inference_mode: InferenceMode;
  inference_version: string;
  inference_activated_at: RawTimestamp | null;
  image_policy: ImagePolicy | null;
  created_at: RawTimestamp;
};

function subscriptionRow(row: SubscriptionDbRow): SubscriptionRow {
  return {
    feed: {
      id: row.feed_id,
      url: row.url,
      siteUrl: row.site_url,
      title: row.title,
      iconUrl: row.icon_url,
      status: row.status,
      lastSuccessAt: toDateOrNull(row.last_success_at),
      lastErrorCode: row.last_error_code,
      lastErrorAt: toDateOrNull(row.last_error_at),
    },
    titleOverride: row.title_override,
    folder: row.folder,
    allowDuplicates: row.allow_duplicates,
    hidden: row.hidden,
    inferenceMode: row.inference_mode,
    inferenceVersion: row.inference_version,
    inferenceActivatedAt: toDateOrNull(row.inference_activated_at),
    imagePolicy: row.image_policy ?? 'inherit',
    createdAt: toDate(row.created_at),
  };
}

const selectSubscriptions = (user: string, where: SQL) => sql`
  SELECT s.feed_id::text AS feed_id, f.url, f.site_url, f.title, f.icon_url, f.status,
         f.last_success_at, f.last_error_code, f.last_error_at, s.title_override, s.folder,
         s.allow_duplicates, s.hidden, s.inference_mode, s.inference_version::text AS inference_version,
         s.inference_activated_at, p.image_policy, s.created_at
    FROM subscriptions s
    JOIN feeds f ON f.id = s.feed_id
    LEFT JOIN user_feed_preferences p ON p.user_id = s.user_id AND p.feed_id = s.feed_id
   WHERE s.user_id = ${user}::uuid ${where}`;

/** The user's subscriptions, by display title then feed id (spec 08 §4 `GET /subscriptions`). */
export async function listSubscriptions(tx: TenantTx): Promise<SubscriptionRow[]> {
  const result = await tx.execute<SubscriptionDbRow>(sql`
    ${selectSubscriptions(tenantUserId(tx), sql``)}
    ORDER BY lower(coalesce(s.title_override, f.title, f.url)), s.feed_id`);
  return result.rows.map(subscriptionRow);
}

/** One owned subscription, or null (another user's or an unknown feed id: never revealed). */
export async function getSubscription(
  tx: TenantTx,
  feedId: string,
): Promise<SubscriptionRow | null> {
  const result = await tx.execute<SubscriptionDbRow>(
    selectSubscriptions(tenantUserId(tx), sql`AND s.feed_id = ${feedId}::bigint`),
  );
  const row = result.rows[0];
  return row === undefined ? null : subscriptionRow(row);
}

/** The owned subscription's inference state under a row lock (mode CAS, spec 02 §3.4). */
export async function lockSubscription(
  tx: TenantTx,
  feedId: string,
): Promise<{ mode: InferenceMode; version: string; activatedAt: Date | null } | null> {
  const result = await tx.execute<{
    inference_mode: InferenceMode;
    inference_version: string;
    inference_activated_at: RawTimestamp | null;
  }>(sql`
    SELECT inference_mode, inference_version::text AS inference_version, inference_activated_at
      FROM subscriptions
     WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ${feedId}::bigint
       FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        mode: row.inference_mode,
        version: row.inference_version,
        activatedAt: toDateOrNull(row.inference_activated_at),
      };
}

/** Decimal ids sorted numerically and deduplicated (the feed lock order). */
function sortIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Lock feed rows in id order (`FOR NO KEY UPDATE`, the lock both refresh functions take), so
 * concurrent subscribe/unsubscribe of the same feeds serialize instead of deadlocking.
 */
export async function lockFeeds(tx: TenantTx, feedIds: readonly string[]): Promise<void> {
  if (feedIds.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM feeds WHERE id = ANY(${sql.param(sortIds(feedIds))}::bigint[])
     ORDER BY id FOR NO KEY UPDATE`);
}

/**
 * Recompute `feeds.subscriber_count`/`min_interval_s` and `feed_cards` for the complete affected
 * feed set in the state transaction (spec 02 §6 "Callers", spec 08 §4).
 */
export async function refreshFeedMaterializations(
  tx: TenantTx,
  feedIds: readonly string[],
): Promise<void> {
  const ids = sortIds(feedIds);
  if (ids.length === 0) return;
  const param = sql.param(ids);
  await tx.execute(
    sql`SELECT refresh_feed_subscribers(${param}::bigint[], ${JSON.stringify(planMinIntervalMap())}::jsonb)`,
  );
  await tx.execute(sql`SELECT refresh_feed_cards(${param}::bigint[])`);
}

/** A feed identity to subscribe to: the canonical `url` and the URL to fetch. */
export interface FeedIdentity {
  /** Canonical identity (`feeds.url`, spec 03 §5). */
  url: string;
  /** `feeds.fetch_url`. */
  fetchUrl: string;
  title: string | null;
}

/**
 * Find or create the live feed row for `identity` and hold it with `FOR NO KEY UPDATE` (spec 03
 * §10 step 5): an existing row with the canonical URL is reused, a merged tombstone resolves to its
 * live survivor (followed again if a merge commits while this waits). Returns the live feed id, its
 * status and whether the row was created here. New rows are due now (`next_fetch_at` default).
 */
export async function ensureFeed(
  tx: TenantTx,
  identity: FeedIdentity,
): Promise<{ feedId: string; status: FeedStatus; created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO feeds (url, fetch_url, title)
    VALUES (${identity.url}, ${identity.fetchUrl}, ${identity.title})
    ON CONFLICT (url) DO NOTHING RETURNING id::text AS id`);
  let feedId = inserted.rows[0]?.id;
  const created = feedId !== undefined;
  if (feedId === undefined) {
    const existing = await tx.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM feeds WHERE url = ${identity.url}`,
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('feed disappeared during subscribe');
    feedId = row.id;
  }
  for (let attempt = 1; ; attempt += 1) {
    const live = await resolveLiveFeedId(tx, feedId);
    if (live === null) throw new Error(`feed ${feedId} has a missing or cyclic merge chain`);
    feedId = live;
    const locked = await tx.execute<{ merged_into_id: string | null; status: FeedStatus }>(sql`
      SELECT merged_into_id::text AS merged_into_id, status FROM feeds
       WHERE id = ${feedId}::bigint FOR NO KEY UPDATE`);
    const current = locked.rows[0];
    if (current === undefined) throw new Error(`feed ${feedId} disappeared during subscribe`);
    if (current.merged_into_id === null) return { feedId, status: current.status, created };
    if (attempt >= 5) throw new Error(`feed ${feedId} has no stable live root to subscribe to`);
  }
}

/**
 * The live feed id of each canonical URL that has a feed row (spec 03 §5, §9): a merged tombstone
 * resolves to its survivor. Unknown URLs are absent. Reads only; nothing is locked.
 */
export async function resolveFeedUrls(
  tx: TenantTx,
  urls: readonly string[],
): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const resolved = await tx.execute<{ url: string; live_id: string }>(sql`
    WITH RECURSIVE chain (url, id, merged_into_id, depth) AS (
      SELECT f.url, f.id, f.merged_into_id, 0 FROM feeds f
       WHERE f.url = ANY(${sql.param([...urls])}::text[])
      UNION ALL
      SELECT c.url, f.id, f.merged_into_id, c.depth + 1
        FROM chain c JOIN feeds f ON f.id = c.merged_into_id
       WHERE c.depth < 20
    )
    SELECT DISTINCT ON (url) url, id::text AS live_id FROM chain
     WHERE merged_into_id IS NULL ORDER BY url, depth`);
  return new Map(resolved.rows.map((row) => [row.url, row.live_id]));
}

/**
 * Batch form of {@link ensureFeed} for OPML import (spec 03 §11): create the missing feed rows
 * (no fetch: new rows are due now), resolve every identity to its live feed and lock those feeds in
 * id order, the order every subscription writer and both refresh functions use. Returns the live
 * feed id of each canonical URL.
 */
export async function ensureFeeds(
  tx: TenantTx,
  identities: readonly FeedIdentity[],
): Promise<Map<string, string>> {
  if (identities.length === 0) return new Map();
  await tx.execute(sql`
    INSERT INTO feeds (url, fetch_url, title)
    SELECT u.url, u.fetch_url, u.title
      FROM unnest(${sql.param(identities.map((i) => i.url))}::text[],
                  ${sql.param(identities.map((i) => i.fetchUrl))}::text[],
                  ${sql.param(identities.map((i) => i.title))}::text[]) AS u(url, fetch_url, title)
     ORDER BY u.url
    ON CONFLICT (url) DO NOTHING`);
  for (let attempt = 1; ; attempt += 1) {
    const live = await resolveFeedUrls(
      tx,
      identities.map((i) => i.url),
    );
    if (identities.some((identity) => !live.has(identity.url))) {
      throw new Error('a feed has a missing or cyclic merge chain');
    }
    const locked = await tx.execute<{ merged: boolean }>(sql`
      SELECT merged_into_id IS NOT NULL AS merged FROM feeds
       WHERE id = ANY(${sql.param(sortIds([...live.values()]))}::bigint[])
       ORDER BY id FOR NO KEY UPDATE`);
    // A merge that committed while this waited retired a locked feed: resolve again.
    if (!locked.rows.some((row) => row.merged)) return live;
    if (attempt >= 5) throw new Error('feeds have no stable live roots to subscribe to');
  }
}

/**
 * Insert subscriptions with inference `off` for these feeds and folders, skipping existing ones
 * (spec 03 §11: existing subscriptions keep their mode and folder). Returns the inserted feed ids.
 */
export async function insertSubscriptions(
  tx: TenantTx,
  rows: ReadonlyArray<{ feedId: string; folder: string | null }>,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const result = await tx.execute<{ feed_id: string }>(sql`
    INSERT INTO subscriptions (user_id, feed_id, folder)
    SELECT ${tenantUserId(tx)}::uuid, r.feed_id, r.folder
      FROM unnest(${sql.param(rows.map((r) => r.feedId))}::bigint[],
                  ${sql.param(rows.map((r) => r.folder))}::text[]) AS r(feed_id, folder)
     ORDER BY r.feed_id
    ON CONFLICT (user_id, feed_id) DO NOTHING
    RETURNING feed_id::text AS feed_id`);
  return result.rows.map((row) => row.feed_id);
}

/**
 * Revive a reused `dead` live feed that discovery has just validated (spec 03 §10 step 6, D-22):
 * active, error and quarantine state cleared, due now. Paused feeds stay paused.
 */
export async function reviveDeadFeed(tx: TenantTx, feedId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE feeds
       SET status = 'active', consecutive_errors = 0, first_error_at = NULL,
           quarantined_until = NULL, quarantine_count = 0, next_fetch_at = now(), updated_at = now()
     WHERE id = ${feedId}::bigint AND status = 'dead' AND merged_into_id IS NULL`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Insert the subscription with inference `off` (the default; spec 02 §3.4). An existing one is left
 * untouched, folder included (spec 08 §4); the result says whether a row was inserted.
 */
export async function insertSubscription(
  tx: TenantTx,
  input: { feedId: string; folder: string | null },
): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO subscriptions (user_id, feed_id, folder)
    VALUES (${tenantUserId(tx)}::uuid, ${input.feedId}::bigint, ${input.folder})
    ON CONFLICT (user_id, feed_id) DO NOTHING`);
  return (result.rowCount ?? 0) > 0;
}

/** Record the first `feed.fetch` of a subscribed feed (local fetch/parse only, no inference). */
export async function recordFirstFetch(sender: JobSender, feedId: string): Promise<void> {
  await enqueueFetch(sender, { feedId });
}

/** Which of these feeds the user already subscribes to. */
export async function subscribedFeedIds(
  tx: TenantTx,
  feedIds: readonly string[],
): Promise<Set<string>> {
  if (feedIds.length === 0) return new Set();
  const result = await tx.execute<{ feed_id: string }>(sql`
    SELECT feed_id::text AS feed_id FROM subscriptions
     WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ANY(${sql.param([...feedIds])}::bigint[])`);
  return new Set(result.rows.map((row) => row.feed_id));
}

/** The user's subscribed feed ids, ascending. */
export async function subscriptionFeedIds(tx: TenantTx): Promise<string[]> {
  const result = await tx.execute<{ feed_id: string }>(sql`
    SELECT feed_id::text AS feed_id FROM subscriptions
     WHERE user_id = ${tenantUserId(tx)}::uuid ORDER BY feed_id`);
  return result.rows.map((row) => row.feed_id);
}

/** The supplied metadata columns of `PATCH /subscriptions/:feedId` (missing = unchanged). */
export interface SubscriptionMetadataPatch {
  titleOverride?: string | null;
  folder?: string | null;
  allowDuplicates?: boolean;
  hidden?: boolean;
}

/** Update only the supplied metadata columns; false when the subscription is not the user's. */
export async function updateSubscriptionMetadata(
  tx: TenantTx,
  feedId: string,
  patch: SubscriptionMetadataPatch,
): Promise<boolean> {
  const sets: SQL[] = [];
  if (patch.titleOverride !== undefined) sets.push(sql`title_override = ${patch.titleOverride}`);
  if (patch.folder !== undefined) sets.push(sql`folder = ${patch.folder}`);
  if (patch.allowDuplicates !== undefined) {
    sets.push(sql`allow_duplicates = ${patch.allowDuplicates}`);
  }
  if (patch.hidden !== undefined) sets.push(sql`hidden = ${patch.hidden}`);
  const where = sql`WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ${feedId}::bigint`;
  if (sets.length === 0) {
    const exists = await tx.execute(sql`SELECT 1 FROM subscriptions ${where} FOR UPDATE`);
    return exists.rows.length > 0;
  }
  const result = await tx.execute(
    sql`UPDATE subscriptions SET ${sql.join(sets, sql`, `)} ${where}`,
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Persist an inference mode change planned under the row lock (`planInferenceModeChange`): the next
 * version, and the activation boundary at the transaction time (`now()`) only when entering
 * active, null otherwise (spec 02 §3.4; the subscription trigger checks both).
 */
export async function setInferenceMode(
  tx: TenantTx,
  feedId: string,
  change: { mode: InferenceMode; version: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE subscriptions
       SET inference_mode = ${change.mode}, inference_version = ${change.version}::bigint,
           inference_activated_at = CASE WHEN ${change.mode}::text = 'active' THEN now() END
     WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ${feedId}::bigint`);
}

/**
 * Delete the user's subscription (spec 08 §4). Scoped interest cards on this feed go with it
 * through the composite foreign key (spec 02 §5.2), so their number is captured first for the
 * learn intent. Analysis requests stay: the worker cancels pending/running ones on its next attempt
 * or `house.reconcile`, and completed ones keep serving learning (spec 11 §5).
 */
export async function deleteSubscription(
  tx: TenantTx,
  feedId: string,
): Promise<{ deleted: boolean; scopedCards: number }> {
  const user = tenantUserId(tx);
  const scoped = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM user_cards
     WHERE user_id = ${user}::uuid AND scope_feed_id = ${feedId}::bigint`);
  const result = await tx.execute(sql`
    DELETE FROM subscriptions WHERE user_id = ${user}::uuid AND feed_id = ${feedId}::bigint`);
  return { deleted: (result.rowCount ?? 0) > 0, scopedCards: scoped.rows[0]?.n ?? 0 };
}

/**
 * Rename a folder across the user's subscriptions (spec 08 §4); returns the renamed feeds. The feed
 * rows are locked in id order first, as for every subscription change.
 */
export async function renameSubscriptionFolder(
  tx: TenantTx,
  input: { from: string; to: string },
): Promise<string[]> {
  const user = tenantUserId(tx);
  const affected = await tx.execute<{ feed_id: string }>(sql`
    SELECT feed_id::text AS feed_id FROM subscriptions
     WHERE user_id = ${user}::uuid AND folder = ${input.from} ORDER BY feed_id`);
  const feedIds = affected.rows.map((row) => row.feed_id);
  if (feedIds.length === 0) return [];
  await lockFeeds(tx, feedIds);
  const result = await tx.execute<{ feed_id: string }>(sql`
    UPDATE subscriptions SET folder = ${input.to}
     WHERE user_id = ${user}::uuid AND folder = ${input.from}
    RETURNING feed_id::text AS feed_id`);
  return result.rows.map((row) => row.feed_id);
}

// ── Remembered image policy (spec 08 §4.2, spec 02 §3.5) ─────────────────────────────────────

export interface FeedPreferenceRow {
  feedId: string;
  imagePolicy: ImagePolicy;
}

/** The user's remembered per-feed preferences, unsubscribed bookmark sources included. */
export async function listFeedPreferences(tx: TenantTx): Promise<FeedPreferenceRow[]> {
  const result = await tx.execute<{ feed_id: string; image_policy: ImagePolicy }>(sql`
    SELECT feed_id::text AS feed_id, image_policy FROM user_feed_preferences
     WHERE user_id = ${tenantUserId(tx)}::uuid ORDER BY feed_id`);
  return result.rows.map((row) => ({ feedId: row.feed_id, imagePolicy: row.image_policy }));
}

/**
 * Whether the user may hold a preference for this feed (spec 08 §4 `PUT /feed-preferences`): an
 * owned subscription, a bookmark whose captured origin is the feed, or an existing own preference.
 */
export async function canHoldFeedPreference(tx: TenantTx, feedId: string): Promise<boolean> {
  const user = tenantUserId(tx);
  const result = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM subscriptions
                    WHERE user_id = ${user}::uuid AND feed_id = ${feedId}::bigint)
        OR EXISTS (SELECT 1 FROM user_article
                    WHERE user_id = ${user}::uuid AND bookmarked_at IS NOT NULL
                      AND bookmark_origin_feed_id = ${feedId}::bigint)
        OR EXISTS (SELECT 1 FROM user_feed_preferences
                    WHERE user_id = ${user}::uuid AND feed_id = ${feedId}::bigint) AS ok`);
  return result.rows[0]?.ok === true;
}

/** Upsert the durable preference (it outlives the subscription); never touches inference mode. */
export async function upsertFeedPreference(
  tx: TenantTx,
  feedId: string,
  imagePolicy: ImagePolicy,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO user_feed_preferences (user_id, feed_id, image_policy)
    VALUES (${tenantUserId(tx)}::uuid, ${feedId}::bigint, ${imagePolicy})
    ON CONFLICT (user_id, feed_id)
      DO UPDATE SET image_policy = EXCLUDED.image_policy, updated_at = now()`);
}

/** The user's own preference for one feed, or null. */
export async function getFeedPreference(tx: TenantTx, feedId: string): Promise<ImagePolicy | null> {
  const result = await tx.execute<{ image_policy: ImagePolicy }>(sql`
    SELECT image_policy FROM user_feed_preferences
     WHERE user_id = ${tenantUserId(tx)}::uuid AND feed_id = ${feedId}::bigint`);
  return result.rows[0]?.image_policy ?? null;
}

// ── OPML (spec 03 §11) ─────────────────────────────────────────────────────────────────────

export interface OpmlRow {
  title: string;
  xmlUrl: string;
  htmlUrl: string | null;
  folder: string | null;
}

/**
 * The user's subscriptions for OPML export (spec 03 §11): the title override else the feed title,
 * the live survivor's fetch URL for a merged feed, paused/dead feeds included; ordered by folder
 * (top level first), title and feed id.
 */
export async function listOpmlRows(tx: TenantTx): Promise<OpmlRow[]> {
  const user = tenantUserId(tx);
  const result = await tx.execute<{
    title: string | null;
    xml_url: string;
    html_url: string | null;
    folder: string | null;
  }>(sql`
    WITH RECURSIVE chain (feed_id, id, merged_into_id, depth) AS (
      SELECT s.feed_id, f.id, f.merged_into_id, 0
        FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
       WHERE s.user_id = ${user}::uuid
      UNION ALL
      SELECT c.feed_id, f.id, f.merged_into_id, c.depth + 1
        FROM chain c JOIN feeds f ON f.id = c.merged_into_id
       WHERE c.depth < 20
    ),
    live AS (SELECT DISTINCT ON (feed_id) feed_id, id FROM chain
              WHERE merged_into_id IS NULL ORDER BY feed_id, depth)
    SELECT coalesce(s.title_override, f.title, lf.title) AS title,
           lf.fetch_url AS xml_url, lf.site_url AS html_url, s.folder
      FROM subscriptions s
      JOIN feeds f ON f.id = s.feed_id
      JOIN live l ON l.feed_id = s.feed_id
      JOIN feeds lf ON lf.id = l.id
     WHERE s.user_id = ${user}::uuid
     ORDER BY s.folder NULLS FIRST, lower(coalesce(s.title_override, f.title, lf.fetch_url)),
              s.feed_id`);
  return result.rows.map((row) => ({
    title: row.title ?? '',
    xmlUrl: row.xml_url,
    htmlUrl: row.html_url,
    folder: row.folder,
  }));
}

// ── Selected-article analysis requests (spec 08 §4.1) ─────────────────────────────────────

/** Why one selected article cannot be requested. */
export type SelectionProblem = 'not_carried' | 'stale_revision';

/**
 * Validate a complete selection before anything is inserted (spec 08 §4.1): every article must be
 * carried by this (owned, already locked) feed and still be at the submitted content revision. The
 * carried articles are share-locked so their revision holds until commit. Returns the problems by
 * article id; an empty map means the whole selection is valid.
 */
export async function checkAnalysisSelection(
  tx: TenantTx,
  feedId: string,
  articles: ReadonlyArray<{ id: string; contentRevision: string }>,
): Promise<Map<string, SelectionProblem>> {
  const ids = articles.map((a) => a.id);
  const result = await tx.execute<{ id: string; revision: string }>(sql`
    SELECT a.id::text AS id, a.content_revision::text AS revision
      FROM feed_items fi JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${feedId}::bigint AND fi.article_id = ANY(${sql.param(ids)}::bigint[])
     ORDER BY a.id
       FOR SHARE OF a`);
  const current = new Map(result.rows.map((row) => [row.id, row.revision]));
  const problems = new Map<string, SelectionProblem>();
  for (const article of articles) {
    const revision = current.get(article.id);
    if (revision === undefined) problems.set(article.id, 'not_carried');
    else if (revision !== article.contentRevision) problems.set(article.id, 'stale_revision');
  }
  return problems;
}

/**
 * Current requests of the user for these feed articles that a repeated selection reuses (spec 08
 * §4.1): same feed, article and revision, the subscription's current inference version, still
 * pending/running/complete and inside the 180-day window. The newest per article wins.
 */
export async function reusableAnalysisRequests(
  tx: TenantTx,
  input: {
    feedId: string;
    inferenceVersion: string;
    articles: ReadonlyArray<{ id: string; contentRevision: string }>;
  },
): Promise<Map<string, { id: string; status: 'pending' | 'running' | 'complete' }>> {
  const ids = input.articles.map((a) => a.id);
  const revisions = input.articles.map((a) => a.contentRevision);
  const result = await tx.execute<{
    article_id: string;
    id: string;
    status: 'pending' | 'running' | 'complete';
  }>(sql`
    SELECT DISTINCT ON (r.article_id) r.article_id::text AS article_id, r.id::text AS id, r.status
      FROM analysis_requests r
      JOIN unnest(${sql.param(ids)}::bigint[], ${sql.param(revisions)}::bigint[]) AS sel(id, revision)
        ON sel.id = r.article_id AND sel.revision = r.article_revision
     WHERE r.user_id = ${tenantUserId(tx)}::uuid AND r.feed_id = ${input.feedId}::bigint
       AND r.inference_version = ${input.inferenceVersion}::bigint
       AND r.status IN ('pending', 'running', 'complete')
       AND r.created_at > now() - make_interval(days => ${SELECTION_WINDOW_DAYS})
     ORDER BY r.article_id, r.created_at DESC`);
  return new Map(result.rows.map((row) => [row.article_id, { id: row.id, status: row.status }]));
}

export interface AnalysisRequestView {
  id: string;
  feedId: string;
  articleId: string;
  contentRevision: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  createdAt: Date;
  completedAt: Date | null;
  errorCode: string | null;
}

/** One own request (RLS: another user's id reads as missing). */
export async function getAnalysisRequest(
  tx: TenantTx,
  id: string,
): Promise<AnalysisRequestView | null> {
  const result = await tx.execute<{
    id: string;
    feed_id: string;
    article_id: string;
    article_revision: string;
    status: AnalysisRequestView['status'];
    created_at: RawTimestamp;
    completed_at: RawTimestamp | null;
    last_error_code: string | null;
  }>(sql`
    SELECT id::text AS id, feed_id::text AS feed_id, article_id::text AS article_id,
           article_revision::text AS article_revision, status, created_at, completed_at,
           last_error_code
      FROM analysis_requests WHERE id = ${id}::uuid AND user_id = ${tenantUserId(tx)}::uuid`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        feedId: row.feed_id,
        articleId: row.article_id,
        contentRevision: row.article_revision,
        status: row.status,
        createdAt: toDate(row.created_at),
        completedAt: toDateOrNull(row.completed_at),
        errorCode: row.last_error_code,
      };
}
