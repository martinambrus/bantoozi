import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';

/**
 * Deletes up to `limit` rules that expired at or before `now` (spec 06 §3.1, spec 11 §6
 * `house.expire-rules`) and returns the users they belonged to, in UUID order. Rules are taken
 * oldest expiry first with `SKIP LOCKED`, so a concurrent API edit of one rule never blocks the job.
 */
export async function deleteExpiredRules(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<{ deleted: number; userIds: string[] }> {
  const result = await tx.execute<{ user_id: string }>(sql`
    DELETE FROM user_rules r
     USING (SELECT id FROM user_rules
             WHERE expires_at <= ${input.now.toISOString()}::timestamptz
             ORDER BY expires_at, id
             LIMIT ${input.limit}
             FOR UPDATE SKIP LOCKED) d
     WHERE r.id = d.id
    RETURNING r.user_id::text AS user_id`);
  return {
    deleted: result.rows.length,
    userIds: [...new Set(result.rows.map((row) => row.user_id))].sort(),
  };
}
