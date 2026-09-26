import { planMinIntervalMap, type JobSender } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { sqlState } from '../errors.js';
import { lockUrlKeys } from './articles.js';
import { activeSubscriberIds } from './demand.js';
import { resolveLiveFeedId } from './feeds.js';
import { recordRankIntents } from './rank-intents.js';

/**
 * The scheme of a linkless item's `url_key` (spec 03 §5 step 8, `LINKLESS_URL_KEY_PREFIX` in
 * `packages/feeds`): `urn:bantoozi:<feedId>:<sha256 of the item identity>`. Only the feed segment
 * depends on the carrier; the hash covers the item alone.
 */
const LINKLESS_KEY_PREFIX = 'urn:bantoozi:';

/**
 * Permanent feed redirects and feed identity merges (spec 03 §9 "Permanent redirect of the feed
 * URL"; spec 02 §3.3–§3.5, §4, §6). Everything runs in the caller's worker-role transaction (run it
 * through `retryTransaction`: lock waits can end in a deadlock or serialization failure). The merge
 * never decides the next pipeline stage: it returns the associations that are new on the survivor,
 * and the caller applies the §7 new-carrier continuation to them.
 */

/** Rank reason of the full rank a merge records for every affected subscriber. */
export const FEED_MERGE_RANK_REASON = 'feed_merge';

/** `analysis_requests.last_error_code` of pending/running generations cancelled by a merge. */
export const FEED_MERGE_CANCEL_CODE = 'feed_merged';

/**
 * A feed-scoped GUID that named different articles on the two feeds (spec 03 §9 last bullet). Both
 * associations are kept on the survivor; only the survivor's established mapping keeps the GUID.
 */
export interface FeedGuidConflict {
  guid: string;
  /** The survivor's article, which keeps the GUID. */
  keptArticleId: string;
  /** The retired feed's article, now carried by the survivor under another (or no) GUID. */
  movedArticleId: string;
}

export interface FeedMergeResult {
  /** The live feed that now carries the identity. */
  survivorId: string;
  /**
   * Articles whose association is **new** on the survivor (the retired feed carried them and the
   * survivor did not), ascending: the caller applies the spec 03 §7 new-carrier continuation.
   */
  movedArticleIds: string[];
  /** Active subscribers of either feed, in UUID order; each got a full rank. */
  affectedUserIds: string[];
  /** GUID collisions that were reported instead of deleting an article. */
  guidConflicts: FeedGuidConflict[];
}

export type PermanentRedirectResult =
  | { kind: 'renamed'; url: string; fetchUrl: string }
  | ({ kind: 'merged' } & FeedMergeResult)
  | { kind: 'unchanged' };

/**
 * A 301/308 chain on the feed fetch ended at a new canonical URL (spec 03 §9). Call it at the start
 * of its own worker transaction, before other writes to feed rows (the merge locks users before
 * feeds).
 * - A merged tombstone, a missing feed, or an unchanged `url`/`fetch_url`: `unchanged`.
 * - No other feed has the URL: `feeds.url` becomes the canonical URL and `fetch_url` the redirect
 *   target (`renamed`). If another feed takes the URL concurrently, the rename's unique conflict is
 *   rolled back to a savepoint and the redirect merges into that feed instead.
 * - Another feed has it: this feed merges into that feed's live root (`merged`, see `mergeFeeds`).
 *   When the URL belongs to a tombstone already merged into **this** feed, identity stays and only
 *   `fetch_url` follows the redirect (`renamed` with the unchanged `url`).
 */
export async function applyPermanentRedirect(
  tx: Transaction,
  sender: JobSender,
  feedId: string,
  target: { canonicalUrl: string; fetchUrl: string },
): Promise<PermanentRedirectResult> {
  for (let attempt = 1; ; attempt += 1) {
    const current = await tx.execute<{
      url: string;
      fetch_url: string;
      merged_into_id: string | null;
    }>(sql`
      SELECT url, fetch_url, merged_into_id::text AS merged_into_id
        FROM feeds WHERE id = ${feedId}::bigint`);
    const feed = current.rows[0];
    if (feed === undefined || feed.merged_into_id !== null) return { kind: 'unchanged' };

    const owner = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM feeds
       WHERE url = ${target.canonicalUrl} AND id <> ${feedId}::bigint`);
    const ownerId = owner.rows[0]?.id;
    if (ownerId === undefined) {
      if (feed.url === target.canonicalUrl && feed.fetch_url === target.fetchUrl) {
        return { kind: 'unchanged' };
      }
      try {
        return await tx.transaction(async (savepoint) =>
          renameFeed(savepoint, feedId, target.canonicalUrl, target.fetchUrl),
        );
      } catch (error) {
        // Unique conflict: a feed with this URL was just created. Merge into it on the next pass.
        if (sqlState(error) !== '23505' || attempt >= 2) throw error;
        continue;
      }
    }

    const survivorId = await resolveLiveFeedId(tx, ownerId);
    if (survivorId === null) {
      throw new Error(`feed ${ownerId} has a missing or cyclic merge chain`);
    }
    if (survivorId === feedId) {
      if (feed.fetch_url === target.fetchUrl) return { kind: 'unchanged' };
      return renameFeed(tx, feedId, feed.url, target.fetchUrl);
    }
    return { kind: 'merged', ...(await mergeFeeds(tx, sender, feedId, survivorId)) };
  }
}

async function renameFeed(
  tx: Transaction,
  feedId: string,
  url: string,
  fetchUrl: string,
): Promise<PermanentRedirectResult> {
  const updated = await tx.execute<{ url: string; fetch_url: string }>(sql`
    UPDATE feeds SET url = ${url}, fetch_url = ${fetchUrl}, updated_at = now()
     WHERE id = ${feedId}::bigint AND merged_into_id IS NULL
    RETURNING url, fetch_url`);
  const row = updated.rows[0];
  return row === undefined
    ? { kind: 'unchanged' }
    : { kind: 'renamed', url: row.url, fetchUrl: row.fetch_url };
}

/**
 * Merge feed `sourceId` into the live root of `targetId` (spec 03 §9; spec 02 §3.3–§3.5), in the
 * caller's worker transaction:
 * 1. Lock every affected user (UUID order), then both feed rows (ascending id, `FOR NO KEY
 *    UPDATE`); recheck the source (already merged → the idempotent result, nothing recreated) and
 *    follow the target to its live root. Never merge a feed into itself or into a tombstone.
 * 2. Subscriptions (rows of both feeds locked): a duplicate keeps the target's title/folder, the
 *    earliest `created_at`, `hidden = source AND target`, `allow_duplicates = source OR target`,
 *    the more restrictive inference mode (`off`, then `training`, then `active`), the later
 *    activation when both stay `active`, and an `inference_version` beyond both. A source-only
 *    subscription is re-created on the target with its settings and mode, the next version and,
 *    when `active`, a new activation boundary at the merge time: the target's earlier items and the
 *    moved items that arrived before the merge become history for it. Merging never enables or
 *    backfills inference.
 * 3. `analysis_requests`: pending/running generations of the retired feed and of every merged
 *    duplicate subscription are cancelled (`feed_merged`); all of the retired feed's requests move
 *    to the survivor, so completed training history is kept.
 * 4. Scoped cards are re-pointed before the source subscriptions are deleted (the composite FK
 *    cascades on delete).
 * 5. Feed items move; a duplicate keeps the earliest `first_seen_at` and a non-conflicting GUID; a
 *    GUID naming another article on the survivor keeps both associations with only the survivor's
 *    mapping and is reported (`guidConflicts`), never deleting an article.
 * 6. Feed rules (`block_feed`/`boost_feed` values) are re-pointed and deduplicated per user, eval
 *    rater feeds re-pointed when the `eval` schema exists, image preferences remapped (`block` over
 *    `allow` over `inherit`) and bookmark origins remapped.
 * 7. The source becomes a tombstone (`merged_into_id`, `dead`, no validators); both feeds' subscriber
 *    counts and `feed_cards` are refreshed, and every affected active subscriber gets a full rank.
 *
 * The survivor's own fetch state and status are left as they are.
 * @throws Error when a feed is missing, the chain is corrupt, or the merge would target itself.
 */
export async function mergeFeeds(
  tx: Transaction,
  sender: JobSender,
  sourceId: string,
  targetId: string,
): Promise<FeedMergeResult> {
  const source = await feedPointer(tx, sourceId);
  if (source === undefined) throw new Error(`feed ${sourceId} does not exist`);
  if (source.mergedIntoId !== null) return alreadyMerged(tx, sourceId);
  let survivorId = await resolveLiveFeedId(tx, targetId);
  if (survivorId === null) throw new Error(`feed ${targetId} is missing or its chain is cyclic`);
  if (survivorId === sourceId) throw new Error(`feed ${sourceId} cannot be merged into itself`);

  // 1. Users in UUID order, then both feeds in ascending id order.
  const lockedUsers = new Set(
    await lockUsers(tx, await referencingUserIds(tx, sourceId, survivorId)),
  );
  const pointers = await lockFeeds(tx, [sourceId, survivorId]);
  const sourcePointer = pointers.get(sourceId);
  if (sourcePointer === undefined) throw new Error(`feed ${sourceId} does not exist`);
  if (sourcePointer !== null) return alreadyMerged(tx, sourceId);
  const visited = new Set([sourceId]);
  let next = pointers.get(survivorId);
  while (next !== null) {
    // The target was merged meanwhile: follow it to the live root and lock that too.
    if (next === undefined) throw new Error(`feed ${survivorId} does not exist`);
    visited.add(survivorId);
    if (visited.has(next))
      throw new Error(`feed ${targetId} has a cyclic merge chain or is the source`);
    survivorId = next;
    next = (await lockFeeds(tx, [survivorId])).get(survivorId);
  }
  // Subscribers are stable under the feed locks (subscribe/unsubscribe lock the feed rows too). One
  // whose subscription committed after the first read, or who belongs to a followed root, is locked
  // now, after the feeds; the rare cycle this can form with another in-flight mutation of that user
  // ends in a deadlock error (40P01), which `retryTransaction` retries.
  const lateUsers = (await subscriberUserIds(tx, [sourceId, survivorId])).filter(
    (userId) => !lockedUsers.has(userId),
  );
  await lockUsers(tx, lateUsers);
  const affectedUserIds = await activeSubscriberIds(tx, [sourceId, survivorId]);

  const src = sql`${sourceId}::bigint`;
  const dst = sql`${survivorId}::bigint`;

  // 2. Subscriptions: duplicates first, then the source-only rows (new target rows).
  await tx.execute(sql`
    SELECT 1 FROM subscriptions WHERE feed_id IN (${src}, ${dst})
     ORDER BY user_id, feed_id FOR UPDATE`);
  const duplicates = await tx.execute<{ user_id: string }>(sql`
    UPDATE subscriptions t
       SET created_at = least(t.created_at, s.created_at),
           hidden = s.hidden AND t.hidden,
           allow_duplicates = s.allow_duplicates OR t.allow_duplicates,
           inference_mode = CASE WHEN 'off' IN (s.inference_mode, t.inference_mode) THEN 'off'
                                 WHEN 'training' IN (s.inference_mode, t.inference_mode) THEN 'training'
                                 ELSE 'active' END,
           inference_activated_at =
             CASE WHEN s.inference_mode = 'active' AND t.inference_mode = 'active'
                  THEN greatest(s.inference_activated_at, t.inference_activated_at) END,
           inference_version = greatest(s.inference_version, t.inference_version) + 1
      FROM subscriptions s
     WHERE s.feed_id = ${src} AND t.feed_id = ${dst} AND t.user_id = s.user_id
    RETURNING t.user_id::text AS user_id`);
  await tx.execute(sql`
    INSERT INTO subscriptions (user_id, feed_id, title_override, folder, allow_duplicates, hidden,
                               inference_mode, inference_version, inference_activated_at, created_at)
    SELECT s.user_id, ${dst}, s.title_override, s.folder, s.allow_duplicates, s.hidden,
           s.inference_mode, s.inference_version + 1,
           CASE WHEN s.inference_mode = 'active' THEN now() END, s.created_at
      FROM subscriptions s
     WHERE s.feed_id = ${src}
       AND NOT EXISTS (SELECT 1 FROM subscriptions t WHERE t.feed_id = ${dst} AND t.user_id = s.user_id)`);

  // 3. Selected-article requests: cancel old generations, then move all of them (history kept).
  const duplicateUsers = duplicates.rows.map((row) => row.user_id);
  await tx.execute(sql`
    UPDATE analysis_requests
       SET status = 'cancelled', completed_at = now(), lease_token = NULL, lease_until = NULL,
           last_error_code = ${FEED_MERGE_CANCEL_CODE}
     WHERE status IN ('pending', 'running')
       AND (feed_id = ${src}
            OR (feed_id = ${dst} AND user_id = ANY(${sql.param(duplicateUsers)}::uuid[])))`);
  await tx.execute(sql`UPDATE analysis_requests SET feed_id = ${dst} WHERE feed_id = ${src}`);

  // 4. Scoped cards follow the subscription before the source rows (and their cascade) go.
  await tx.execute(sql`
    UPDATE user_cards SET scope_feed_id = ${dst}, updated_at = now() WHERE scope_feed_id = ${src}`);
  await tx.execute(sql`DELETE FROM subscriptions WHERE feed_id = ${src}`);

  // 5a. Linkless identities are scoped to their feed: give every such key of the retired feed a
  //     survivor-scoped alias, so the survivor's next fetch of a guidless linkless item finds the
  //     moved article instead of inserting a duplicate (an item with a GUID also matches through
  //     its moved feed-scoped GUID). Taken before the items move, under the ingestion url key locks.
  await aliasLinklessKeys(tx, sourceId, survivorId);

  // 5. Feed items. A GUID conflict is what the per-feed unique index (feed_id, md5(guid)) sees
  //    (D-15), so a moved or adopted GUID never violates it.
  const conflicts = await tx.execute<{
    guid: string;
    kept_article_id: string;
    moved_article_id: string;
  }>(sql`
    SELECT s.guid, t.article_id::text AS kept_article_id, s.article_id::text AS moved_article_id
      FROM feed_items s
      JOIN feed_items t ON t.feed_id = ${dst} AND t.guid IS NOT NULL
                       AND md5(t.guid) = md5(s.guid) AND t.article_id <> s.article_id
     WHERE s.feed_id = ${src} AND s.guid IS NOT NULL
     ORDER BY s.guid, s.article_id`);
  await tx.execute(sql`
    UPDATE feed_items t
       SET first_seen_at = least(t.first_seen_at, s.first_seen_at),
           guid = coalesce(t.guid,
                           CASE WHEN NOT EXISTS (SELECT 1 FROM feed_items o
                                                  WHERE o.feed_id = ${dst} AND o.guid IS NOT NULL
                                                    AND md5(o.guid) = md5(s.guid))
                                THEN s.guid END)
      FROM feed_items s
     WHERE s.feed_id = ${src} AND t.feed_id = ${dst} AND t.article_id = s.article_id`);
  await tx.execute(sql`
    DELETE FROM feed_items s
     WHERE s.feed_id = ${src}
       AND EXISTS (SELECT 1 FROM feed_items t WHERE t.feed_id = ${dst} AND t.article_id = s.article_id)`);
  const moved = await tx.execute<{ article_id: string }>(sql`
    UPDATE feed_items s
       SET feed_id = ${dst},
           guid = CASE WHEN EXISTS (SELECT 1 FROM feed_items t
                                     WHERE t.feed_id = ${dst} AND t.guid IS NOT NULL
                                       AND md5(t.guid) = md5(s.guid))
                       THEN NULL ELSE s.guid END
     WHERE s.feed_id = ${src}
    RETURNING s.article_id::text AS article_id`);

  // 6. Rules, eval references, image preferences, bookmark origins.
  const repointed = await tx.execute<{ user_id: string }>(sql`
    UPDATE user_rules SET value = (${dst})::text
     WHERE kind IN ('block_feed', 'boost_feed') AND value = (${src})::text
    RETURNING user_id::text AS user_id`);
  const ruleUsers = [...new Set(repointed.rows.map((row) => row.user_id))];
  if (ruleUsers.length > 0) {
    // Identical rules collapse to one per user and kind: the longest-lived, then the oldest.
    await tx.execute(sql`
      DELETE FROM user_rules r
       USING (SELECT id,
                     row_number() OVER (PARTITION BY user_id, kind
                                        ORDER BY expires_at IS NULL DESC, expires_at DESC,
                                                 created_at, id) AS rn
                FROM user_rules
               WHERE kind IN ('block_feed', 'boost_feed') AND value = (${dst})::text
                 AND user_id = ANY(${sql.param(ruleUsers)}::uuid[])) d
       WHERE r.id = d.id AND d.rn > 1`);
  }
  await remapEvalFeeds(tx, sourceId, survivorId);
  // A conflict keeps the stricter explicit choice: the survivor's row takes the source's policy
  // only when that one is stricter (block > allow > inherit).
  await tx.execute(sql`
    UPDATE user_feed_preferences t SET image_policy = s.image_policy, updated_at = now()
      FROM user_feed_preferences s
     WHERE s.feed_id = ${src} AND t.feed_id = ${dst} AND t.user_id = s.user_id
       AND array_position(ARRAY['inherit', 'allow', 'block'], s.image_policy)
           > array_position(ARRAY['inherit', 'allow', 'block'], t.image_policy)`);
  await tx.execute(sql`
    DELETE FROM user_feed_preferences s
     WHERE s.feed_id = ${src}
       AND EXISTS (SELECT 1 FROM user_feed_preferences t WHERE t.feed_id = ${dst} AND t.user_id = s.user_id)`);
  await tx.execute(sql`UPDATE user_feed_preferences SET feed_id = ${dst} WHERE feed_id = ${src}`);
  await tx.execute(sql`
    UPDATE user_article SET bookmark_origin_feed_id = ${dst} WHERE bookmark_origin_feed_id = ${src}`);

  // 7. Tombstone, materializations, full ranks.
  await tx.execute(sql`
    UPDATE feeds
       SET merged_into_id = ${dst}, status = 'dead', etag = NULL, last_modified = NULL,
           updated_at = now()
     WHERE id = ${src}`);
  const feedIds = sql.param([sourceId, survivorId]);
  await tx.execute(sql`
    SELECT refresh_feed_subscribers(${feedIds}::bigint[],
                                    ${JSON.stringify(planMinIntervalMap())}::jsonb)`);
  await tx.execute(sql`SELECT refresh_feed_cards(${feedIds}::bigint[])`);
  await recordRankIntents(tx, sender, affectedUserIds, {
    reason: FEED_MERGE_RANK_REASON,
    full: true,
  });

  return {
    survivorId,
    movedArticleIds: moved.rows
      .map((row) => row.article_id)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
    affectedUserIds,
    guidConflicts: conflicts.rows.map((row) => ({
      guid: row.guid,
      keptArticleId: row.kept_article_id,
      movedArticleId: row.moved_article_id,
    })),
  };
}

/** The idempotent result for a source that is already a tombstone: nothing is recreated. */
/**
 * Survivor-scoped aliases for the linkless keys (spec 03 §5 step 8) of the articles the retired
 * feed carries, whether the key is the article's `url_key` or one of its aliases: the same item
 * hash under the survivor's feed id. The keys are locked in the sorted ingestion order before both
 * identity tables are rechecked (spec 03 §7 "Concurrency"); a key that already names an article
 * (the survivor carried the same item as its own article) is left to that article.
 */
async function aliasLinklessKeys(
  tx: Transaction,
  sourceId: string,
  survivorId: string,
): Promise<void> {
  const prefix = `${LINKLESS_KEY_PREFIX}${sourceId}:`;
  const keys = await tx.execute<{ url_key: string; article_id: string }>(sql`
    SELECT a.url_key, a.id::text AS article_id
      FROM feed_items fi JOIN articles a ON a.id = fi.article_id
     WHERE fi.feed_id = ${sourceId}::bigint AND starts_with(a.url_key, ${prefix})
    UNION
    SELECT al.url_key, al.article_id::text
      FROM feed_items fi JOIN article_aliases al ON al.article_id = fi.article_id
     WHERE fi.feed_id = ${sourceId}::bigint AND starts_with(al.url_key, ${prefix})`);
  if (keys.rows.length === 0) return;
  const aliases = keys.rows.map((row) => ({
    articleId: row.article_id,
    key: `${LINKLESS_KEY_PREFIX}${survivorId}:${row.url_key.slice(prefix.length)}`,
  }));
  await lockUrlKeys(
    tx,
    aliases.map((alias) => alias.key),
  );
  for (const { articleId, key } of aliases) {
    await tx.execute(sql`
      INSERT INTO article_aliases (url_key, article_id, source)
      SELECT ${key}, ${articleId}::bigint, 'feed_link'
       WHERE NOT EXISTS (SELECT 1 FROM articles WHERE url_key = ${key})
      ON CONFLICT (url_key) DO NOTHING`);
  }
}

async function alreadyMerged(tx: Executor, sourceId: string): Promise<FeedMergeResult> {
  const survivorId = await resolveLiveFeedId(tx, sourceId);
  if (survivorId === null) throw new Error(`feed ${sourceId} has a cyclic merge chain`);
  return { survivorId, movedArticleIds: [], affectedUserIds: [], guidConflicts: [] };
}

async function feedPointer(
  tx: Executor,
  feedId: string,
): Promise<{ mergedIntoId: string | null } | undefined> {
  const result = await tx.execute<{ merged_into_id: string | null }>(sql`
    SELECT merged_into_id::text AS merged_into_id FROM feeds WHERE id = ${feedId}::bigint`);
  const row = result.rows[0];
  return row === undefined ? undefined : { mergedIntoId: row.merged_into_id };
}

/**
 * Users whose rows a merge of these feeds changes or ranks: subscribers of either feed and owners of
 * the source's image preferences, requests, bookmark origins and feed rules, in UUID order.
 */
async function referencingUserIds(
  tx: Executor,
  sourceId: string,
  targetId: string,
): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id FROM (
      SELECT user_id FROM subscriptions WHERE feed_id IN (${sourceId}::bigint, ${targetId}::bigint)
      UNION SELECT user_id FROM user_feed_preferences WHERE feed_id = ${sourceId}::bigint
      UNION SELECT user_id FROM analysis_requests WHERE feed_id = ${sourceId}::bigint
      UNION SELECT user_id FROM user_article WHERE bookmark_origin_feed_id = ${sourceId}::bigint
      UNION SELECT user_id FROM user_rules
             WHERE kind IN ('block_feed', 'boost_feed') AND value = (${sourceId}::bigint)::text
    ) u
    ORDER BY user_id`);
  return result.rows.map((row) => row.user_id);
}

/** Every subscriber of the feeds (deleted accounts included: their rows move too), in UUID order. */
async function subscriberUserIds(tx: Executor, feedIds: readonly string[]): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT user_id::text AS user_id FROM subscriptions
     WHERE feed_id = ANY(${sql.param([...feedIds])}::bigint[])
     ORDER BY 1`);
  return result.rows.map((row) => row.user_id);
}

/** Lock user rows in UUID order (spec 02 §6 "Callers": users first, then feeds). */
async function lockUsers(tx: Executor, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const result = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM users WHERE id = ANY(${sql.param([...userIds])}::uuid[])
     ORDER BY id FOR NO KEY UPDATE`);
  return result.rows.map((row) => row.id);
}

/** Lock feed rows in ascending id order; returns each found feed's `merged_into_id`. */
async function lockFeeds(
  tx: Executor,
  feedIds: readonly string[],
): Promise<Map<string, string | null>> {
  const result = await tx.execute<{ id: string; merged_into_id: string | null }>(sql`
    SELECT id::text AS id, merged_into_id::text AS merged_into_id FROM feeds
     WHERE id = ANY(${sql.param([...feedIds])}::bigint[])
     ORDER BY id FOR NO KEY UPDATE`);
  return new Map(result.rows.map((row) => [row.id, row.merged_into_id]));
}

/**
 * Re-point `eval.rater_feeds` (spec 02 §7) when the evaluation schema exists (it is created in M3a;
 * the statements are only sent then). A rater who already has the survivor keeps one row.
 */
async function remapEvalFeeds(tx: Transaction, sourceId: string, targetId: string): Promise<void> {
  const present = await tx.execute<{ present: boolean }>(sql`
    SELECT to_regclass('eval.rater_feeds') IS NOT NULL AS present`);
  if (present.rows[0]?.present !== true) return;
  await tx.execute(sql`
    UPDATE eval.rater_feeds s SET feed_id = ${targetId}::bigint
     WHERE s.feed_id = ${sourceId}::bigint
       AND NOT EXISTS (SELECT 1 FROM eval.rater_feeds t
                        WHERE t.rater_id = s.rater_id AND t.feed_id = ${targetId}::bigint)`);
  await tx.execute(sql`DELETE FROM eval.rater_feeds WHERE feed_id = ${sourceId}::bigint`);
}
