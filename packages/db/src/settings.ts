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
