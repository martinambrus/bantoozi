import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import {
  bigintArray,
  collectableSnapshot,
  daysBefore,
  lockSnapshotPath,
  SNAPSHOT_COLD_AFTER_DAYS,
} from './snapshots.js';

/** Days after extraction and after the latest carrier arrival at which a hot body is cleared (spec 11 §5.2). */
export const HOT_BODY_RETENTION_DAYS = 30;

/** One keyset page of a `house.purge-bodies` step. */
export interface BodiesPage {
  /** Rows examined; fewer than `limit` ends the step's pass. */
  examined: number;
  /** Rows changed. */
  changed: number;
  lastId: string | null;
}

/** Deletes up to `limit` Undo pins expired at `now` (spec 11 §5.2). Returns the count. */
export async function deleteExpiredPins(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<number> {
  const result = await tx.execute(sql`
    DELETE FROM bookmark_snapshot_pins WHERE ctid IN (
      SELECT ctid FROM bookmark_snapshot_pins
       WHERE expires_at <= ${input.now.toISOString()}::timestamptz
       LIMIT ${input.limit} FOR UPDATE SKIP LOCKED)`);
  return result.rowCount ?? 0;
}

type SnapshotRef = {
  id: string;
  article_id: string;
};

const refs = (rows: SnapshotRef[]) => rows.map((r) => ({ id: r.id, articleId: r.article_id }));

/**
 * Marks one page of unmarked snapshots that no live bookmark and no unexpired pin holds, via
 * `mark_snapshot_if_unreferenced` (the only place the mark is set), repairing releases that left
 * no mark (an expired Undo pin, a purged receipt; spec 11 §5.2). The grace then runs on the
 * database clock.
 */
export async function markUnreferencedSnapshotsPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<BodiesPage> {
  const found = await tx.execute<SnapshotRef>(sql`
    SELECT s.id::text AS id, s.article_id::text AS article_id FROM article_snapshots s
     WHERE s.id > ${input.after ?? '0'}::bigint AND s.unreferenced_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM user_article ua
                        WHERE ua.bookmark_snapshot_id = s.id AND ua.bookmarked_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM bookmark_snapshot_pins p
                        WHERE p.snapshot_id = s.id AND p.expires_at > ${input.now.toISOString()}::timestamptz)
     ORDER BY s.id LIMIT ${input.limit}`);
  if (found.rows.length === 0) return { examined: 0, changed: 0, lastId: null };
  const locked = await lockSnapshotPath(tx, refs(found.rows));
  let changed = 0;
  for (const id of locked) {
    await tx.execute(sql`SELECT mark_snapshot_if_unreferenced(${id}::bigint)`);
    const marked = await tx.execute<{ marked: boolean }>(sql`
      SELECT unreferenced_at IS NOT NULL AS marked FROM article_snapshots WHERE id = ${id}::bigint`);
    if (marked.rows[0]?.marked === true) changed += 1;
  }
  return { examined: found.rows.length, changed, lastId: found.rows.at(-1)?.id ?? null };
}

export interface ColdPage extends BodiesPage {
  /** Snapshots whose recomputed checksum differed from the stored one; they stay hot. */
  mismatched: number;
  /** The storage compression of the marked snapshots' bodies by method (`none` when stored plain). */
  compression: Record<string, number>;
}

/**
 * Marks one page of snapshots captured 30 days ago cold (spec 11 §5.2) when the recomputed content
 * checksum equals the stored one; the bodies are not rewritten, so reads stay byte-identical and
 * the column's TOAST compression (pglz, migration 0002) is what compresses them.
 */
export async function markSnapshotsColdPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<ColdPage> {
  const found = await tx.execute<SnapshotRef>(sql`
    SELECT s.id::text AS id, s.article_id::text AS article_id FROM article_snapshots s
     WHERE s.id > ${input.after ?? '0'}::bigint AND s.cold_at IS NULL
       AND s.captured_at <= ${daysBefore(input.now, SNAPSHOT_COLD_AFTER_DAYS)}::timestamptz
     ORDER BY s.id LIMIT ${input.limit}`);
  const lastId = found.rows.at(-1)?.id ?? null;
  const locked = await lockSnapshotPath(tx, refs(found.rows));
  const compression: Record<string, number> = {};
  let changed = 0;
  if (locked.length > 0) {
    const marked = await tx.execute<{ method: string | null }>(sql`
      UPDATE article_snapshots s SET cold_at = ${input.now.toISOString()}::timestamptz
       WHERE s.id = ANY(${bigintArray(locked)}) AND s.cold_at IS NULL
         AND snapshot_content_sha256(s.title, s.author, s.published_at, s.source_url, s.body_text, s.body_html)
             = s.content_sha256
      RETURNING pg_column_compression(s.body_text)::text AS method`);
    changed = marked.rowCount ?? 0;
    for (const row of marked.rows) {
      const key = row.method ?? 'none';
      compression[key] = (compression[key] ?? 0) + 1;
    }
  }
  return {
    examined: found.rows.length,
    changed,
    lastId,
    mismatched: locked.length - changed,
    compression,
  };
}

/**
 * Clears one page of hot bodies (`body_text`, `body_html`; `body_lead` stays) extracted 30 days ago
 * whose article's latest carrier arrival is also 30 days old (spec 11 §5.2), under the article
 * lock and never while a bookmark capture of the article is pending or failed.
 */
export async function clearHotBodiesPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<BodiesPage> {
  const cutoff = daysBefore(input.now, HOT_BODY_RETENTION_DAYS);
  const found = await tx.execute<{ id: string }>(sql`
    SELECT b.article_id::text AS id FROM article_bodies b
     WHERE b.article_id > ${input.after ?? '0'}::bigint
       AND (b.body_text IS NOT NULL OR b.body_html IS NOT NULL)
       AND b.extracted_at <= ${cutoff}::timestamptz
     ORDER BY b.article_id LIMIT ${input.limit}`);
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return { examined: 0, changed: 0, lastId: null };
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM articles WHERE id = ANY(${bigintArray(ids)})
     ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`);
  const held = locked.rows.map((row) => row.id);
  let changed = 0;
  if (held.length > 0) {
    const cleared = await tx.execute(sql`
      UPDATE article_bodies b SET body_text = NULL, body_html = NULL
        FROM articles a
       WHERE a.id = b.article_id AND b.article_id = ANY(${bigintArray(held)})
         AND (b.body_text IS NOT NULL OR b.body_html IS NOT NULL)
         AND b.extracted_at <= ${cutoff}::timestamptz
         AND coalesce((SELECT max(fi.first_seen_at) FROM feed_items fi WHERE fi.article_id = a.id),
                      a.first_seen_at) <= ${cutoff}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM user_article ua WHERE ua.article_id = a.id
                          AND ua.bookmarked_at IS NOT NULL
                          AND ua.bookmark_capture_status IN ('pending', 'failed'))`);
    changed = cleared.rowCount ?? 0;
  }
  return { examined: ids.length, changed, lastId: ids.at(-1) ?? null };
}

/**
 * Deletes one page of snapshots whose unreferenced mark is 7 days old (spec 11 §5.2), after
 * locking article, reader rows and snapshot in capture order and rechecking that no bookmark row,
 * unexpired pin or pending capture of the article holds them.
 */
export async function collectSnapshotsPage(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<BodiesPage> {
  const found = await tx.execute<SnapshotRef>(sql`
    SELECT s.id::text AS id, s.article_id::text AS article_id FROM article_snapshots s
     WHERE s.id > ${input.after ?? '0'}::bigint AND ${collectableSnapshot(input.now)}
     ORDER BY s.id LIMIT ${input.limit}`);
  if (found.rows.length === 0) return { examined: 0, changed: 0, lastId: null };
  const locked = await lockSnapshotPath(tx, refs(found.rows));
  let changed = 0;
  if (locked.length > 0) {
    const doomed = await tx.execute<{ id: string }>(sql`
      SELECT s.id::text AS id FROM article_snapshots s
       WHERE s.id = ANY(${bigintArray(locked)}) AND ${collectableSnapshot(input.now)}
         AND NOT EXISTS (SELECT 1 FROM user_article ua WHERE ua.article_id = s.article_id
                          AND ua.bookmark_capture_status = 'pending')`);
    const ids = doomed.rows.map((row) => row.id);
    if (ids.length > 0) {
      await tx.execute(
        sql`DELETE FROM bookmark_snapshot_pins WHERE snapshot_id = ANY(${bigintArray(ids)})`,
      );
      const removed = await tx.execute(
        sql`DELETE FROM article_snapshots WHERE id = ANY(${bigintArray(ids)})`,
      );
      changed = removed.rowCount ?? 0;
    }
  }
  return { examined: found.rows.length, changed, lastId: found.rows.at(-1)?.id ?? null };
}
