import { newUserId } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';

/**
 * The internal evaluation user (spec 10 §2.1): the subscriber of the golden feeds, so the normal
 * schedule keeps fetching them. It has role `user`, no invites and an address no mail reaches, so
 * it never logs in; its subscriptions keep inference `off`, so subscribing authorizes no model
 * call (spec 10 §3).
 *
 * Its presence also marks the **golden database** (D-96): a worker started without
 * `EVAL_INGEST_ONLY=true` refuses to consume a database that holds it, and an ingest-only worker
 * stops after extraction (spec 10 §2.1).
 */
export const EVAL_USER_EMAIL = 'eval@bantoozi.local';

/** Create the evaluation user when missing (idempotent); its id either way. */
export async function ensureEvalUser(tx: Transaction): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO users (id, email, display_name, role, invites_left)
    VALUES (${newUserId()}::uuid, ${EVAL_USER_EMAIL}, 'Evaluation (system)', 'user', 0)
    ON CONFLICT (email) DO NOTHING RETURNING id::text AS id`);
  const created = inserted.rows[0];
  if (created !== undefined) return { id: created.id, created: true };
  const existing = await tx.execute<{ id: string; deleted: boolean }>(sql`
    SELECT id::text AS id, deleted_at IS NOT NULL AS deleted FROM users WHERE email = ${EVAL_USER_EMAIL}`);
  const row = existing.rows[0];
  if (row === undefined) throw new Error('the evaluation user disappeared');
  if (row.deleted)
    throw new Error(`${EVAL_USER_EMAIL} is soft-deleted; restore it before collecting`);
  return { id: row.id, created: false };
}

/** The evaluation user's id, or null when this database has none (it is not a golden database). */
export async function evalUserId(db: Executor): Promise<string | null> {
  const result = await db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM users WHERE email = ${EVAL_USER_EMAIL}`,
  );
  return result.rows[0]?.id ?? null;
}

/** Whether this database is a golden (evaluation collection) database: it holds the eval user. */
export async function isGoldenDatabase(db: Executor): Promise<boolean> {
  return (await evalUserId(db)) !== null;
}
