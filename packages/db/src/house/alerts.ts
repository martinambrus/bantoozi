import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';

const HOUR_MS = 60 * 60_000;

/** A queue's due waiting jobs at `now` (spec 11 §6.1 "Pipeline backlog"). */
export interface QueueBacklog {
  queue: string;
  due: number;
  /** Seconds since the oldest due job became due. */
  oldestDueSeconds: number;
}

/**
 * Per queue, the pg-boss jobs waiting to run (`created`/`retry` with `start_after <= now`) and the
 * age of the oldest; jobs scheduled for later (cooldowns) are excluded (spec 11 §6.1).
 */
export async function dueJobBacklog(db: Executor, now: Date): Promise<QueueBacklog[]> {
  const at = now.toISOString();
  const result = await db.execute<{ queue: string; due: number; age: number }>(sql`
    SELECT name AS queue, count(*)::int AS due,
           extract(epoch FROM ${at}::timestamptz - min(start_after))::float8 AS age
      FROM pgboss.job
     WHERE state IN ('created', 'retry') AND start_after <= ${at}::timestamptz
     GROUP BY name`);
  return result.rows.map((row) => ({
    queue: row.queue,
    due: row.due,
    oldestDueSeconds: row.age,
  }));
}

/**
 * pg-boss jobs that failed terminally (`state = 'failed'`, by `completed_on`) in the hour before `now`
 * and in the 24 hours before that hour (spec 11 §6.1 "rising terminal failures").
 */
export async function terminalFailureCounts(
  db: Executor,
  now: Date,
): Promise<{ lastHour: number; previous24h: number }> {
  const result = await db.execute<{ last_hour: number; previous: number }>(sql`
    SELECT (count(*) FILTER (WHERE completed_on > ${new Date(now.getTime() - HOUR_MS).toISOString()}::timestamptz))::int
             AS last_hour,
           (count(*) FILTER (WHERE completed_on <= ${new Date(now.getTime() - HOUR_MS).toISOString()}::timestamptz))::int
             AS previous
      FROM pgboss.job
     WHERE state = 'failed'
       AND completed_on > ${new Date(now.getTime() - 25 * HOUR_MS).toISOString()}::timestamptz
       AND completed_on <= ${now.toISOString()}::timestamptz`);
  return { lastHour: result.rows[0]?.last_hour ?? 0, previous24h: result.rows[0]?.previous ?? 0 };
}

/** New articles of the hour before `now` and how many of them are `degraded` (spec 11 §6.1). */
export async function degradedShareLastHour(
  db: Executor,
  now: Date,
): Promise<{ total: number; degraded: number }> {
  const result = await db.execute<{ total: number; degraded: number }>(sql`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE pipeline_state = 'degraded'))::int AS degraded
      FROM articles
     WHERE first_seen_at > ${new Date(now.getTime() - HOUR_MS).toISOString()}::timestamptz
       AND first_seen_at <= ${now.toISOString()}::timestamptz`);
  return { total: result.rows[0]?.total ?? 0, degraded: result.rows[0]?.degraded ?? 0 };
}

/** Subscribed active/quarantined feeds and those whose last error is within 24 h (spec 11 §6.1). */
export async function feedErrorShare24h(
  db: Executor,
  now: Date,
): Promise<{ total: number; errored: number }> {
  const result = await db.execute<{ total: number; errored: number }>(sql`
    SELECT count(*)::int AS total,
           (count(*) FILTER (
              WHERE last_error_at > ${new Date(now.getTime() - 24 * HOUR_MS).toISOString()}::timestamptz
                AND last_error_at <= ${now.toISOString()}::timestamptz))::int AS errored
      FROM feeds
     WHERE subscriber_count > 0 AND status IN ('active', 'quarantined')`);
  return { total: result.rows[0]?.total ?? 0, errored: result.rows[0]?.errored ?? 0 };
}

/** The newest `limit` stored `metrics.daily.<date>` snapshots as `[day, value]`, newest first (spec 10 §7). */
export async function latestMetricsSnapshots(
  db: Executor,
  limit: number,
): Promise<Array<[string, unknown]>> {
  const result = await db.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM settings
     WHERE key ~ '^metrics\\.daily\\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     ORDER BY key DESC LIMIT ${limit}`);
  return result.rows.map((row) => [row.key.slice('metrics.daily.'.length), row.value]);
}
