import { sql } from 'drizzle-orm';

import type { Executor } from './client.js';

/**
 * Settings rows (spec 02 §2). Values are validated by the caller with the shared registry
 * (`parseSetting`); these helpers only persist them.
 */

/** Insert a setting only when its key is missing; `true` when this call inserted it. */
export async function insertSettingIfMissing(
  db: Executor,
  key: string,
  value: unknown,
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO NOTHING`);
  return result.rowCount === 1;
}

/** The stored value of a setting, or `undefined` when the row is missing. */
export async function readStoredSetting(db: Executor, key: string): Promise<unknown> {
  const result = await db.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = ${key}`,
  );
  return result.rows[0]?.value;
}

/**
 * Read-modify-write one JSON setting under its row lock (spec 02 §3.3): a missing key is first
 * inserted with `initial` (`ON CONFLICT DO NOTHING`), then locked, so concurrent writers never
 * overwrite each other. `update` returns the new value (validated by the caller) and the stored
 * value is replaced only when it changed. Returns the value now stored. Run inside a transaction.
 */
export async function updateSettingLocked<T>(
  tx: Executor,
  key: string,
  initial: T,
  update: (current: unknown) => T,
): Promise<T> {
  await insertSettingIfMissing(tx, key, initial);
  const locked = await tx.execute<{ value: unknown }>(
    sql`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`,
  );
  const next = update(locked.rows[0]?.value);
  await tx.execute(sql`
    UPDATE settings SET value = ${JSON.stringify(next)}::jsonb, updated_at = now()
     WHERE key = ${key} AND value IS DISTINCT FROM ${JSON.stringify(next)}::jsonb`);
  return next;
}
