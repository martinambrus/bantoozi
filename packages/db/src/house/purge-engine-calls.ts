import { PLATFORM_USER_ID, type CallKind } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Transaction } from '../client.js';
import { cancelRetentionExpired } from '../classify/analysis.js';
import { upsertUsageRow } from '../engine/store.js';
import { SELECTION_WINDOW_DAYS } from '../ingest/demand.js';
import { purgeDeliveredOutbox } from '../outbox.js';
import { daysBefore } from './snapshots.js';

const DAY_MS = 24 * 60 * 60_000;
/** Days an uncertain reservation waits for a known settlement before it settles at its reserved amount (spec 11 §5). */
export const UNCERTAIN_SETTLE_DAYS = 7;
/** Days feedback events are kept (spec 11 §5). */
export const FEEDBACK_RETENTION_DAYS = 365;
/** Days a delivered outbox intent is kept (spec 11 §5). */
export const OUTBOX_RETENTION_DAYS = 7;

const utcDate = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * Cancels up to `limit` pending or running analysis requests created 180 days or more before `now`
 * as `retention_expired`, under their row locks (spec 11 §5). Returns the number cancelled.
 */
export async function cancelStaleAnalysisRequests(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<number> {
  const found = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM analysis_requests
     WHERE status IN ('pending', 'running')
       AND created_at <= ${daysBefore(input.now, SELECTION_WINDOW_DAYS)}::timestamptz
     ORDER BY created_at LIMIT ${input.limit} FOR UPDATE SKIP LOCKED`);
  return cancelRetentionExpired(
    tx,
    found.rows.map((row) => row.id),
    input.now,
  );
}

/**
 * Settles up to `limit` uncertain reservations whose day is 7 or more UTC days before `now`'s at
 * their reserved amount and folds the spend into `usage_daily` (spec 11 §5, spec 04 §6). A
 * reservation with an audit row already has its call counted, so only the cost is added; one
 * without it adds the reserved calls too. The status guard under the row lock makes it idempotent.
 */
export async function settleUncertainReservations(
  tx: Transaction,
  input: { now: Date; limit: number },
): Promise<number> {
  const cutoff = utcDate(new Date(input.now.getTime() - UNCERTAIN_SETTLE_DAYS * DAY_MS));
  const found = await tx.execute<{
    id: string;
    day: string;
    engine: string;
    kind: string;
    reserved_usd: string;
    reserved_calls: number;
    reservation_user: string | null;
    call_user: string | null;
    has_call: boolean;
  }>(sql`
    SELECT r.id::text AS id, r.day::text AS day, r.engine, r.kind, r.reserved_usd::text AS reserved_usd,
           r.reserved_calls, r.user_id::text AS reservation_user,
           c.user_id::text AS call_user, c.id IS NOT NULL AS has_call
      FROM engine_reservations r
      LEFT JOIN engine_calls c ON c.reservation_id = r.id
     WHERE r.status = 'uncertain' AND r.day <= ${cutoff}::date
     ORDER BY r.day, r.id LIMIT ${input.limit} FOR UPDATE OF r SKIP LOCKED`);
  let settled = 0;
  for (const row of found.rows) {
    const updated = await tx.execute(sql`
      UPDATE engine_reservations
         SET status = 'settled', actual_usd = reserved_usd, settled_at = ${input.now.toISOString()}::timestamptz
       WHERE id = ${row.id}::uuid AND status = 'uncertain'`);
    if ((updated.rowCount ?? 0) === 0) continue;
    await upsertUsageRow(tx, {
      day: row.day,
      userId: row.reservation_user ?? row.call_user ?? PLATFORM_USER_ID,
      engine: row.engine,
      kind: row.kind as CallKind,
      calls: row.has_call ? 0 : row.reserved_calls,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: Number(row.reserved_usd),
    });
    settled += 1;
  }
  return settled;
}

/** The aged audit tables `house.purge-engine-calls` deletes from (spec 11 §5). */
export const PURGE_AUDIT_RULES = [
  'engineCalls',
  'settledReservations',
  'terminalRequests',
  'feedbackEvents',
  'deliveredOutbox',
] as const;
export type PurgeAuditRule = (typeof PURGE_AUDIT_RULES)[number];

/**
 * Deletes up to `limit` rows of one rule at `now` (spec 11 §5): engine calls and settled
 * reservations after 180 days, terminal analysis requests 180 days after they finished, feedback events after
 * 365 days and delivered outbox intents after 7. Aggregates in `usage_daily` are never touched.
 */
export async function purgeAuditBatch(
  tx: Transaction,
  input: { rule: PurgeAuditRule; now: Date; limit: number },
): Promise<number> {
  const { now, limit } = input;
  const retention = daysBefore(now, SELECTION_WINDOW_DAYS);
  switch (input.rule) {
    case 'engineCalls':
      return rows(
        await tx.execute(sql`
          DELETE FROM engine_calls
           WHERE id IN (SELECT id FROM engine_calls WHERE created_at <= ${retention}::timestamptz LIMIT ${limit})`),
      );
    case 'settledReservations':
      return rows(
        await tx.execute(sql`
          DELETE FROM engine_reservations
           WHERE id IN (SELECT id FROM engine_reservations
                         WHERE status = 'settled'
                           AND day <= ${utcDate(new Date(retention))}::date LIMIT ${limit})`),
      );
    case 'terminalRequests':
      return rows(
        await tx.execute(sql`
          DELETE FROM analysis_requests
           WHERE id IN (SELECT id FROM analysis_requests
                         WHERE status IN ('complete', 'failed', 'cancelled')
                           AND coalesce(completed_at, created_at) <= ${retention}::timestamptz LIMIT ${limit})`),
      );
    case 'feedbackEvents':
      return rows(
        await tx.execute(sql`
          DELETE FROM feedback_events
           WHERE id IN (SELECT id FROM feedback_events
                         WHERE created_at <= ${daysBefore(now, FEEDBACK_RETENTION_DAYS)}::timestamptz
                         ORDER BY id LIMIT ${limit})`),
      );
    case 'deliveredOutbox':
      return purgeDeliveredOutbox(tx, OUTBOX_RETENTION_DAYS, { now, limit });
  }
}

const rows = (result: { rowCount: number | null }): number => result.rowCount ?? 0;
