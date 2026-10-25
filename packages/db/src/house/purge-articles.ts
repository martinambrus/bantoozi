import { parseStoredSetting, DEFAULT_RANKER_CONFIG, mergeRankerConfig } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { EVAL_USER_EMAIL } from '../eval/system-user.js';
import { reconcileClusters } from '../ingest/clusters.js';
import { readStoredSetting } from '../settings.js';
import {
  bigintArray,
  collectableSnapshot,
  daysBefore,
  deleteSnapshotsOfArticles,
} from './snapshots.js';

/** Days after an article's latest carrier arrival at which it may be purged (spec 11 §5). */
export const ARTICLE_RETENTION_DAYS = 90;
/** Days after arrival at which an article nobody engaged with may be purged: rank window 14 + 7 (D-253). */
export const UNOPENED_RETENTION_DAYS = 21;
/** Days an analysis request protects its article (spec 11 §5, the engine-call retention). */
export const ANALYSIS_PROTECTION_DAYS = 180;
/** Floor of the days a dislike protects its article; `max(floor, model.historyDays)` applies (D-253). */
export const DISLIKE_PROTECTION_DAYS = 180;
/** Days a feed with no subscriber is kept for a re-subscription (spec 11 §5). */
export const FEED_IDLE_DAYS = 30;

/** The purge rule that makes an article deletable (D-253). */
export type PurgeRule = 'unopened21' | 'dislike' | 'normal90';

export type PurgeByRule = Record<PurgeRule, number>;

export const emptyPurgeByRule = (): PurgeByRule => ({ unopened21: 0, dislike: 0, normal90: 0 });

export interface PurgeArticlesPage {
  /** Articles examined (past the retention cutoff and unlocked); fewer than `limit` ends the pass. */
  examined: number;
  deleted: number;
  /** Of `deleted`, by the rule that allowed it. */
  byRule: PurgeByRule;
  /** The last examined article id, the keyset cursor of the next page. */
  lastId: string | null;
}

/** Days a dislike protects: `max(180, model.historyDays)` of the stored ranker thresholds (D-253). */
export async function dislikeProtectionDays(tx: Transaction): Promise<number> {
  let historyDays: number = DEFAULT_RANKER_CONFIG.model.historyDays;
  try {
    historyDays = mergeRankerConfig(
      parseStoredSetting(
        'ranker.thresholds',
        (await readStoredSetting(tx, 'ranker.thresholds')) ?? {},
      ),
    ).model.historyDays;
  } catch {
    // An invalid stored override falls back to the defaults, as the ranker does.
  }
  return Math.max(DISLIKE_PROTECTION_DAYS, historyDays);
}

/**
 * Candidates of one purge pass: articles whose arrival (the latest `feed_items.last_seen_at`, else
 * `first_seen_at`) is at least 21 days old, in id order after `after`. The 21-day cutoff is the
 * loosest of the rules; `classifyForPurge` applies the real one. `lock` takes the rows
 * `FOR UPDATE SKIP LOCKED` (the purge); the report reads them plainly.
 */
async function candidateIds(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
  lock: boolean,
): Promise<string[]> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT a.id::text AS id FROM articles a
     WHERE a.id > ${input.after ?? '0'}::bigint
       AND coalesce((SELECT max(fi.last_seen_at) FROM feed_items fi WHERE fi.article_id = a.id),
                    a.first_seen_at) <= ${daysBefore(input.now, UNOPENED_RETENTION_DAYS)}::timestamptz
     ORDER BY a.id LIMIT ${input.limit}
       ${lock ? sql`FOR UPDATE OF a SKIP LOCKED` : sql``}`);
  return found.rows.map((row) => row.id);
}

/**
 * The single place the retention rules live (D-253): which of the given articles are deletable at
 * `now`, and by which rule. Used by the purge and by `worker-cli purge-report`.
 *
 * Holds first, all unchanged: a non-collectable snapshot, an analysis request under 180 days, any
 * evaluation reference. A bookmark, label or like keeps the article forever. Then, by what readers did:
 * - a dislike without those (`dislike`): 90 days after arrival and `max(180, historyDays)` days after
 *   the latest dislike;
 * - opened, individually read, or once bookmarked, labelled or rated even if later cleared
 *   (`article_engagement`, written by a trigger on the engagement events and so durable past the 365-day
 *   retention of those events; a bulk `mark_read` is not engagement) or carried by an evaluation feed
 *   (`normal90`): 90 days after arrival;
 * - nobody engaged (`unopened21`): 21 days after arrival.
 */
export async function classifyForPurge(
  tx: Transaction,
  input: { now: Date; ids: readonly string[]; dislikeDays: number },
): Promise<Array<{ id: string; rule: PurgeRule }>> {
  if (input.ids.length === 0) return [];
  const result = await tx.execute<{ id: string; rule: PurgeRule | null }>(sql`
    SELECT a.id::text AS id,
           CASE
             WHEN u.strong THEN NULL
             WHEN u.disliked THEN CASE WHEN arr.at <= ${daysBefore(input.now, ARTICLE_RETENTION_DAYS)}::timestamptz
                                        AND u.disliked_at <= ${daysBefore(input.now, input.dislikeDays)}::timestamptz
                                       THEN 'dislike' END
             WHEN u.opened OR EXISTS (SELECT 1 FROM article_engagement e WHERE e.article_id = a.id) OR ev.carried
               THEN CASE WHEN arr.at <= ${daysBefore(input.now, ARTICLE_RETENTION_DAYS)}::timestamptz
                         THEN 'normal90' END
             WHEN arr.at <= ${daysBefore(input.now, UNOPENED_RETENTION_DAYS)}::timestamptz THEN 'unopened21'
           END AS rule
      FROM articles a
     CROSS JOIN LATERAL (
       SELECT coalesce(max(fi.last_seen_at), a.first_seen_at) AS at
         FROM feed_items fi WHERE fi.article_id = a.id) arr
     CROSS JOIN LATERAL (
       SELECT coalesce(bool_or(ua.bookmarked_at IS NOT NULL OR cardinality(ua.label_ids) > 0
                               OR ua.rating = 1), false) AS strong,
              coalesce(bool_or(ua.rating = -1), false) AS disliked,
              max(ua.rated_at) FILTER (WHERE ua.rating = -1) AS disliked_at,
              coalesce(bool_or(ua.opened_at IS NOT NULL), false) AS opened
         FROM user_article ua WHERE ua.article_id = a.id) u
     CROSS JOIN LATERAL (
       SELECT EXISTS (
         SELECT 1 FROM feed_items fi
          WHERE fi.article_id = a.id
            AND (EXISTS (SELECT 1 FROM eval.rater_feeds rf WHERE rf.feed_id = fi.feed_id)
                 OR EXISTS (SELECT 1 FROM subscriptions s JOIN users eu ON eu.id = s.user_id
                             WHERE s.feed_id = fi.feed_id AND eu.email = ${EVAL_USER_EMAIL}))) AS carried) ev
     WHERE a.id = ANY(${bigintArray(input.ids)})
       AND NOT EXISTS (SELECT 1 FROM article_snapshots s WHERE s.article_id = a.id
                        AND NOT coalesce(${collectableSnapshot(input.now)}, false))
       AND NOT EXISTS (SELECT 1 FROM analysis_requests r WHERE r.article_id = a.id
                        AND r.created_at > ${daysBefore(input.now, ANALYSIS_PROTECTION_DAYS)}::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM eval.sample e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.assignments e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.ratings e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.facet_labels e WHERE e.article_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM eval.run_answers e WHERE e.article_id = a.id)`);
  const out: Array<{ id: string; rule: PurgeRule }> = [];
  for (const row of result.rows) if (row.rule !== null) out.push({ id: row.id, rule: row.rule });
  return out;
}

/**
 * Purges one page of articles under the D-253 rules (see `classifyForPurge`): locks the candidates
 * `FOR UPDATE SKIP LOCKED`, deletes the deletable ones with their collectable snapshots (the
 * article cascades) and reconciles the clusters they left.
 */
export async function purgeArticlesPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<PurgeArticlesPage> {
  const ids = await candidateIds(tx, input, true);
  const byRule = emptyPurgeByRule();
  if (ids.length === 0) return { examined: 0, deleted: 0, byRule, lastId: null };
  await tx.execute(sql`
    SELECT id FROM article_snapshots WHERE article_id = ANY(${bigintArray(ids)}) ORDER BY id FOR UPDATE`);
  const deletable = await classifyForPurge(tx, {
    now: input.now,
    ids,
    dislikeDays: await dislikeProtectionDays(tx),
  });
  const doomed = deletable.map((row) => row.id);
  let deleted = 0;
  if (doomed.length > 0) {
    await deleteSnapshotsOfArticles(tx, doomed);
    const removed = await tx.execute<{ id: string; cluster: string | null }>(sql`
      DELETE FROM articles WHERE id = ANY(${bigintArray(doomed)})
      RETURNING id::text AS id, story_cluster_id::text AS cluster`);
    deleted = removed.rowCount ?? 0;
    const ruleOf = new Map(deletable.map((row) => [row.id, row.rule]));
    for (const row of removed.rows) {
      const rule = ruleOf.get(row.id);
      if (rule !== undefined) byRule[rule] += 1;
    }
    await reconcileClusters(
      tx,
      removed.rows.map((row) => row.cluster),
    );
  }
  return { examined: ids.length, deleted, byRule, lastId: ids.at(-1) ?? null };
}

/**
 * What `purgeArticlesPage` would delete, by rule, over every article: the same candidates and the
 * same `classifyForPurge`, no lock and no delete (`worker-cli purge-report`).
 */
export async function purgeReport(
  tx: Transaction,
  input: { now: Date; limit?: number },
): Promise<PurgeByRule> {
  const limit = input.limit ?? 500;
  const byRule = emptyPurgeByRule();
  const dislikeDays = await dislikeProtectionDays(tx);
  let after: string | null = null;
  for (;;) {
    const ids = await candidateIds(tx, { now: input.now, after, limit }, false);
    for (const row of await classifyForPurge(tx, { now: input.now, ids, dislikeDays })) {
      byRule[row.rule] += 1;
    }
    if (ids.length < limit) return byRule;
    after = ids.at(-1) ?? null;
  }
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
