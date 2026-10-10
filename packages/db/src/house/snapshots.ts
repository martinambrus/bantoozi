import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';

const DAY_MS = 24 * 60 * 60_000;
/** Days a snapshot stays after its last bookmark or Undo pin was released (spec 11 §5.2). */
export const SNAPSHOT_GRACE_DAYS = 7;
/** Days after capture at which a snapshot is marked cold (spec 11 §5.2). */
export const SNAPSHOT_COLD_AFTER_DAYS = 30;

/** The instant `days` before `now`, as an ISO string for a `timestamptz` parameter. */
export const daysBefore = (now: Date, days: number): string =>
  new Date(now.getTime() - days * DAY_MS).toISOString();

/** A `bigint[]` parameter. */
export const bigintArray = (ids: readonly string[]): SQL => sql`${sql.param([...ids])}::bigint[]`;

/**
 * The predicate of a snapshot (alias `s`) that garbage collection may delete at `now` (spec 11
 * §5.2): marked unreferenced at least seven days ago, held by no bookmark row and by no unexpired
 * Undo pin. The mark itself is only ever set by `mark_snapshot_if_unreferenced`.
 */
export function collectableSnapshot(now: Date): SQL {
  return sql`s.unreferenced_at <= ${daysBefore(now, SNAPSHOT_GRACE_DAYS)}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM user_article ua WHERE ua.bookmark_snapshot_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM bookmark_snapshot_pins p
                     WHERE p.snapshot_id = s.id AND p.expires_at > ${now.toISOString()}::timestamptz)`;
}

/**
 * Deletes every snapshot of the given (locked) articles together with its expired pins. Callers
 * have established that each is collectable at their `now` (spec 11 §5.2); returns the count.
 */
export async function deleteSnapshotsOfArticles(
  tx: Transaction,
  articleIds: readonly string[],
): Promise<number> {
  if (articleIds.length === 0) return 0;
  await tx.execute(sql`
    DELETE FROM bookmark_snapshot_pins
     WHERE snapshot_id IN (SELECT id FROM article_snapshots WHERE article_id = ANY(${bigintArray(articleIds)}))`);
  const result = await tx.execute(sql`
    DELETE FROM article_snapshots WHERE article_id = ANY(${bigintArray(articleIds)})`);
  return result.rowCount ?? 0;
}

/**
 * Locks the capture path of snapshots in the order bookmark capture takes it (spec 03 §8.5): the
 * article (skipping a locked one), the reader rows holding the snapshots, then the snapshots.
 * Returns the snapshots whose article and row are now held.
 */
export async function lockSnapshotPath(
  tx: Transaction,
  candidates: ReadonlyArray<{ id: string; articleId: string }>,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const articles = [...new Set(candidates.map((c) => c.articleId))].sort(compareIds);
  const locked = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM articles WHERE id = ANY(${bigintArray(articles)})
     ORDER BY id FOR NO KEY UPDATE SKIP LOCKED`);
  const held = new Set(locked.rows.map((row) => row.id));
  const mine = candidates.filter((c) => held.has(c.articleId)).map((c) => c.id);
  if (mine.length === 0) return [];
  await tx.execute(sql`
    SELECT 1 FROM user_article
     WHERE article_id = ANY(${bigintArray([...held])}) AND bookmark_snapshot_id = ANY(${bigintArray(mine)})
     ORDER BY user_id, article_id FOR UPDATE`);
  const snapshots = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM article_snapshots
     WHERE id = ANY(${bigintArray(mine)}) AND article_id = ANY(${bigintArray([...held])})
     ORDER BY id FOR UPDATE`);
  return snapshots.rows.map((row) => row.id);
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
