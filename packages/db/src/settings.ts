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
 * Share-lock the rows of `settings` until the transaction ends, in key order: a writer of any of
 * them waits for this transaction, and a write in progress is waited for, so the values read after
 * this stay current until commit. A missing row cannot be locked, and its first write (an insert)
 * would slip in between the read and the commit, so a missing key is first stored with `initial`,
 * the default its readers fall back to, which leaves its effective value unchanged; an insert in
 * progress is waited for. Run inside a transaction.
 */
export async function shareLockSettings(
  tx: Executor,
  settings: readonly { key: string; initial: unknown }[],
): Promise<void> {
  const keys = settings.map((setting) => setting.key);
  const values = settings.map(({ key, initial }) => {
    if (initial === undefined) throw new RangeError(`setting ${key} needs an initial value`);
    return JSON.stringify(initial);
  });
  await tx.execute(sql`
    INSERT INTO settings (key, value)
    SELECT s.key, s.value::jsonb
      FROM unnest(${sql.param(keys)}::text[], ${sql.param(values)}::text[]) AS s(key, value)
     ORDER BY s.key
    ON CONFLICT (key) DO NOTHING`);
  await tx.execute(sql`
    SELECT key FROM settings WHERE key = ANY(${sql.param(keys)}::text[])
     ORDER BY key FOR SHARE`);
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
