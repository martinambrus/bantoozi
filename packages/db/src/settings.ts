import {
  HOUSE_PROGRESS_CURSORS,
  isKnownSettingKey,
  METRICS_DAILY_PREFIX,
  MetricsSnapshotSchema,
  preserveUnknownFields,
  settingSchema,
} from '@bantoozi/shared';
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
 * Several stored values read in one statement, so they come from one snapshot: a writer that
 * changes two of them in one transaction is seen either entirely or not at all. Missing keys are
 * absent from the map.
 */
export async function readStoredSettings(
  db: Executor,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  const result = await db.execute<{ key: string; value: unknown }>(
    sql`SELECT key, value FROM settings WHERE key = ANY(${sql.param([...keys])}::text[])`,
  );
  return new Map(result.rows.map((row) => [row.key, row.value]));
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
 * Share-lock `key` when its row exists, without storing anything: for a row that is only read when
 * present (a missing row means "none", and its first insert is not fenced). Run inside a transaction.
 */
export async function shareLockStoredSetting(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`SELECT key FROM settings WHERE key = ${key} FOR SHARE`);
}

/**
 * Read-modify-write one JSON setting under its row lock (spec 02 §3.3): a missing key is first
 * inserted with `initial` (`ON CONFLICT DO NOTHING`), then locked, so concurrent writers never
 * overwrite each other. `update` returns the new value (validated by the caller) and the stored
 * value is replaced only when it changed. Unknown fields in retained setting objects are restored
 * from the locked row after the callback validates its new known value. Returns the value now
 * stored (including those extensions). Run inside a transaction.
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
  const current = locked.rows[0]?.value;
  const updated = update(current);
  const next = isKnownSettingKey(key)
    ? preserveUnknownFields(
        key.startsWith(METRICS_DAILY_PREFIX) ? MetricsSnapshotSchema : settingSchema(key),
        current,
        updated,
      )
    : updated;
  if (key === 'house.progress') preserveProgressCursors(current, next);
  // Open JSON snapshots count retained extensions toward their total storage limit too.
  if (key.startsWith(METRICS_DAILY_PREFIX) && isKnownSettingKey(key))
    settingSchema(key).parse(next);
  await tx.execute(sql`
    UPDATE settings SET value = ${JSON.stringify(next)}::jsonb, updated_at = now()
     WHERE key = ${key} AND value IS DISTINCT FROM ${JSON.stringify(next)}::jsonb`);
  return next;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Progress cursors have per-job schemas inside the registry's otherwise open JSON field. */
function preserveProgressCursors(current: unknown, next: unknown): void {
  if (!object(current) || !object(next)) return;
  for (const [job, schema] of Object.entries(HOUSE_PROGRESS_CURSORS)) {
    const previous = current[job];
    const updated = next[job];
    if (object(previous) && object(updated) && Object.hasOwn(updated, 'cursor')) {
      updated.cursor = preserveUnknownFields(schema, previous.cursor, updated.cursor);
    }
  }
}
