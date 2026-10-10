import {
  expireReservations,
  recordRankIntents,
  retryTransaction,
  usersDueForRank,
  workerOutbox,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.reconcile' as const;
/** Reservations or users handled per transaction. */
export const RECONCILE_BATCH = 500;
const RANK_REASON = 'next_rank_at_due';

/**
 * `house.reconcile` (every 10 minutes, spec 11 §6): turns expired `reserved` engine reservations
 * into `uncertain` (settlement is a later job) and records one deduplicated `user.rank` intent for
 * every user with an article whose `next_rank_at` is due at the run's `now`.
 */
export function createReconcileHandler(deps: WorkerDeps): QueueHandler<'house.reconcile'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    let complete = true;
    let reservations = 0;
    let ranked = 0;
    for (;;) {
      if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
        complete = false;
        break;
      }
      const changed = await retryTransaction(deps.db, (tx) =>
        expireReservations(tx, { now, limit: RECONCILE_BATCH }),
      );
      reservations += changed;
      if (changed < RECONCILE_BATCH) break;
    }
    let after: string | null = null;
    while (complete) {
      if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
        complete = false;
        break;
      }
      const cursor: string | null = after;
      const users = await retryTransaction(deps.db, async (tx) => {
        const page = await usersDueForRank(tx, { now, after: cursor, limit: RECONCILE_BATCH });
        await recordRankIntents(tx, workerOutbox(tx), page, { reason: RANK_REASON });
        return page;
      });
      ranked += users.length;
      if (users.length < RECONCILE_BATCH) break;
      after = users.at(-1) ?? null;
    }
    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: reservations + ranked,
        reservations,
        rankIntents: ranked,
        remaining: complete ? 0 : null,
      },
      'reconciled',
    );
  };
}
