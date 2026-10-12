import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { reconcileClusters } from '../ingest/clusters.js';
import {
  bigintArray,
  collectableSnapshot,
  daysBefore,
  deleteSnapshotsOfArticles,
} from './snapshots.js';

/** Days after an article's latest carrier arrival at which it may be purged (spec 11 §5). */
export const ARTICLE_RETENTION_DAYS = 90;
/** Days an analysis request protects its article (spec 11 §5, the engine-call retention). */
export const ANALYSIS_PROTECTION_DAYS = 180;
/** Days a feed with no subscriber is kept for a re-subscription (spec 11 §5). */
export const FEED_IDLE_DAYS = 30;

export interface PurgeArticlesPage {
  /** Articles examined (past the retention cutoff and unlocked); fewer than `limit` ends the pass. */
  examined: number;
  deleted: number;
  /** The last examined article id, the keyset cursor of the next page. */
  lastId: string | null;
}

/**
 * Purges one page of articles past 90 days after their latest carrier arrival (spec 11 §5): locks
 * them `FOR UPDATE SKIP LOCKED`, keeps any with a bookmark, rating or label, a snapshot that is not
 * collectable, an analysis request under 180 days or a golden-set reference, deletes their
 * collectable snapshots and the article (which cascades) and reconciles the clusters it left.
 */
export async function purgeArticlesPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<PurgeArticlesPage> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id > ${input.after ?? '0'}::bigint
       AND coalesce((SELECT max(fi.first_seen_at) FROM feed_items fi WHERE fi.article_id = a.id),
                    a.first_seen_at) <= ${daysBefore(input.now, ARTICLE_RETENTION_DAYS)}::timestamptz
     ORDER BY a.id LIMIT ${input.limit}
       FOR UPDATE OF a SKIP LOCKED`);
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return { examined: 0, deleted: 0, lastId: null };
  await tx.execute(sql`
    SELECT id FROM article_snapshots WHERE article_id = ANY(${bigintArray(ids)}) ORDER BY id FOR UPDATE`);
  const deletable = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id = ANY(${bigintArray(ids)})
       AND NOT EXISTS (SELECT 1 FROM user_article ua WHERE ua.article_id = a.id
                        AND (ua.bookmarked_at IS NOT NULL OR ua.rating IS NOT NULL
                             OR cardinality(ua.label_ids) > 0))
       AND NOT EXISTS (SELECT 1 FROM article_snapshots s WHERE s.article_id = a.id
                        AND NOT coalesce(${collectableSnapshot(input.now)}, false))
       AND NOT EXISTS (SELECT 1 FROM analysis_requests r WHERE r.article_id = a.id
                        AND r.created_at > ${daysBefore(input.now, ANALYSIS_PROTECTION_DAYS)}::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM eval.sample e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.assignments e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.ratings e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.facet_labels e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.run_answers e WHERE e.article_id = a.id)`);
  const doomed = deletable.rows.map((row) => row.id);
  let deleted = 0;
  if (doomed.length > 0) {
    await deleteSnapshotsOfArticles(tx, doomed);
    const removed = await tx.execute<{ cluster: string | null }>(sql`
      DELETE FROM articles WHERE id = ANY(${bigintArray(doomed)})
      RETURNING story_cluster_id::text AS cluster`);
    deleted = removed.rowCount ?? 0;
    await reconcileClusters(
      tx,
      removed.rows.map((row) => row.cluster),
    );
  }
  return { examined: ids.length, deleted, lastId: ids.at(-1) ?? null };
}

/**
 * Deletes one page of story clusters with no member article (spec 11 §5): merges leave empty
 * losers, so every cluster is checked, not just those the purge touched. A cluster an unexpired
 * `mute_story` rule names is kept until the rule goes.
 */
export async function purgeEmptyClustersPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<{ examined: number; deleted: number; lastId: string | null }> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT c.id::text AS id FROM story_clusters c
     WHERE c.id > ${input.after ?? '0'}::bigint
       AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.story_cluster_id = c.id)
     ORDER BY c.id LIMIT ${input.limit}
       FOR UPDATE OF c SKIP LOCKED`);
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return { examined: 0, deleted: 0, lastId: null };
  const removed = await tx.execute(sql`
    DELETE FROM story_clusters c
     WHERE c.id = ANY(${bigintArray(ids)})
       AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.story_cluster_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM user_rules r WHERE r.kind = 'mute_story' AND r.value = c.id::text
                        AND (r.expires_at IS NULL OR r.expires_at > ${input.now.toISOString()}::timestamptz))`);
  return { examined: ids.length, deleted: removed.rowCount ?? 0, lastId: ids.at(-1) ?? null };
}

/**
 * Deletes one page of idle feeds (spec 11 §5): no subscriber for 30 days and nothing referencing
 * the feed (no subscription, carrier row, analysis request, golden-set rater feed, merged child or
 * allow/block image preference). Inherit-only preference rows go with it.
 */
export async function purgeIdleFeedsPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<{ examined: number; deleted: number; lastId: string | null }> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT f.id::text AS id FROM feeds f
     WHERE f.id > ${input.after ?? '0'}::bigint AND f.subscriber_count = 0
       AND f.unsubscribed_at <= ${daysBefore(input.now, FEED_IDLE_DAYS)}::timestamptz
     ORDER BY f.id LIMIT ${input.limit}
       FOR UPDATE OF f SKIP LOCKED`);
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return { examined: 0, deleted: 0, lastId: null };
  const eligible = await tx.execute<{ id: string }>(sql`
    SELECT f.id::text AS id FROM feeds f
     WHERE f.id = ANY(${bigintArray(ids)}) AND f.subscriber_count = 0
       AND f.unsubscribed_at <= ${daysBefore(input.now, FEED_IDLE_DAYS)}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM analysis_requests r WHERE r.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM eval.rater_feeds e WHERE e.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM feeds m WHERE m.merged_into_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM user_feed_preferences u WHERE u.feed_id = f.id
                        AND u.image_policy <> 'inherit')`);
  const doomed = eligible.rows.map((row) => row.id);
  let deleted = 0;
  if (doomed.length > 0) {
    await tx.execute(
      sql`DELETE FROM user_feed_preferences WHERE feed_id = ANY(${bigintArray(doomed)})`,
    );
    const removed = await tx.execute(sql`DELETE FROM feeds WHERE id = ANY(${bigintArray(doomed)})`);
    deleted = removed.rowCount ?? 0;
  }
  return { examined: ids.length, deleted, lastId: ids.at(-1) ?? null };
}
