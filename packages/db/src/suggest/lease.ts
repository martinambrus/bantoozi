import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database, Executor } from '../client.js';

/** One suggestion attempt per user and day (spec 05 §7 step 0). */
export const SUGGEST_GATE_HOURS = 24;

export type SuggestClaim =
  | { status: 'claimed'; leaseToken: string }
  /** The user is missing or deleted. */
  | { status: 'missing' }
  /** Another worker holds a live lease. */
  | { status: 'busy' }
  /** An admitted attempt was stamped within the last 24 hours. */
  | { status: 'gated' };

/**
 * Claim the user's suggest lease in a short transaction of its own under the user row lock (spec 05
 * §7): refused for a missing or deleted user, a live lease or a stamp younger than 24 hours. Commits
 * before any evidence is read.
 */
export async function claimSuggestLease(
  db: Database,
  userId: string,
  options: { leaseMs: number },
): Promise<SuggestClaim> {
  const leaseToken = randomUUID();
  return db.transaction(async (tx) => {
    const found = await tx.execute<{ live: boolean; gated: boolean }>(sql`
      SELECT (suggest_lease_until IS NOT NULL AND suggest_lease_until > now()) AS live,
             (last_suggested_at IS NOT NULL
              AND last_suggested_at > now() - make_interval(hours => ${SUGGEST_GATE_HOURS})) AS gated
        FROM users WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR UPDATE`);
    const row = found.rows[0];
    if (row === undefined) return { status: 'missing' };
    if (row.live) return { status: 'busy' };
    if (row.gated) return { status: 'gated' };
    await tx.execute(sql`
      UPDATE users
         SET suggest_lease_token = ${leaseToken}::uuid,
             suggest_lease_until = now() + make_interval(secs => ${options.leaseMs / 1000}::double precision)
       WHERE id = ${userId}::uuid`);
    return { status: 'claimed', leaseToken };
  });
}

/** Extend the lease; false when it was lost (reclaimed, released or already expired). */
export async function renewSuggestLease(
  db: Executor,
  userId: string,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE users
       SET suggest_lease_until = now() + make_interval(secs => ${leaseMs / 1000}::double precision)
     WHERE id = ${userId}::uuid AND suggest_lease_token = ${leaseToken}::uuid
       AND suggest_lease_until > now()`);
  return (result.rowCount ?? 0) > 0;
}

/** Release the lease only while it is still ours; never stamps `last_suggested_at`. */
export async function releaseSuggestLease(
  db: Executor,
  userId: string,
  leaseToken: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE users SET suggest_lease_token = NULL, suggest_lease_until = NULL
     WHERE id = ${userId}::uuid AND suggest_lease_token = ${leaseToken}::uuid`);
}
