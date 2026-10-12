import type pg from 'pg';

/** What `recovery:prepare` changed in a restored database (spec 11 §4.1 step 4). */
export interface RecoveryPrepareReport {
  /** Every `active` job from the backup: made runnable again (`retry`, start now), limit raised if exhausted. */
  activeJobsRequeued: number;
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
 * left `active` (a restored lease belongs to a worker that no longer exists, and the outbox intent
 * behind the job is usually already delivered, so the job is the only copy of the work: it is
 * requeued, whatever its `retry_count`: state `retry` and start now with its data and singleton keys
 * kept, and `retry_limit` raised to `retry_count + 1` when exhausted so pg-boss runs it once more;
 * handlers tolerate the duplicate run),
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
    // Mirrors pg-boss 10.4.2 failJobs: retry while retry_count < retry_limit (the next fetch bumps
    // retry_count), otherwise failed with completed_on set. started_on is kept as pg-boss keeps it.
    const requeued = hasBoss
      ? await client.query(
          `UPDATE pgboss.job
              SET state = 'retry'::pgboss.job_state,
                  start_after = now(),
                  completed_on = NULL,
                  retry_limit = GREATEST(retry_limit, retry_count + 1),
                  output = jsonb_build_object('message', 'active job restored by recovery:prepare')
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
      activeJobsRequeued: requeued.rowCount ?? 0,
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
    `RECOVERY_PREPARE active_jobs_requeued=${report.activeJobsRequeued} ` +
    `outbox_leases_cleared=${report.outboxLeasesCleared} ` +
    `origin_leases_cleared=${report.originLeasesCleared} ` +
    `analysis_leases_reset=${report.analysisLeasesReset} outbox_pending=${report.outboxPending}`
  );
}
