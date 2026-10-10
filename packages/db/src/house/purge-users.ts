import { createHash } from 'node:crypto';

import { PLATFORM_USER_ID, planMinIntervalMap } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';

const DAY_MS = 24 * 60 * 60_000;
/** Days an erased account waits, restorable, before it is hard-deleted (spec 11 §5.1). */
export const USER_ERASURE_GRACE_DAYS = 7;
/** Rows of a large per-user table deleted per transaction (spec 11 §5.1). */
export const USER_PREDELETE_BATCH = 5_000;

/** A deletion ledger entry (spec 11 §5.1); `id` is stable per user, so a retry reuses it. */
export interface DeletionLedgerEntry {
  id: string;
  userId: string;
  deletedAt: string;
  emailHmac: string;
}

export interface DueUser {
  id: string;
  email: string;
  deletedAt: Date;
}

/** The stable id of a user's ledger entry. */
export const deletionLedgerEntryId = (userId: string): string =>
  createHash('sha256').update(`deletion:${userId}`).digest('hex');

/** Up to `limit` users erased 7 days or more before `now`, after `after` by id (spec 11 §5.1). */
export async function listUsersDueForPurge(
  db: Database,
  input: { now: Date; after: string | null; limit: number },
): Promise<DueUser[]> {
  const cutoff = new Date(input.now.getTime() - USER_ERASURE_GRACE_DAYS * DAY_MS).toISOString();
  const result = await db.execute<{ id: string; email: string; deleted_at: Date | string }>(sql`
    SELECT id::text AS id, email::text AS email, deleted_at FROM users
     WHERE deleted_at IS NOT NULL AND deleted_at <= ${cutoff}::timestamptz
       AND id > ${input.after ?? PLATFORM_USER_ID}::uuid
     ORDER BY id LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    deletedAt: new Date(row.deleted_at),
  }));
}

export type PurgeUserOutcome = 'deleted' | 'skipped' | 'blocked' | 'ledger_failed';

const lockDue = async (tx: Transaction, user: DueUser, now: Date) => {
  const cutoff = new Date(now.getTime() - USER_ERASURE_GRACE_DAYS * DAY_MS).toISOString();
  const locked = await tx.execute<{ email: string; deleted_at: Date | string }>(sql`
    SELECT email::text AS email, deleted_at FROM users
     WHERE id = ${user.id}::uuid AND deleted_at IS NOT NULL AND deleted_at <= ${cutoff}::timestamptz
     FOR UPDATE`);
  return locked.rows[0];
};

/**
 * Hard-deletes one erased user whose 7-day grace has passed (spec 11 §5.1). The ledger entry is
 * appended first, while the user row still exists and is locked; a failing append leaves the user
 * untouched (`ledger_failed`). A user whose private card an `eval` row or a library version still
 * references is `blocked` (those foreign keys restrict). Large tables go in batches, the user's
 * usage folds into the platform bucket, and the feeds' counters and the snapshots' marks are
 * refreshed after the delete.
 */
export async function purgeUser(
  db: Database,
  user: DueUser,
  input: {
    now: Date;
    emailHmac: (email: string) => string;
    append: (entry: DeletionLedgerEntry) => Promise<void>;
  },
): Promise<PurgeUserOutcome> {
  const { now } = input;
  const prepared = await db.transaction(async (tx) => {
    const row = await lockDue(tx, user, now);
    if (row === undefined) return 'skipped' as const;
    const blocked = await tx.execute(sql`
      SELECT 1 FROM interest_cards c
       WHERE c.owner_user_id = ${user.id}::uuid
         AND (EXISTS (SELECT 1 FROM eval.rater_cards x WHERE x.card_id = c.id)
              OR EXISTS (SELECT 1 FROM eval.run_answers x WHERE x.card_id = c.id)
              OR EXISTS (SELECT 1 FROM library_card_versions v
                          WHERE v.card_id = c.id OR v.previous_card_id = c.id))
       LIMIT 1`);
    if (blocked.rows.length > 0) return 'blocked' as const;
    const snapshots = await tx.execute<{ id: string }>(sql`
      SELECT bookmark_snapshot_id::text AS id FROM user_article
       WHERE user_id = ${user.id}::uuid AND bookmark_snapshot_id IS NOT NULL
      UNION
      SELECT p.snapshot_id::text FROM bookmark_snapshot_pins p WHERE p.user_id = ${user.id}::uuid`);
    try {
      await input.append({
        id: deletionLedgerEntryId(user.id),
        userId: user.id,
        deletedAt: new Date(row.deleted_at).toISOString(),
        emailHmac: input.emailHmac(row.email),
      });
    } catch {
      return 'ledger_failed' as const;
    }
    return { email: row.email, snapshotIds: snapshots.rows.map((r) => r.id) };
  });
  if (typeof prepared === 'string') return prepared;

  for (const table of ['user_article', 'feedback_events'] as const) {
    for (;;) {
      const deleted = await db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          DELETE FROM ${sql.raw(table)}
           WHERE ctid IN (SELECT ctid FROM ${sql.raw(table)}
                           WHERE user_id = ${user.id}::uuid LIMIT ${USER_PREDELETE_BATCH})`);
        return result.rowCount ?? 0;
      });
      if (deleted < USER_PREDELETE_BATCH) break;
    }
  }

  return db.transaction(async (tx) => {
    if ((await lockDue(tx, user, now)) === undefined) return 'skipped' as const;
    const feeds = await tx.execute<{ feed_id: string }>(sql`
      SELECT feed_id::text AS feed_id FROM subscriptions
       WHERE user_id = ${user.id}::uuid ORDER BY feed_id`);
    await tx.execute(sql`
      INSERT INTO usage_daily AS u (day, user_id, engine, kind, calls, input_tokens, output_tokens, cost_usd)
      SELECT day, ${PLATFORM_USER_ID}::uuid, engine, kind, sum(calls)::int, sum(input_tokens),
             sum(output_tokens), sum(cost_usd)
        FROM usage_daily WHERE user_id = ${user.id}::uuid GROUP BY day, engine, kind
      ON CONFLICT (day, user_id, engine, kind) DO UPDATE
         SET calls = u.calls + EXCLUDED.calls,
             input_tokens = u.input_tokens + EXCLUDED.input_tokens,
             output_tokens = u.output_tokens + EXCLUDED.output_tokens,
             cost_usd = u.cost_usd + EXCLUDED.cost_usd`);
    await tx.execute(sql`DELETE FROM usage_daily WHERE user_id = ${user.id}::uuid`);
    await tx.execute(sql`
      DELETE FROM job_outbox WHERE user_id = ${user.id}::uuid AND delivered_at IS NULL`);
    await tx.execute(sql`
      UPDATE invites SET email = NULL, note = NULL WHERE used_by = ${user.id}::uuid`);
    await tx.execute(sql`DELETE FROM invites WHERE email = ${prepared.email} AND used_at IS NULL`);
    await tx.execute(sql`DELETE FROM waitlist WHERE email = ${prepared.email}`);
    // The evidence guard allows the creator clear only once `user_id` is NULL (spec 02 §3.6), so
    // the requests are found first, and cleared after the delete's FK has nulled their `user_id`.
    const evidenced = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM card_publication_requests
       WHERE authorization_evidence->>'creatorUserId' = ${user.id}`);
    await tx.execute(sql`DELETE FROM users WHERE id = ${user.id}::uuid`);
    if (evidenced.rows.length > 0) {
      await tx.execute(sql`
        UPDATE card_publication_requests
           SET authorization_evidence = jsonb_set(authorization_evidence, '{creatorUserId}', 'null'::jsonb)
         WHERE id = ANY(${sql.param(evidenced.rows.map((r) => r.id))}::bigint[])
           AND user_id IS NULL`);
    }
    const feedIds = feeds.rows.map((row) => row.feed_id);
    if (feedIds.length > 0) {
      await tx.execute(sql`
        SELECT refresh_feed_subscribers(${sql.param(feedIds)}::bigint[],
                                        ${JSON.stringify(planMinIntervalMap())}::jsonb)`);
      await tx.execute(sql`SELECT refresh_feed_cards(${sql.param(feedIds)}::bigint[])`);
    }
    for (const id of prepared.snapshotIds) {
      await tx.execute(sql`SELECT mark_snapshot_if_unreferenced(${id}::bigint)`);
    }
    return 'deleted' as const;
  });
}
