import { enqueueCaptureBookmark, type JobSender } from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { lockUrlKeys } from './articles.js';
import { reconcileClusters } from './clusters.js';
import { recordRankIntents } from './rank-intents.js';
import { resetArticleAnswers, type ResetNextState } from './reset.js';

/** The identity evidence of a merge (spec 03 §8.1 steps 4–5): a redirect or a declared canonical. */
export type MergeArticlesReason = 'redirect' | 'rel_canonical';

export interface MergeArticlesOptions {
  /** Recorded as the `article_aliases.source` of the source's former url_key. */
  reason: MergeArticlesReason;
}

/**
 * Why a destructive merge was deferred (spec 03 §8.4). Nothing changed: both identities are kept,
 * and the caller logs the admin conflict.
 * - `eval_reference`: evaluation data references either article; golden labels are never
 *   silently rewritten.
 * - `snapshot_conflict`: one user saved bookmark snapshots of both articles with different content
 *   (checksums); no snapshot is chosen arbitrarily while a version-preserving merge is missing.
 * - `undo_pin`: an unexpired Undo pin would lose its exact restore (see {@link mergeArticles}).
 */
export type MergeDeferralReason = 'eval_reference' | 'snapshot_conflict' | 'undo_pin';

export type MergeArticlesResult =
  | {
      status: 'merged';
      survivorId: string;
      sourceId: string;
      /** The survivor's content_revision after the reset. */
      revision: string;
      /**
       * Feeds whose feed_items association was newly created on the survivor (the caller runs the
       * §7 new-carrier continuation for each).
       */
      movedFeedIds: string[];
      /** Users whose reader state or ranking changed (full rank recorded). */
      affectedUserIds: string[];
    }
  | { status: 'deferred'; survivorId: string; sourceId: string; reason: MergeDeferralReason }
  | { status: 'noop'; reason: 'same_article' | 'missing' };

/** `analysis_requests.last_error_code` of a pending/running request cancelled by a merge. */
export const MERGED_REQUEST_ERROR_CODE = 'merged';

/** Reason of the reset and rank intents a merge records (spec 06 §7). */
export const MERGE_RANK_REASON = 'merge';

/**
 * Evaluation tables that reference `articles(id)` with `ON DELETE RESTRICT` (spec 02 §7). The
 * `eval` schema appears only in M3a, so each table is probed only when it exists.
 */
export const EVAL_ARTICLE_TABLES = [
  'sample',
  'assignments',
  'ratings',
  'facet_labels',
  'run_answers',
] as const;
type EvalArticleTable = (typeof EVAL_ARTICLE_TABLES)[number];

/**
 * `mergeArticles(sourceId, targetId)` (spec 03 §8.4): the atomic article identity merge. The
 * target — the existing owner of the final URL — survives; the source's identity, associations and
 * reader data move to it, and the source row is deleted last. Nothing is lost: every table that
 * references `articles(id)` (0001_schema) has an explicit policy below, and the source is deleted
 * only after every row whose foreign key would cascade reader data away has been moved.
 *
 * **Lock order** (one short transaction, READ COMMITTED; run it through `retryTransaction`):
 * 1. the url-key advisory locks of every source identity key (its `url_key` and aliases), in
 *    lexical order ({@link lockUrlKeys}, the ingest's lock, spec 03 §7 "Concurrency"), so an
 *    ingest of an old key waits and then resolves it to the survivor;
 * 2. the `users` rows of every reader-row owner and carrier subscriber of either article,
 *    `FOR NO KEY UPDATE` in UUID order — the documented order is user → article → reader row
 *    (0003 bookmark functions), and the full rank and the deferred label checks take these locks;
 * 3. both article rows `FOR UPDATE` in ascending id order; identity, revisions and the key and user
 *    sets are rechecked under them (no new alias, reader row or association can reference a locked
 *    article). A missing article or `source = target` is a `noop`.
 * A caller may already hold the resolved key's lock and the source row (the extraction's alias
 * check does); that is safe within its transaction, but any row lock taken before step 2 can
 * deadlock with a concurrent reader action, which PostgreSQL detects (40P01) for a retry.
 *
 * **Deferral** (nothing written): evaluation references to either article (`eval_reference`), a
 * user whose bookmarks of both articles are bound to snapshots with different checksums
 * (`snapshot_conflict`), or an unexpired Undo pin (`undo_pin`) on
 * - a snapshot of the source: its receipt names the source id, which disappears, so
 *   `restore_bookmark_snapshot` cannot find it again (relocating the snapshot's `article_id` is
 *   not enough; receipts are immutable API records and are not rewritten here);
 * - a snapshot of the target whose user also has a reader row on the source: the merge advances
 *   that row's `state_version`, so the receipt's resulting version no longer matches and the undo
 *   returns `STALE_STATE` (spec 08 §5.4).
 * A pin of a target-only reader stays restorable (the row, receipt and snapshot are unchanged), so
 * it does not defer the merge. Pins expire after ten minutes; the caller may retry after that.
 *
 * **Policies** (spec 03 §8.4):
 * - `feed_items`: moved; a feed carrying both keeps one row with the earlier `first_seen_at` and
 *   that row's GUID (else the other one: both are this pair's own, so neither conflicts).
 * - `article_aliases`: every alias moves; the source's `url_key` becomes an alias with source
 *   `options.reason` once the source row is gone. A stale alias equal to another article's
 *   `url_key` is dropped (the `articles` row already wins every lookup), and a foreign alias of
 *   the source key aborts the merge: a key never names the survivor and another article.
 * - `user_article`: a source-only row moves; a collision unions labels, keeps the earliest
 *   bookmark time, one coherent binding (snapshot, origin, capture status/error — the side with a
 *   bound snapshot, else the earlier bookmark, the target on ties), the latest open/read times,
 *   the rating/reason of the later `rated_at` (target on ties), the maximum dwell, the earliest
 *   feedback prompt, and unarchives if either copy is unarchived; suggestions are the union minus
 *   assigned labels. The surviving row's `state_version` and `bookmark_capture_generation` become
 *   one more than the larger input (an absent row counts as 0), for moved rows too, so offline
 *   actions and capture completions prepared against either pre-merge row are fenced. Every
 *   survivor row's ranking cache returns to its defaults (a target-only row changes nothing else).
 * - `feedback_events`: all repointed, none dropped.
 * - `analysis_requests`: repointed (input/result stay immutable, spec 02 §5.2); pending/running
 *   source requests are cancelled with their leases cleared (`last_error_code = 'merged'`).
 * - `match_queue`: moved with the minimum priority, oldest `enqueued_at` and maximum attempts per
 *   card, leases cleared; the reset keeps only the admitted union at the new revision, and the
 *   merged progress is then reapplied to the rows it kept (a reset alone would zero it).
 * - `article_snapshots` (RESTRICT): relocated to the survivor, content untouched, every binding
 *   and pin kept; a source snapshot whose (revision, checksum) the survivor already holds shares
 *   that identical row instead (references repointed, duplicate removed).
 * - `article_bodies`: a valid target body (status `ok` at its current revision) is kept; otherwise
 *   a valid source body is moved over (with its detected language and word count when its
 *   extraction completed). The survivor's revision first rises to at least the source's, so the
 *   reset's increment exceeds every revision either identity published (relocated snapshots,
 *   repointed selections and queued work never coincide with a later survivor revision).
 * - One `resetArticleAnswers(survivor, {reason: 'merge'})` keeps the chosen body at the new
 *   revision (`extracted` when its owner's extraction had completed, else `ingested`; a stale
 *   survivor stays stale), clears facets/answers/L2 topics/translations, re-queues the admitted
 *   union and leaves the story cluster. The source's own caches cascade with it.
 * - `story_clusters`: both articles' clusters are reconciled after the source is deleted.
 * - `engine_calls` (SET NULL): audit rows stay audit rows; like any purged article's, they detach
 *   from the retired identity (their revision numbers belong to it).
 * - A full rank is recorded for every active affected user (reader-row owners and carriers'
 *   subscribers of both articles), and a local bookmark capture when a surviving bookmark is
 *   still `pending`.
 * The source's queued jobs become no-ops (a missing article is done). The next pipeline stage is
 * not decided here: the caller runs the new-carrier continuation for `movedFeedIds` and the
 * survivor's next stage through `apps/worker/src/pipeline.ts`.
 */
export async function mergeArticles(
  tx: Transaction,
  sender: JobSender,
  sourceId: string,
  targetId: string,
  options: MergeArticlesOptions,
): Promise<MergeArticlesResult> {
  assertArticleId('sourceId', sourceId);
  assertArticleId('targetId', targetId);
  if (sourceId === targetId) return { status: 'noop', reason: 'same_article' };
  const ids = [sourceId, targetId];

  const locks = mergeLocks(tx);
  await locks.urlKeys(await identityKeys(tx, sourceId));
  await locks.users(await involvedUserIds(tx, ids));
  const articles = await lockArticles(tx, ids);
  const source = articles.get(sourceId);
  const target = articles.get(targetId);
  if (source === undefined || target === undefined) return { status: 'noop', reason: 'missing' };
  // Recheck under the article locks, which keep new aliases, reader rows and associations out.
  await locks.urlKeys(await identityKeys(tx, sourceId));
  await locks.users(await involvedUserIds(tx, ids));
  await assertSourceKeyFree(tx, source, targetId);

  const deferral = await mergeDeferral(tx, sourceId, targetId);
  if (deferral !== null) {
    return { status: 'deferred', survivorId: targetId, sourceId, reason: deferral };
  }

  const movedFeedIds = await moveFeedItems(tx, sourceId, targetId);
  await moveAliases(tx, sourceId, targetId);
  const droppedSnapshotIds = await mergeReaderRows(tx, sourceId, targetId);
  await tx.execute(sql`
    UPDATE feedback_events SET article_id = ${targetId}::bigint
     WHERE article_id = ${sourceId}::bigint`);
  await relocateAnalysisRequests(tx, sourceId, targetId);
  const queueProgress = await moveMatchQueue(tx, sourceId, targetId);
  await relocateSnapshots(tx, sourceId, targetId);
  const survivorBody = await prepareSurvivorBody(tx, source, target);

  const reset = await resetArticleAnswers(tx, sender, targetId, {
    reason: MERGE_RANK_REASON,
    nextState: survivorBody.nextState,
    ...(survivorBody.keepBody ? { keepBody: true } : {}),
  });
  if (reset.status !== 'reset') {
    // Unreachable: the survivor is locked by this transaction and no revision is expected.
    throw new Error(`mergeArticles: resetArticleAnswers returned ${reset.status}`);
  }
  await restoreQueueProgress(tx, targetId, queueProgress);

  await deleteSource(tx, sourceId);
  await addSourceKeyAlias(tx, source.urlKey, targetId, options.reason);
  await reconcileClusters(tx, [source.clusterId, target.clusterId]);

  const affectedUserIds = await activeAffectedUserIds(tx, targetId);
  await recordRankIntents(tx, sender, affectedUserIds, { reason: MERGE_RANK_REASON, full: true });
  if (await hasPendingCapture(tx, targetId)) {
    await enqueueCaptureBookmark(sender, { articleId: targetId }, { revision: reset.revision });
  }
  for (const snapshotId of droppedSnapshotIds) {
    await tx.execute(sql`SELECT mark_snapshot_if_unreferenced(${snapshotId}::bigint)`);
  }

  return {
    status: 'merged',
    survivorId: targetId,
    sourceId,
    revision: reset.revision,
    movedFeedIds,
    affectedUserIds,
  };
}

// ── Locks and rechecks ───────────────────────────────────────────────────────────────────────

const ARTICLE_ID = /^[1-9][0-9]{0,18}$/;

function assertArticleId(name: string, id: string): void {
  if (!ARTICLE_ID.test(id)) throw new RangeError(`mergeArticles: ${name} must be a decimal id`);
}

interface MergeLocks {
  urlKeys(keys: readonly string[]): Promise<void>;
  users(userIds: readonly string[]): Promise<void>;
}

/**
 * The locks a merge holds, taken once each. Keys or users that only appear in the recheck under
 * the article locks are locked late (out of order); a resulting deadlock is detected by
 * PostgreSQL (40P01) and the caller's `retryTransaction` re-runs the merge.
 */
function mergeLocks(tx: Transaction): MergeLocks {
  const lockedKeys = new Set<string>();
  const lockedUsers = new Set<string>();
  return {
    async urlKeys(keys) {
      const fresh = keys.filter((key) => !lockedKeys.has(key));
      if (fresh.length === 0) return;
      await lockUrlKeys(tx, fresh);
      for (const key of fresh) lockedKeys.add(key);
    },
    async users(userIds) {
      const fresh = userIds.filter((id) => !lockedUsers.has(id));
      if (fresh.length === 0) return;
      await tx.execute(sql`
        SELECT id FROM users WHERE id = ANY(${sql.param(fresh)}::uuid[])
         ORDER BY id FOR NO KEY UPDATE`);
      for (const id of fresh) lockedUsers.add(id);
    },
  };
}

/** The article's identity keys: its `url_key` and every alias naming it. */
async function identityKeys(tx: Transaction, articleId: string): Promise<string[]> {
  const result = await tx.execute<{ url_key: string }>(sql`
    SELECT url_key FROM articles WHERE id = ${articleId}::bigint
    UNION
    SELECT url_key FROM article_aliases WHERE article_id = ${articleId}::bigint`);
  return result.rows.map((row) => row.url_key);
}

/** Reader-row owners and carrier subscribers of the articles (deleted accounts included), sorted. */
async function involvedUserIds(tx: Transaction, articleIds: readonly string[]): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id::text AS user_id FROM user_article
     WHERE article_id = ANY(${sql.param([...articleIds])}::bigint[])
    UNION
    SELECT s.user_id::text FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id
     WHERE fi.article_id = ANY(${sql.param([...articleIds])}::bigint[])`);
  return result.rows.map((row) => row.user_id).sort();
}

interface LockedArticle {
  id: string;
  revision: string;
  pipelineState: string;
  clusterId: string | null;
  urlKey: string;
}

/** Lock the articles `FOR UPDATE` in ascending id order (spec 03 §7 "Concurrency"). */
async function lockArticles(
  tx: Transaction,
  articleIds: readonly string[],
): Promise<Map<string, LockedArticle>> {
  const result = await tx.execute<{
    id: string;
    revision: string;
    pipeline_state: string;
    story_cluster_id: string | null;
    url_key: string;
  }>(sql`
    SELECT id::text AS id, content_revision::text AS revision, pipeline_state,
           story_cluster_id::text AS story_cluster_id, url_key
      FROM articles WHERE id = ANY(${sql.param([...articleIds])}::bigint[])
     ORDER BY id FOR UPDATE`);
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        revision: row.revision,
        pipelineState: row.pipeline_state,
        clusterId: row.story_cluster_id,
        urlKey: row.url_key,
      },
    ]),
  );
}

/**
 * The cross-table identity invariant (spec 03 §7 "Concurrency"): the source's `url_key` becomes
 * the survivor's alias, so no alias may already give it to a third article. Such a row is a broken
 * invariant from elsewhere; the merge aborts rather than silently re-route the key.
 */
async function assertSourceKeyFree(
  tx: Transaction,
  source: LockedArticle,
  targetId: string,
): Promise<void> {
  const result = await tx.execute<{ article_id: string }>(sql`
    SELECT article_id::text AS article_id FROM article_aliases
     WHERE url_key = ${source.urlKey}
       AND article_id NOT IN (${source.id}::bigint, ${targetId}::bigint)`);
  if (result.rows.length > 0) {
    throw new Error(
      `mergeArticles: the source url key is also an alias of article ${result.rows[0]?.article_id ?? '?'}`,
    );
  }
}

/** The first reason that defers the merge (spec 03 §8.4), or null. */
async function mergeDeferral(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<MergeDeferralReason | null> {
  if (await referencedByEval(tx, [sourceId, targetId])) return 'eval_reference';
  const conflicts = await tx.execute<{ snapshot_conflict: boolean; undo_pin: boolean }>(sql`
    SELECT EXISTS (
             SELECT 1 FROM user_article us
               JOIN user_article ut ON ut.user_id = us.user_id AND ut.article_id = ${targetId}::bigint
               JOIN article_snapshots ss ON ss.id = us.bookmark_snapshot_id
               JOIN article_snapshots st ON st.id = ut.bookmark_snapshot_id
              WHERE us.article_id = ${sourceId}::bigint
                AND us.bookmarked_at IS NOT NULL AND ut.bookmarked_at IS NOT NULL
                AND ss.content_sha256 <> st.content_sha256) AS snapshot_conflict,
           EXISTS (
             SELECT 1 FROM bookmark_snapshot_pins p
               JOIN article_snapshots s ON s.id = p.snapshot_id
              WHERE p.expires_at > now()
                AND (s.article_id = ${sourceId}::bigint
                     OR (s.article_id = ${targetId}::bigint
                         AND EXISTS (SELECT 1 FROM user_article ua
                                      WHERE ua.user_id = p.user_id
                                        AND ua.article_id = ${sourceId}::bigint)))) AS undo_pin`);
  const row = conflicts.rows[0];
  if (row?.snapshot_conflict === true) return 'snapshot_conflict';
  if (row?.undo_pin === true) return 'undo_pin';
  return null;
}

function evalProbe(table: EvalArticleTable, articleIds: SQL): SQL {
  switch (table) {
    case 'sample':
      return sql`SELECT 1 FROM eval.sample WHERE article_id = ANY(${articleIds})`;
    case 'assignments':
      return sql`SELECT 1 FROM eval.assignments WHERE article_id = ANY(${articleIds})`;
    case 'ratings':
      return sql`SELECT 1 FROM eval.ratings WHERE article_id = ANY(${articleIds})`;
    case 'facet_labels':
      return sql`SELECT 1 FROM eval.facet_labels WHERE article_id = ANY(${articleIds})`;
    case 'run_answers':
      return sql`SELECT 1 FROM eval.run_answers WHERE article_id = ANY(${articleIds})`;
  }
}

/**
 * Whether evaluation data (spec 02 §7) references any of the articles. The catalog lookup needs no
 * privilege on the schema; only existing tables are probed, so the query also plans before M3a.
 */
async function referencedByEval(tx: Transaction, articleIds: readonly string[]): Promise<boolean> {
  const present = await tx.execute<{ relname: string }>(sql`
    SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'eval' AND c.relkind IN ('r', 'p')
       AND c.relname = ANY(${sql.param([...EVAL_ARTICLE_TABLES])}::text[])`);
  const tables = EVAL_ARTICLE_TABLES.filter((table) =>
    present.rows.some((row) => row.relname === table),
  );
  if (tables.length === 0) return false;
  const idArray = sql`${sql.param([...articleIds])}::bigint[]`;
  const probes = sql.join(
    tables.map((table) => evalProbe(table, idArray)),
    sql` UNION ALL `,
  );
  const result = await tx.execute<{ referenced: boolean }>(
    sql`SELECT EXISTS (${probes}) AS referenced`,
  );
  return result.rows[0]?.referenced === true;
}

// ── Moves ────────────────────────────────────────────────────────────────────────────────────

/**
 * Move the source's feed associations; returns the feeds whose association with the survivor is
 * new, in id order. A feed carrying both keeps the earlier `first_seen_at` and that row's GUID,
 * else the other GUID: each is unique within the feed and its duplicate row is deleted by the
 * same statement, so the partial `(feed_id, guid)` index cannot conflict.
 */
async function moveFeedItems(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<string[]> {
  await tx.execute(sql`
    WITH dup AS (
      DELETE FROM feed_items s
       USING feed_items t
       WHERE s.article_id = ${sourceId}::bigint AND t.article_id = ${targetId}::bigint
         AND t.feed_id = s.feed_id
      RETURNING s.feed_id, s.guid, s.first_seen_at)
    UPDATE feed_items t
       SET first_seen_at = least(t.first_seen_at, dup.first_seen_at),
           guid = CASE WHEN dup.first_seen_at < t.first_seen_at THEN coalesce(dup.guid, t.guid)
                       ELSE coalesce(t.guid, dup.guid) END
      FROM dup
     WHERE t.article_id = ${targetId}::bigint AND t.feed_id = dup.feed_id`);
  const moved = await tx.execute<{ feed_id: string }>(sql`
    UPDATE feed_items SET article_id = ${targetId}::bigint
     WHERE article_id = ${sourceId}::bigint
    RETURNING feed_id::text AS feed_id`);
  return moved.rows
    .map((row) => row.feed_id)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/**
 * Move every alias of the source to the survivor. An alias whose key is another article's
 * `url_key` breaks the cross-table invariant and is dropped instead: the `articles` row already
 * owns that key in every lookup, and moving it would make the key name two articles.
 */
async function moveAliases(tx: Transaction, sourceId: string, targetId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM article_aliases a
     WHERE a.article_id = ${sourceId}::bigint
       AND EXISTS (SELECT 1 FROM articles x
                    WHERE x.url_key = a.url_key AND x.id <> ${sourceId}::bigint)`);
  await tx.execute(sql`
    UPDATE article_aliases SET article_id = ${targetId}::bigint
     WHERE article_id = ${sourceId}::bigint`);
}

/**
 * Merge the reader rows (spec 03 §8.4, spec 02 §5.2 "Reader state and feedback agree"); returns
 * the snapshots that lost a collision's binding (identical checksums, so no content is lost), for
 * final-reference bookkeeping once every reference has settled.
 */
async function mergeReaderRows(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<string[]> {
  // A source-only row moves; its versions still advance past the input (an absent row counts as 0).
  await tx.execute(sql`
    UPDATE user_article ua
       SET article_id = ${targetId}::bigint,
           state_version = ua.state_version + 1,
           bookmark_capture_generation = ua.bookmark_capture_generation + 1
     WHERE ua.article_id = ${sourceId}::bigint
       AND NOT EXISTS (SELECT 1 FROM user_article t
                        WHERE t.user_id = ua.user_id AND t.article_id = ${targetId}::bigint)`);

  // Collisions: the target row takes the merged state. One bookmark binding is taken whole from one
  // side (never mixed): the side with a bound snapshot, else the earlier bookmark, target on ties.
  const merged = await tx.execute<{ dropped_snapshot_id: string | null }>(sql`
    WITH pair AS (
      SELECT s.user_id, s.opened_at, s.read_at, s.rating, s.reason, s.rated_at, s.dwell_ms,
             s.bookmarked_at, s.bookmark_snapshot_id, s.bookmark_origin_feed_id,
             s.bookmark_capture_status, s.bookmark_capture_error_code,
             s.bookmark_capture_generation, s.archived_at, s.feedback_prompted_at, s.state_version,
             b.side AS bookmark_side,
             CASE b.side WHEN 's' THEN t.bookmark_snapshot_id
                         WHEN 't' THEN s.bookmark_snapshot_id END AS dropped_snapshot_id,
             (s.rated_at IS NOT NULL AND (t.rated_at IS NULL OR s.rated_at > t.rated_at))
               AS source_rating,
             l.labels,
             ARRAY(SELECT x FROM unnest(t.label_suggestions || s.label_suggestions)
                                 WITH ORDINALITY AS u(x, n)
                    WHERE x <> ALL (l.labels) GROUP BY x ORDER BY min(n)) AS suggestions
        FROM user_article s
        JOIN user_article t ON t.user_id = s.user_id AND t.article_id = ${targetId}::bigint
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN s.bookmarked_at IS NULL AND t.bookmarked_at IS NULL THEN NULL
                   WHEN t.bookmarked_at IS NULL THEN 's'
                   WHEN s.bookmarked_at IS NULL THEN 't'
                   WHEN s.bookmark_snapshot_id IS NOT NULL AND t.bookmark_snapshot_id IS NULL THEN 's'
                   WHEN t.bookmark_snapshot_id IS NOT NULL AND s.bookmark_snapshot_id IS NULL THEN 't'
                   WHEN s.bookmarked_at < t.bookmarked_at THEN 's'
                   ELSE 't'
                 END AS side) b
        CROSS JOIN LATERAL (
          SELECT ARRAY(SELECT x FROM unnest(t.label_ids || s.label_ids) WITH ORDINALITY AS u(x, n)
                        GROUP BY x ORDER BY min(n)) AS labels) l
       WHERE s.article_id = ${sourceId}::bigint)
    UPDATE user_article t
       SET opened_at = greatest(t.opened_at, p.opened_at),
           read_at = greatest(t.read_at, p.read_at),
           rating = CASE WHEN p.source_rating THEN p.rating ELSE t.rating END,
           reason = CASE WHEN p.source_rating THEN p.reason ELSE t.reason END,
           rated_at = CASE WHEN p.source_rating THEN p.rated_at ELSE t.rated_at END,
           dwell_ms = greatest(t.dwell_ms, p.dwell_ms),
           bookmarked_at = least(t.bookmarked_at, p.bookmarked_at),
           bookmark_snapshot_id = CASE p.bookmark_side WHEN 's' THEN p.bookmark_snapshot_id
                                                       WHEN 't' THEN t.bookmark_snapshot_id END,
           bookmark_origin_feed_id = CASE p.bookmark_side
                                       WHEN 's' THEN p.bookmark_origin_feed_id
                                       WHEN 't' THEN t.bookmark_origin_feed_id END,
           bookmark_capture_status = CASE p.bookmark_side
                                       WHEN 's' THEN p.bookmark_capture_status
                                       WHEN 't' THEN t.bookmark_capture_status END,
           bookmark_capture_error_code = CASE p.bookmark_side
                                           WHEN 's' THEN p.bookmark_capture_error_code
                                           WHEN 't' THEN t.bookmark_capture_error_code END,
           bookmark_capture_generation =
             greatest(t.bookmark_capture_generation, p.bookmark_capture_generation) + 1,
           archived_at = CASE WHEN t.archived_at IS NULL OR p.archived_at IS NULL THEN NULL
                              ELSE greatest(t.archived_at, p.archived_at) END,
           label_ids = p.labels,
           label_suggestions = p.suggestions,
           feedback_prompted_at = least(t.feedback_prompted_at, p.feedback_prompted_at),
           state_version = greatest(t.state_version, p.state_version) + 1
      FROM pair p
     WHERE t.article_id = ${targetId}::bigint AND t.user_id = p.user_id
    RETURNING p.dropped_snapshot_id::text AS dropped_snapshot_id`);
  await tx.execute(sql`DELETE FROM user_article WHERE article_id = ${sourceId}::bigint`);

  // Ranking caches of every survivor row (moved, merged and target-only) are recomputed.
  await tx.execute(sql`
    UPDATE user_article
       SET lane = DEFAULT, tier = DEFAULT, p_like = DEFAULT, score_source = DEFAULT,
           rules_fired = DEFAULT, explain = DEFAULT, score_version = DEFAULT,
           rank_revision = DEFAULT, next_rank_at = DEFAULT, scored_at = DEFAULT
     WHERE article_id = ${targetId}::bigint`);

  return [
    ...new Set(
      merged.rows.map((row) => row.dropped_snapshot_id).filter((id): id is string => id !== null),
    ),
  ];
}

/**
 * Repoint the source's selected-analysis requests (spec 03 §2.2, spec 02 §5.2): completed history
 * keeps its frozen input and result; pending/running generations are cancelled and their leases
 * cleared, so a late worker cannot publish to the survivor (its token check fails).
 */
async function relocateAnalysisRequests(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE analysis_requests r
       SET article_id = ${targetId}::bigint,
           status = CASE WHEN r.status IN ('pending', 'running') THEN 'cancelled' ELSE r.status END,
           completed_at = CASE WHEN r.status IN ('pending', 'running') THEN now()
                               ELSE r.completed_at END,
           lease_token = CASE WHEN r.status IN ('pending', 'running') THEN NULL
                              ELSE r.lease_token END,
           lease_until = CASE WHEN r.status IN ('pending', 'running') THEN NULL
                              ELSE r.lease_until END,
           last_error_code = CASE WHEN r.status IN ('pending', 'running')
                                  THEN ${MERGED_REQUEST_ERROR_CODE} ELSE r.last_error_code END
     WHERE r.article_id = ${sourceId}::bigint`);
}

/** Queue progress per card, carried across the reset (timestamps as exact PostgreSQL text). */
interface QueueProgress {
  cardIds: string[];
  priorities: number[];
  enqueuedAt: string[];
  attempts: number[];
  lastErrors: Array<string | null>;
}

/**
 * Move the source's outstanding match questions to the survivor (spec 03 §8.4): per card the
 * minimum priority, oldest queue time and maximum attempts (with that row's error), leases
 * cleared. Returns the survivor's merged progress for {@link restoreQueueProgress}.
 */
async function moveMatchQueue(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<QueueProgress> {
  await tx.execute(sql`
    WITH moved AS (
      DELETE FROM match_queue WHERE article_id = ${sourceId}::bigint
      RETURNING card_id, article_revision, priority, user_id, attempts, last_error,
                next_attempt_at, enqueued_at)
    INSERT INTO match_queue AS q (article_id, card_id, article_revision, priority, user_id,
                                  attempts, last_error, next_attempt_at, enqueued_at)
    SELECT ${targetId}::bigint, card_id, article_revision, priority, user_id, attempts, last_error,
           next_attempt_at, enqueued_at
      FROM moved
    ON CONFLICT (article_id, card_id) DO UPDATE SET
      priority = least(q.priority, EXCLUDED.priority),
      enqueued_at = least(q.enqueued_at, EXCLUDED.enqueued_at),
      attempts = greatest(q.attempts, EXCLUDED.attempts),
      last_error = CASE WHEN EXCLUDED.attempts > q.attempts
                        THEN coalesce(EXCLUDED.last_error, q.last_error)
                        ELSE coalesce(q.last_error, EXCLUDED.last_error) END,
      next_attempt_at = greatest(q.next_attempt_at, EXCLUDED.next_attempt_at),
      user_id = CASE WHEN q.user_id IS NOT DISTINCT FROM EXCLUDED.user_id THEN q.user_id END,
      lease_token = NULL,
      lease_until = NULL`);
  await tx.execute(sql`
    UPDATE match_queue SET lease_token = NULL, lease_until = NULL
     WHERE article_id = ${targetId}::bigint AND lease_token IS NOT NULL`);
  const rows = await tx.execute<{
    card_id: string;
    priority: number;
    enqueued_at: string;
    attempts: number;
    last_error: string | null;
  }>(sql`
    SELECT card_id::text AS card_id, priority, enqueued_at::text AS enqueued_at, attempts,
           last_error
      FROM match_queue WHERE article_id = ${targetId}::bigint ORDER BY card_id`);
  return {
    cardIds: rows.rows.map((row) => row.card_id),
    priorities: rows.rows.map((row) => row.priority),
    enqueuedAt: rows.rows.map((row) => row.enqueued_at),
    attempts: rows.rows.map((row) => row.attempts),
    lastErrors: rows.rows.map((row) => row.last_error),
  };
}

/**
 * After the reset re-queued the admitted union at the new revision (which starts rows at an older
 * revision afresh), reapply the merged minimum priority, oldest queue time and maximum attempts to
 * the rows it kept. Rows it dropped (no longer admitted) stay dropped.
 */
async function restoreQueueProgress(
  tx: Transaction,
  targetId: string,
  progress: QueueProgress,
): Promise<void> {
  if (progress.cardIds.length === 0) return;
  await tx.execute(sql`
    UPDATE match_queue q
       SET priority = least(q.priority, v.priority),
           enqueued_at = least(q.enqueued_at, v.enqueued_at),
           attempts = greatest(q.attempts, v.attempts),
           last_error = coalesce(q.last_error, v.last_error)
      FROM unnest(${sql.param(progress.cardIds)}::bigint[],
                  ${sql.param(progress.priorities)}::smallint[],
                  ${sql.param(progress.enqueuedAt)}::timestamptz[],
                  ${sql.param(progress.attempts)}::smallint[],
                  ${sql.param(progress.lastErrors)}::text[])
           AS v(card_id, priority, enqueued_at, attempts, last_error)
     WHERE q.article_id = ${targetId}::bigint AND q.card_id = v.card_id`);
}

/**
 * Relocate the source's immutable snapshots (spec 02 §3.5: `article_id` is the one relocatable
 * column; the guard trigger rejects content/provenance edits). A source snapshot whose
 * `(source_revision, content_sha256)` the survivor already holds is byte-identical by checksum:
 * its bindings and pins move to that row (identical checksums share storage), which regains its
 * references, and the duplicate is removed. Snapshot rows are locked before references change, as
 * the capture functions and garbage collection do.
 */
async function relocateSnapshots(
  tx: Transaction,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const twins = await tx.execute<{ from_id: string; to_id: string }>(sql`
    SELECT s.id::text AS from_id, t.id::text AS to_id
      FROM article_snapshots s
      JOIN article_snapshots t ON t.article_id = ${targetId}::bigint
                              AND t.source_revision = s.source_revision
                              AND t.content_sha256 = s.content_sha256
     WHERE s.article_id = ${sourceId}::bigint
     ORDER BY s.id
       FOR UPDATE OF s, t`);
  if (twins.rows.length > 0) {
    const fromIds = twins.rows.map((row) => row.from_id);
    const toIds = twins.rows.map((row) => row.to_id);
    const pairs = sql`unnest(${sql.param(fromIds)}::bigint[], ${sql.param(toIds)}::bigint[])
                      AS v(from_id, to_id)`;
    await tx.execute(sql`
      UPDATE user_article ua SET bookmark_snapshot_id = v.to_id
        FROM ${pairs}
       WHERE ua.bookmark_snapshot_id = v.from_id`);
    await tx.execute(sql`
      UPDATE bookmark_snapshot_pins p SET snapshot_id = v.to_id
        FROM ${pairs}
       WHERE p.snapshot_id = v.from_id
         AND NOT EXISTS (SELECT 1 FROM bookmark_snapshot_pins q
                          WHERE q.user_id = p.user_id AND q.mutation_id = p.mutation_id
                            AND q.snapshot_id = v.to_id)`);
    // A pin left here duplicates one the same undo receipt already holds on the identical row.
    await tx.execute(sql`
      DELETE FROM bookmark_snapshot_pins WHERE snapshot_id = ANY(${sql.param(fromIds)}::bigint[])`);
    await tx.execute(sql`
      UPDATE article_snapshots s SET unreferenced_at = NULL
       WHERE s.id = ANY(${sql.param(toIds)}::bigint[]) AND s.unreferenced_at IS NOT NULL
         AND (EXISTS (SELECT 1 FROM user_article ua
                       WHERE ua.bookmark_snapshot_id = s.id AND ua.bookmarked_at IS NOT NULL)
              OR EXISTS (SELECT 1 FROM bookmark_snapshot_pins p
                          WHERE p.snapshot_id = s.id AND p.expires_at > now()))`);
    await tx.execute(sql`
      DELETE FROM article_snapshots WHERE id = ANY(${sql.param(fromIds)}::bigint[])`);
  }
  await tx.execute(sql`
    UPDATE article_snapshots SET article_id = ${targetId}::bigint
     WHERE article_id = ${sourceId}::bigint`);
}

/**
 * Choose the survivor's body before the reset (spec 03 §8.4): a valid target body is kept, else a
 * valid source body is moved over; "valid" is status `ok` at its article's current revision. The
 * survivor's revision (and the chosen body's) first rises to the larger of both revisions, so the
 * reset's increment exceeds every revision either identity used. `nextState` is `extracted` when
 * the chosen body's article had completed extraction, else `ingested` (extraction runs again).
 */
async function prepareSurvivorBody(
  tx: Transaction,
  source: LockedArticle,
  target: LockedArticle,
): Promise<{ keepBody: boolean; nextState: ResetNextState }> {
  const bodies = await tx.execute<{ article_id: string; revision: string; status: string }>(sql`
    SELECT article_id::text AS article_id, article_revision::text AS revision, status
      FROM article_bodies
     WHERE article_id IN (${source.id}::bigint, ${target.id}::bigint)`);
  const valid = (article: LockedArticle): boolean =>
    bodies.rows.some(
      (row) =>
        row.article_id === article.id && row.status === 'ok' && row.revision === article.revision,
    );
  const owner = valid(target) ? target : valid(source) ? source : null;
  const floor =
    BigInt(source.revision) > BigInt(target.revision) ? source.revision : target.revision;

  if (floor !== target.revision) {
    await tx.execute(sql`
      UPDATE articles SET content_revision = ${floor}::bigint WHERE id = ${target.id}::bigint`);
  }
  if (owner === target) {
    await tx.execute(sql`
      UPDATE article_bodies SET article_revision = ${floor}::bigint
       WHERE article_id = ${target.id}::bigint`);
  } else if (owner === source) {
    // The target's own row failed or is older; a successful replacement exists (spec 03 §8.1 step 8).
    await tx.execute(sql`DELETE FROM article_bodies WHERE article_id = ${target.id}::bigint`);
    await tx.execute(sql`
      UPDATE article_bodies SET article_id = ${target.id}::bigint, article_revision = ${floor}::bigint
       WHERE article_id = ${source.id}::bigint`);
  }

  const extracted =
    owner !== null && owner.pipelineState !== 'ingested' && owner.pipelineState !== 'stale';
  if (owner === source && extracted) {
    // Derived from that body by its extraction; the target's publisher metadata is kept.
    await tx.execute(sql`
      UPDATE articles t
         SET lang = s.lang, lang_confidence = s.lang_confidence, word_count = s.word_count
        FROM articles s
       WHERE t.id = ${target.id}::bigint AND s.id = ${source.id}::bigint`);
  }
  return { keepBody: owner !== null, nextState: extracted ? 'extracted' : 'ingested' };
}

// ── Completion ───────────────────────────────────────────────────────────────────────────────

/**
 * Delete the source once nothing that would cascade reader or identity data still references it.
 * The locks keep new references out, so a remaining row means a writer bypassed them: abort.
 */
async function deleteSource(tx: Transaction, sourceId: string): Promise<void> {
  const left = await tx.execute<{ n: number }>(sql`
    SELECT ((SELECT count(*) FROM feed_items WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM article_aliases WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM user_article WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM feedback_events WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM analysis_requests WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM match_queue WHERE article_id = ${sourceId}::bigint)
          + (SELECT count(*) FROM article_snapshots WHERE article_id = ${sourceId}::bigint))::int
           AS n`);
  if ((left.rows[0]?.n ?? 0) !== 0) {
    throw new Error('mergeArticles: rows still reference the source; refusing to delete it');
  }
  await tx.execute(sql`DELETE FROM articles WHERE id = ${sourceId}::bigint`);
}

/**
 * The source's former url_key becomes the survivor's alias, inserted after the source row is gone
 * so the key never names two articles at once. An existing alias of that key can only name the
 * survivor (checked under the key lock); anything else aborts.
 */
async function addSourceKeyAlias(
  tx: Transaction,
  urlKey: string,
  targetId: string,
  reason: MergeArticlesReason,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO article_aliases (url_key, article_id, source)
    VALUES (${urlKey}, ${targetId}::bigint, ${reason})
    ON CONFLICT (url_key) DO NOTHING`);
  const owner = await tx.execute<{ article_id: string }>(sql`
    SELECT article_id::text AS article_id FROM article_aliases WHERE url_key = ${urlKey}`);
  if (owner.rows[0]?.article_id !== targetId) {
    throw new Error('mergeArticles: the source url key names another article');
  }
}

/** Active reader-row owners and carrier subscribers of the survivor, in UUID order. */
async function activeAffectedUserIds(tx: Transaction, articleId: string): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT x.user_id::text AS user_id
      FROM (SELECT user_id FROM user_article WHERE article_id = ${articleId}::bigint
            UNION
            SELECT s.user_id FROM feed_items fi JOIN subscriptions s ON s.feed_id = fi.feed_id
             WHERE fi.article_id = ${articleId}::bigint) x
      JOIN users u ON u.id = x.user_id AND u.deleted_at IS NULL`);
  return result.rows.map((row) => row.user_id).sort();
}

/** Whether a surviving bookmark still waits for a local capture (spec 03 §8.5). */
async function hasPendingCapture(tx: Transaction, articleId: string): Promise<boolean> {
  const result = await tx.execute<{ pending: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM user_article
                    WHERE article_id = ${articleId}::bigint
                      AND bookmark_capture_status = 'pending') AS pending`);
  return result.rows[0]?.pending === true;
}
