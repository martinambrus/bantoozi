import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/**
 * Marks up to `limit` reservations still `reserved` past their expiry at `now` as `uncertain`
 * (spec 11 §6 `house.reconcile`; spec 04 §4). They are neither settled nor released here, and a
 * late settlement still applies to them.
 */
export async function expireReservations(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<number> {
  const result = await tx.execute(sql`
    UPDATE engine_reservations r SET status = 'uncertain'
      FROM (SELECT id FROM engine_reservations
             WHERE status = 'reserved' AND expires_at <= ${input.now.toISOString()}::timestamptz
             ORDER BY expires_at, id
             LIMIT ${input.limit}
             FOR UPDATE SKIP LOCKED) d
     WHERE r.id = d.id AND r.status = 'reserved'`);
  return result.rowCount ?? 0;
}

/**
 * The next page (after `after`, UUID order) of users with an article whose `next_rank_at` is due at
 * `now` (spec 06 §7, spec 11 §6 `house.reconcile`). Deleted accounts are skipped.
 */
export async function usersDueForRank(
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
): Promise<string[]> {
  const result = await tx.execute<{ user_id: string }>(sql`
    SELECT u.id::text AS user_id
      FROM users u
     WHERE u.deleted_at IS NULL
       AND (${input.after}::uuid IS NULL OR u.id > ${input.after}::uuid)
       AND EXISTS (SELECT 1 FROM user_article ua
                    WHERE ua.user_id = u.id
                      AND ua.next_rank_at <= ${input.now.toISOString()}::timestamptz)
     ORDER BY u.id
     LIMIT ${input.limit}`);
  return result.rows.map((row) => row.user_id);
}
