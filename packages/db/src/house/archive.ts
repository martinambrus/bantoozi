import { sql, type SQL } from 'drizzle-orm';

import type { Transaction } from '../client.js';

const DAY_MS = 24 * 60 * 60_000;
/** Days after the latest carrier arrival at which a read, unprotected item is archived. */
export const ARCHIVE_READ_AFTER_DAYS = 31;
/** The most unread items a user keeps per feed; the items beyond it are archived. */
export const UNREAD_CAP = 1_000;

const unprotected = sql`ua.bookmarked_at IS NULL AND ua.rating IS NULL AND cardinality(ua.label_ids) = 0`;

function arrival(): SQL {
  return sql`coalesce(
    (SELECT max(fi.first_seen_at) FROM feed_items fi
       JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = ua.user_id
      WHERE fi.article_id = ua.article_id),
    (SELECT a.first_seen_at FROM articles a WHERE a.id = ua.article_id))`;
}

function readCandidates(now: Date): SQL {
  const cutoff = new Date(now.getTime() - ARCHIVE_READ_AFTER_DAYS * DAY_MS).toISOString();
  return sql`ua.read_at IS NOT NULL AND ua.archived_at IS NULL AND ${unprotected}
    AND ${arrival()} <= ${cutoff}::timestamptz`;
}

function overCapCandidates(userId: string): SQL {
  return sql`
    SELECT user_id, article_id FROM (
      SELECT ua.user_id, ua.article_id,
             row_number() OVER (PARTITION BY ua.user_id, c.feed_id
                                ORDER BY c.first_seen_at DESC, ua.article_id DESC) AS rn
        FROM user_article ua
        JOIN (SELECT feed_id, article_id, max(first_seen_at) AS first_seen_at
                FROM feed_items GROUP BY feed_id, article_id) c ON c.article_id = ua.article_id
        JOIN subscriptions s ON s.user_id = ua.user_id AND s.feed_id = c.feed_id
       WHERE ua.user_id = ${userId}::uuid AND ua.read_at IS NULL AND ua.archived_at IS NULL
         AND ${unprotected}) ranked
     GROUP BY user_id, article_id HAVING min(rn) > ${UNREAD_CAP}`;
}

/**
 * Archives up to `limit` read, unprotected items whose latest subscribed-carrier arrival is 31 days
 * before `now` (spec 11 §5, §6): under the row lock it sets `archived_at = now` and increments
 * `state_version`, and records no feedback event (spec 08 §1.1). Returns the count archived.
 */
export async function archiveReadItems(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE user_article u SET archived_at = ${input.now.toISOString()}::timestamptz,
                              state_version = u.state_version + 1
      FROM (SELECT ua.user_id, ua.article_id FROM user_article ua
             WHERE ${readCandidates(input.now)}
             ORDER BY ua.user_id, ua.article_id
             LIMIT ${input.limit}
             FOR UPDATE OF ua SKIP LOCKED) d
     WHERE u.user_id = d.user_id AND u.article_id = d.article_id`);
  return result.rowCount ?? 0;
}

/** The next page (after `after`, UUID order) of users with more than the cap of unread items in a subscribed feed. */
export async function usersOverUnreadCap(
  tx: Transaction,
  input: { after: string | null; limit: number },
): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT s.user_id::text AS user_id
      FROM subscriptions s
      JOIN feed_items fi ON fi.feed_id = s.feed_id
      JOIN user_article ua ON ua.user_id = s.user_id AND ua.article_id = fi.article_id
     WHERE (${input.after}::uuid IS NULL OR s.user_id > ${input.after}::uuid)
       AND ua.read_at IS NULL AND ua.archived_at IS NULL AND ${unprotected}
     GROUP BY s.user_id, s.feed_id
    HAVING count(DISTINCT ua.article_id) > ${UNREAD_CAP}
     ORDER BY s.user_id
     LIMIT ${input.limit}`);
  return [...new Set(result.rows.map((row) => row.user_id))];
}

/**
 * Archives up to `limit` of one user's unread, unprotected items that rank beyond the cap in every
 * subscribed feed carrying them, newest carrier arrival first (spec 11 §5, §6). Same write as
 * {@link archiveReadItems}. Returns the count archived.
 */
export async function archiveOverCapItems(
  tx: Transaction,
  input: { userId: string; now: Date; limit: number },
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE user_article u SET archived_at = ${input.now.toISOString()}::timestamptz,
                              state_version = u.state_version + 1
      FROM (SELECT ua.user_id, ua.article_id
              FROM user_article ua
              JOIN (${overCapCandidates(input.userId)} LIMIT ${input.limit}) c
                ON c.user_id = ua.user_id AND c.article_id = ua.article_id
             WHERE ua.read_at IS NULL AND ua.archived_at IS NULL AND ${unprotected}
             ORDER BY ua.article_id
             FOR UPDATE OF ua SKIP LOCKED) d
     WHERE u.user_id = d.user_id AND u.article_id = d.article_id`);
  return result.rowCount ?? 0;
}

/** How many read-rule items are still archivable at `now` (the job's `remaining` figure). */
export async function countArchivableReadItems(tx: Transaction, now: Date): Promise<number> {
  const result = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM user_article ua WHERE ${readCandidates(now)}`);
  return result.rows[0]?.n ?? 0;
}
