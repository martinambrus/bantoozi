import type pg from 'pg';

/** What `recovery:prepare` changed in a restored database (spec 11 §4.1 step 4). */
export interface RecoveryPrepareReport {
  /** `pgboss.job` rows that were `active` in the backup: their workers no longer exist. */
  activeJobsCancelled: number;
  /** `job_outbox` rows whose relay lease was cleared (they stay pending and are relayed again). */
  outboxLeasesCleared: number;
  /** `origin_fetch_state` rows whose fetch leases were dropped. */
  originLeasesCleared: number;
  /** `running` analysis requests returned to `pending` with their lease cleared (the lease holder is gone). */
  analysisLeasesReset: number;
  /** Undelivered outbox intents after the reset; the new workers deliver them, consumers tolerate duplicates. */
  outboxPending: number;
}

/**
 * Makes a restored database safe to hand to new workers (spec 11 §4.1 step 4): no pg-boss job is
 * left `active` (a restored lease belongs to a worker that no longer exists, so each such job is
 * cancelled through the documented `pgboss.job` table, which also frees its singleton slot),
 * outbox relay leases are reset, origin fetch leases are dropped, and `running` analysis requests go
 * back to `pending`. Queued (`created`/`retry`)
 * jobs and undelivered outbox intents are kept: `house.reconcile` rebuilds eligible work from the
 * domain rows afterwards. One transaction; running it again changes nothing.
 */
export async function prepareRecovery(pool: pg.Pool): Promise<RecoveryPrepareReport> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasBoss =
      (
        await client.query<{ present: boolean }>(
          "SELECT to_regclass('pgboss.job') IS NOT NULL AS present",
        )
      ).rows[0]?.present === true;
    const cancelled = hasBoss
      ? await client.query(
          `UPDATE pgboss.job
              SET state = 'cancelled', completed_on = now(),
                  output = jsonb_build_object('message', 'cancelled by recovery:prepare')
            WHERE state = 'active'`,
        )
      : { rowCount: 0 };
    const leases = await client.query(
      'UPDATE job_outbox SET lease_token = NULL, lease_until = NULL WHERE lease_token IS NOT NULL',
    );
    const origins = await client.query(
      "UPDATE origin_fetch_state SET leases = '[]'::jsonb WHERE jsonb_array_length(leases) > 0",
    );
    // Same semantics as the worker's `defer` release (classify/analysis.ts): back to pending, lease
    // cleared, due now, attempts untouched; finished stage results stay for the resumed run. Spend
    // reservations are left alone (spec 11 §4.1 step 5 is an operator decision).
    const analysis = await client.query(
      `UPDATE analysis_requests
          SET status = 'pending', lease_token = NULL, lease_until = NULL,
              last_error_code = 'recovery_restore', next_attempt_at = now()
        WHERE status = 'running'`,
    );
    const pending = await client.query<{ count: string }>(
      'SELECT count(*) FROM job_outbox WHERE delivered_at IS NULL',
    );
    await client.query('COMMIT');
    return {
      activeJobsCancelled: cancelled.rowCount ?? 0,
      outboxLeasesCleared: leases.rowCount ?? 0,
      originLeasesCleared: origins.rowCount ?? 0,
      analysisLeasesReset: analysis.rowCount ?? 0,
      outboxPending: Number(pending.rows[0]?.count ?? 0),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function formatRecovery(report: RecoveryPrepareReport): string {
  return (
    `RECOVERY_PREPARE active_jobs_cancelled=${report.activeJobsCancelled} ` +
    `outbox_leases_cleared=${report.outboxLeasesCleared} ` +
    `origin_leases_cleared=${report.originLeasesCleared} ` +
    `analysis_leases_reset=${report.analysisLeasesReset} outbox_pending=${report.outboxPending}`
  );
}
