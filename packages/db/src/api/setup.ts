import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';

/**
 * First-run setup (M8b-T6, spec 08 §2.1): the admin bootstrap guarded by a one-time token whose
 * keyed digest lives in `settings['auth.setup']`. These functions run as the API role; `users`,
 * `settings` and `waitlist` grants already allow them (no SECURITY DEFINER function needed).
 */

/** Whether an active (not soft-deleted) admin exists. */
export async function activeAdminExists(db: Executor): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`,
  );
  return result.rows.length > 0;
}

/** Emails of the active (not soft-deleted) admins, ordered (alert recipients, M8b-T7). */
export async function activeAdminEmails(db: Executor): Promise<string[]> {
  const result = await db.execute<{ email: string }>(
    sql`SELECT email::text AS email FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY email`,
  );
  return result.rows.map((row) => row.email);
}

/** Serialize setup attempts and token rotation: a transaction-scoped advisory lock. */
export async function lockSetup(tx: Transaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('bantoozi:setup', 0))`);
}

/** Replace `settings['auth.setup']` wholesale (a new token invalidates the previous one). */
export async function replaceSetupState(tx: Executor, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await tx.execute(sql`
    INSERT INTO settings (key, value) VALUES ('auth.setup', ${json}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
}

/** `settings['auth.setup']` locked `FOR UPDATE`; `undefined` when the row is missing. */
export async function lockSetupState(tx: Executor): Promise<unknown> {
  const result = await tx.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = 'auth.setup' FOR UPDATE`,
  );
  return result.rows[0]?.value;
}

/** Promote an active user to admin, keeping the row. `false` when no active user has the email. */
export async function promoteActiveUserToAdmin(
  tx: Executor,
  input: { email: string },
): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`
    UPDATE users SET role = 'admin'
     WHERE email = ${input.email}::citext AND deleted_at IS NULL
    RETURNING id::text AS id`);
  return result.rows[0]?.id ?? null;
}
