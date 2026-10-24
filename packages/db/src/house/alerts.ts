import { DECISION_KINDS } from '@bantoozi/shared';
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

/**
 * The `engine_calls.kind` values of classification work: the decision kinds of the kind table
 * (spec 11 §6.1, D-272). Other TypeSafe calls (credential checks, evaluations, model probes) fail on
 * purpose or for their own reasons and are not an outage of it.
 */
const CLASSIFICATION_KINDS = DECISION_KINDS;

/** A Jev answer that named another model than the one requested, grouped by the pair. */
export interface ModelMismatchGroup {
  requested: string | null;
  answered: string;
  calls: number;
  latestAt: Date;
}

/**
 * Failed TypeSafe attempts of classification work whose answer named another model (`model_mismatch:<id>`) in the window
 * `(now - windowMs, now]`: up to 5 (requested, answered) groups, newest first.
 */
export async function typesafeModelMismatches(
  db: Executor,
  now: Date,
  windowMs: number,
): Promise<ModelMismatchGroup[]> {
  const result = await db.execute<{
    requested: string | null;
    answered: string;
    calls: number;
    latest: Date | string;
  }>(sql`
    SELECT model AS requested, substr(error, length('model_mismatch:') + 1) AS answered,
           count(*)::int AS calls, max(created_at) AS latest
      FROM engine_calls
     WHERE engine = 'typesafe' AND status = 'invalid_response'
       AND kind = ANY(${sql.param([...CLASSIFICATION_KINDS])}::text[])
       AND left(error, length('model_mismatch:')) = 'model_mismatch:'
       AND created_at > ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz
       AND created_at <= ${now.toISOString()}::timestamptz
     GROUP BY model, substr(error, length('model_mismatch:') + 1)
     ORDER BY max(created_at) DESC
     LIMIT 5`);
  return result.rows.map((row) => ({
    requested: row.requested,
    answered: row.answered,
    calls: row.calls,
    latestAt: new Date(row.latest),
  }));
}

/** The newest failed TypeSafe attempt of classification work created in `[notBefore, now]`, or null. */
export async function latestTypesafeFailure(
  db: Executor,
  now: Date,
  notBefore: Date,
): Promise<{ status: string; detail: string | null; model: string | null; at: Date } | null> {
  const result = await db.execute<{
    status: string;
    detail: string | null;
    model: string | null;
    at: Date | string;
  }>(sql`
    SELECT status, error AS detail, model, created_at AS at
      FROM engine_calls
     WHERE engine = 'typesafe'
       AND kind = ANY(${sql.param([...CLASSIFICATION_KINDS])}::text[])
       AND status IN ('error', 'timeout', 'rate_limited', 'invalid_response', 'auth_error')
       AND created_at >= ${notBefore.toISOString()}::timestamptz
       AND created_at <= ${now.toISOString()}::timestamptz
     ORDER BY created_at DESC
     LIMIT 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { status: row.status, detail: row.detail, model: row.model, at: new Date(row.at) };
}

/** Distinct failed logical requests of TypeSafe classification work in `(now - windowMs, now]`, the newest failure, and whether any call of it was ok. */
export async function typesafeClassificationOutage(
  db: Executor,
  now: Date,
  windowMs: number,
): Promise<{ failedRequests: number; okCalls: number; lastFailureAt: Date | null }> {
  const result = await db.execute<{
    failed: number;
    ok: number;
    last_failure: Date | string | null;
  }>(sql`
    SELECT count(DISTINCT logical_request_id) FILTER (
             WHERE status IN ('error', 'timeout', 'rate_limited', 'invalid_response', 'auth_error')
           )::int AS failed,
           count(*) FILTER (WHERE status = 'ok')::int AS ok,
           max(created_at) FILTER (
             WHERE status IN ('error', 'timeout', 'rate_limited', 'invalid_response', 'auth_error')
           ) AS last_failure
      FROM engine_calls
     WHERE engine = 'typesafe'
       AND kind = ANY(${sql.param([...CLASSIFICATION_KINDS])}::text[])
       AND created_at > ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz
       AND created_at <= ${now.toISOString()}::timestamptz`);
  const row = result.rows[0];
  return {
    failedRequests: row?.failed ?? 0,
    okCalls: row?.ok ?? 0,
    lastFailureAt: row?.last_failure == null ? null : new Date(row.last_failure),
  };
}
