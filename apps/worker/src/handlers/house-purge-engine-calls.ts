import {
  cancelStaleAnalysisRequests,
  PURGE_AUDIT_RULES,
  purgeAuditBatch,
  retryTransaction,
  settleUncertainReservations,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.purge-engine-calls' as const;
/** Rows handled per transaction. */
export const PURGE_ENGINE_CALLS_BATCH = 1_000;

/**
 * `house.purge-engine-calls` (daily at 04:00, spec 11 §5, §6): cancels analysis requests past 180
 * days, settles uncertain reservations 7 days after their day at the reserved amount, then
 * deletes engine calls, settled reservations, finished requests, old feedback events and
 * delivered outbox intents past their retention. `usage_daily` totals are never reduced.
 */
export function createPurgeEngineCallsHandler(
  deps: WorkerDeps,
): QueueHandler<'house.purge-engine-calls'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const counts: Record<string, number> = { cancelled: 0, settled: 0 };
    let complete = true;
    const expired = (): boolean => Date.now() - started > HOUSE_RUN_BUDGET_MS;

    const drain = async (key: string, step: () => Promise<number>): Promise<void> => {
      counts[key] ??= 0;
      while (complete) {
        if (expired()) {
          complete = false;
          return;
        }
        const n = await step();
        counts[key] += n;
        if (n < PURGE_ENGINE_CALLS_BATCH) return;
      }
    };
    const limit = PURGE_ENGINE_CALLS_BATCH;
    await drain('cancelled', () =>
      retryTransaction(deps.db, (tx) => cancelStaleAnalysisRequests(tx, { now, limit })),
    );
    await drain('settled', () =>
      retryTransaction(deps.db, (tx) => settleUncertainReservations(tx, { now, limit })),
    );
    for (const rule of PURGE_AUDIT_RULES) {
      await drain(rule, () =>
        retryTransaction(deps.db, (tx) => purgeAuditBatch(tx, { rule, now, limit })),
      );
    }

    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: Object.values(counts).reduce((a, b) => a + b, 0),
        ...counts,
        remaining: complete ? 0 : null,
      },
      'engine audit data purged',
    );
  };
}
