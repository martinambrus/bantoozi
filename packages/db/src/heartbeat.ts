import { sql } from 'drizzle-orm';

import type { Executor } from './client.js';

/**
 * `settings['worker.heartbeat']` (spec 02 §2): `{[processId]: {at, queues, evalIngestOnly,
 * envCredentials}}`, written by every worker process every 30 s. Entries older than an hour are
 * pruned by every write. The caller validates the entry with the shared registry schema.
 */
export const HEARTBEAT_KEY = 'worker.heartbeat';
export const HEARTBEAT_PRUNE_MS = 60 * 60 * 1000;

export interface HeartbeatEntry {
  at: string;
  queues: string[];
  evalIngestOnly: boolean;
  envCredentials: ('typesafe' | 'ollama')[];
}

/**
 * Upsert this process's entry and prune stale ones in one statement, so concurrent workers never
 * overwrite each other's entries.
 */
export async function recordWorkerHeartbeat(
  db: Executor,
  processId: string,
  entry: HeartbeatEntry,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_PRUNE_MS).toISOString();
  const value = JSON.stringify({ [processId]: entry });
  await db.execute(sql`
    INSERT INTO settings (key, value) VALUES (${HEARTBEAT_KEY}, ${value}::jsonb)
    ON CONFLICT (key) DO UPDATE SET
      value = coalesce((
        SELECT jsonb_object_agg(e.key, e.value)
          FROM jsonb_each(settings.value) AS e
         WHERE e.key <> ${processId}
           AND jsonb_typeof(e.value) = 'object'
           AND (e.value->>'at') IS NOT NULL
           AND (e.value->>'at')::timestamptz >= ${cutoff}::timestamptz
      ), '{}'::jsonb) || ${value}::jsonb,
      updated_at = now()`);
}

/** Remove this process's entry (graceful shutdown). */
export async function removeWorkerHeartbeat(db: Executor, processId: string): Promise<void> {
  await db.execute(sql`
    UPDATE settings SET value = value - ${processId}, updated_at = now()
     WHERE key = ${HEARTBEAT_KEY} AND value ? ${processId}`);
}
