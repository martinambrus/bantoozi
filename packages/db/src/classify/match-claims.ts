import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database, Executor, Transaction } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/** Rows claimed per `article.match` snapshot (spec 05 §5.5 step 1). */
export const MATCH_CLAIM_LIMIT = 400;
/** Failure attempts after which a row is retained as exhausted (spec 05 §5.5 step 7). */
export const MATCH_MAX_ATTEMPTS = 5;
/** Interactive priorities (spec 05 §5.5 step 5: a row with priority ≤ 3 is interactive). */
export const MATCH_INTERACTIVE_MAX_PRIORITY = 3;
/**
 * How long an exhausted service-failure row waits before recovery may reset it (spec 05 §5.5 step
 * 7): a pair that keeps failing costs at most five attempts per period instead of five per pass.
 */
export const MATCH_RECOVERY_COOLDOWN_MS = 6 * 60 * 60_000;

/** One leased `match_queue` row. */
export interface ClaimedMatchRow {
  cardId: string;
  articleRevision: string;
  priority: number;
  userId: string | null;
  attempts: number;
  enqueuedAt: Date;
}

export interface MatchClaim {
  leaseToken: string;
  leaseUntil: Date;
  /** The article's current revision the rows were stamped with. */
  revision: string;
  rows: ClaimedMatchRow[];
}

/**
 * Snapshot and lease (spec 05 §5.5 step 1, spec 02 §3.3) in one short transaction of its own: up to
 * `limit` current due rows (`attempts < 5`, `next_attempt_at ≤ now`, lease absent or expired) of
 * the article at its current revision, ordered by priority, queue time and card id, taken with
 * `FOR UPDATE SKIP LOCKED` and stamped with a fresh lease token, expiry and the revision. The claim
 * commits before any model call. Null when the article is gone.
 */
export async function claimMatchRows(
  db: Database,
  articleId: string,
  options: { leaseMs: number; limit?: number },
): Promise<MatchClaim | null> {
  const leaseToken = randomUUID();
  return db.transaction(async (tx) => {
    const article = await tx.execute<{ revision: string }>(sql`
      SELECT content_revision::text AS revision FROM articles
       WHERE id = ${articleId}::bigint FOR SHARE`);
    const revision = article.rows[0]?.revision;
    if (revision === undefined) return null;
    const claimed = await tx.execute<{
      card_id: string;
      article_revision: string;
      priority: number;
      user_id: string | null;
      attempts: number;
      enqueued_at: RawTimestamp;
      lease_until: RawTimestamp;
    }>(sql`
      WITH due AS (
        SELECT article_id, card_id FROM match_queue
         WHERE article_id = ${articleId}::bigint AND article_revision = ${revision}::bigint
           AND attempts < ${MATCH_MAX_ATTEMPTS} AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY priority, enqueued_at, card_id
         LIMIT ${options.limit ?? MATCH_CLAIM_LIMIT}
         FOR UPDATE SKIP LOCKED)
      UPDATE match_queue q
         SET lease_token = ${leaseToken}::uuid,
             lease_until = now() + make_interval(secs => ${options.leaseMs / 1000}::double precision),
             article_revision = ${revision}::bigint
        FROM due
       WHERE q.article_id = due.article_id AND q.card_id = due.card_id
      RETURNING q.card_id::text AS card_id, q.article_revision::text AS article_revision,
                q.priority, q.user_id::text AS user_id, q.attempts, q.enqueued_at, q.lease_until`);
    const rows = claimed.rows
      .map((row) => ({
        cardId: row.card_id,
        articleRevision: row.article_revision,
        priority: row.priority,
        userId: row.user_id,
        attempts: row.attempts,
        enqueuedAt: toDate(row.enqueued_at),
      }))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.enqueuedAt.getTime() - b.enqueuedAt.getTime() ||
          compareIds(a.cardId, b.cardId),
      );
    const leased = claimed.rows[0]?.lease_until;
    const leaseUntil =
      leased === undefined ? new Date(Date.now() + options.leaseMs) : toDate(leased);
    return { leaseToken, leaseUntil, revision, rows };
  });
}

/**
 * The given rows this lease still holds at `revision`, locked. A row whose expired lease another
 * worker reclaimed carries that worker's token and is never returned, so a partial reclaim leaves
 * the new owner its rows (spec 05 §5.5 step 6).
 */
export async function heldMatchRows(
  tx: Executor,
  input: { articleId: string; revision: string; leaseToken: string; cardIds: readonly string[] },
): Promise<string[]> {
  if (input.cardIds.length === 0) return [];
  const result = await tx.execute<{ card_id: string }>(sql`
    SELECT card_id::text AS card_id FROM match_queue
     WHERE article_id = ${input.articleId}::bigint AND article_revision = ${input.revision}::bigint
       AND lease_token = ${input.leaseToken}::uuid
       AND card_id = ANY(${sql.param([...new Set(input.cardIds)])}::bigint[])
     ORDER BY card_id
       FOR UPDATE`);
  return result.rows.map((row) => row.card_id).sort(compareIds);
}

/** Extend a live lease; false when another worker reclaimed the rows (stop working then). */
export async function renewMatchLease(
  db: Executor,
  articleId: string,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE match_queue SET lease_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision)
     WHERE article_id = ${articleId}::bigint AND lease_token = ${leaseToken}::uuid`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete rows this lease answered or found satisfied (spec 05 §5.5 step 6): only rows still held by
 * this token at this revision, so rows another worker reclaimed, or a reset re-queued at a newer
 * revision, are never deleted. Returns the deleted card ids.
 */
export async function completeMatchRows(
  tx: Transaction,
  input: { articleId: string; revision: string; leaseToken: string; cardIds: readonly string[] },
): Promise<string[]> {
  if (input.cardIds.length === 0) return [];
  const result = await tx.execute<{ card_id: string }>(sql`
    DELETE FROM match_queue
     WHERE article_id = ${input.articleId}::bigint
       AND article_revision = ${input.revision}::bigint
       AND lease_token = ${input.leaseToken}::uuid
       AND card_id = ANY(${sql.param([...input.cardIds])}::bigint[])
    RETURNING card_id::text AS card_id`);
  return result.rows.map((row) => row.card_id);
}

/**
 * Drop queued pairs that no longer have demand, or that a current answer already satisfies
 * (spec 05 §5.5 step 2, step 7 `no_demand`). Unleased rows and rows held by `leaseToken` are
 * dropped; a row leased by another live worker is left to that worker.
 */
export async function dropMatchRows(
  tx: Executor,
  input: { articleId: string; cardIds: readonly string[]; leaseToken?: string },
): Promise<string[]> {
  if (input.cardIds.length === 0) return [];
  const result = await tx.execute<{ card_id: string }>(sql`
    DELETE FROM match_queue
     WHERE article_id = ${input.articleId}::bigint
       AND card_id = ANY(${sql.param([...input.cardIds])}::bigint[])
       AND (lease_token IS NULL OR lease_until < now()
            OR lease_token = ${input.leaseToken ?? null}::uuid)
    RETURNING card_id::text AS card_id`);
  return result.rows.map((row) => row.card_id);
}

/** How a leased pack that produced no answers is released (spec 05 §5.5 step 7). */
export type MatchRelease =
  /** Budget, no key, open breaker, `Retry-After`: no failure attempt, due again at `nextAttemptAt`. */
  | { kind: 'defer'; nextAttemptAt: Date; lastError: string }
  /**
   * Actual retry exhaustion: one failure attempt for the logical pack, exponential due time. The
   * fifth leaves the row exhausted with `next_attempt_at` = the time it gave up (it is never due).
   */
  | { kind: 'fail'; lastError: string }
  /**
   * A permanent invalid request: retained immediately as exhausted (`attempts = 5`), with
   * `next_attempt_at` = the time it gave up.
   */
  | { kind: 'exhaust'; lastError: string }
  /** Unused rows of a completed snapshot (lease released, nothing else changes). */
  | { kind: 'release' };

/** Delay before the next try after the n-th failure attempt: 1, 2, 4, 8 minutes. */
export function matchFailureDelayMs(attempts: number): number {
  return 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 3);
}

/**
 * Release leased rows (only those still held by `leaseToken`) as {@link MatchRelease} says. No row
 * is deleted: exhausted rows stay with `last_error` for bounded recovery (spec 02 §3.3).
 */
export async function releaseMatchRows(
  tx: Executor,
  input: {
    articleId: string;
    leaseToken: string;
    cardIds: readonly string[];
    release: MatchRelease;
  },
): Promise<number> {
  if (input.cardIds.length === 0) return 0;
  const { release } = input;
  const where = sql`
     WHERE article_id = ${input.articleId}::bigint AND lease_token = ${input.leaseToken}::uuid
       AND card_id = ANY(${sql.param([...input.cardIds])}::bigint[])`;
  let result;
  switch (release.kind) {
    case 'release':
      result = await tx.execute(sql`
        UPDATE match_queue SET lease_token = NULL, lease_until = NULL ${where}`);
      break;
    case 'defer':
      result = await tx.execute(sql`
        UPDATE match_queue
           SET lease_token = NULL, lease_until = NULL, last_error = ${release.lastError},
               next_attempt_at = greatest(now(), ${release.nextAttemptAt.toISOString()}::timestamptz)
        ${where}`);
      break;
    case 'fail':
      result = await tx.execute(sql`
        UPDATE match_queue
           SET lease_token = NULL, lease_until = NULL, last_error = ${release.lastError},
               attempts = least(attempts + 1, ${MATCH_MAX_ATTEMPTS}),
               next_attempt_at = CASE WHEN attempts + 1 >= ${MATCH_MAX_ATTEMPTS} THEN now()
                                      ELSE now() + make_interval(mins => power(2, least(attempts, 3))::int)
                                 END
        ${where}`);
      break;
    case 'exhaust':
      result = await tx.execute(sql`
        UPDATE match_queue
           SET lease_token = NULL, lease_until = NULL, last_error = ${release.lastError},
               attempts = ${MATCH_MAX_ATTEMPTS}, next_attempt_at = now()
        ${where}`);
      break;
  }
  return result.rowCount ?? 0;
}

/** Queue rows of the article still waiting at `revision` (due or not, exhausted excluded). */
export async function pendingMatchRows(
  db: Executor,
  articleId: string,
  revision: string,
): Promise<Array<{ cardId: string; due: boolean; leased: boolean; attempts: number }>> {
  const result = await db.execute<{
    card_id: string;
    due: boolean;
    leased: boolean;
    attempts: number;
  }>(sql`
    SELECT card_id::text AS card_id, next_attempt_at <= now() AS due,
           (lease_until IS NOT NULL AND lease_until >= now()) AS leased, attempts
      FROM match_queue
     WHERE article_id = ${articleId}::bigint AND article_revision = ${revision}::bigint
     ORDER BY card_id`);
  return result.rows.map((row) => ({
    cardId: row.card_id,
    due: row.due,
    leased: row.leased,
    attempts: row.attempts,
  }));
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
