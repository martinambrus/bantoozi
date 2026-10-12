import {
  expireReservations,
  recordRankIntents,
  retryTransaction,
  usersDueForRank,
  workerOutbox,
} from '@bantoozi/db';
import { enqueueReenrich, enqueueRematch } from '@bantoozi/shared';

import { primaryAvailability } from '../classify/availability.js';
import { nowOf, type ClassificationDeps, type WorkerDeps } from './deps.js';
import {
  HOUSE_RUN_BUDGET_MS,
  readSweepCursors,
  recordHouseProgress,
  sweepCursorOf,
  takePendingRuns,
} from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.reconcile' as const;
/** Reservations or users handled per transaction. */
export const RECONCILE_BATCH = 500;
const RANK_REASON = 'next_rank_at_due';
/** The name of the due-user sweep in `house.progress`' saved cursor. */
const RANK_SWEEP = 'rank';

/**
 * `house.reconcile` (every 10 minutes, spec 11 §6): turns expired `reserved` engine reservations
 * into `uncertain` (settlement is a later job) and records one deduplicated `user.rank` intent for
 * every user with an article whose `next_rank_at` is due at the run's `now`. Once the primary
 * engine is available again it enqueues the `house.reenrich` / `house.rematch` runs that found it
 * unavailable and are recorded as pending in `house.progress` (spec 11 §6).
 */
export function createReconcileHandler(
  deps: WorkerDeps,
  classification?: ClassificationDeps,
): QueueHandler<'house.reconcile'> {
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
    // The due-user sweep resumes after the position a budget-cut run saved: users stay due until
    // ranked, so starting over each run would revisit the same low-id prefix and starve the rest.
    const sweeps = await readSweepCursors(deps, JOB);
    let after: string | null = sweeps[RANK_SWEEP] ?? null;
    while (complete) {
      if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
        complete = false;
        if (after !== null) sweeps[RANK_SWEEP] = after;
        break;
      }
      const cursor: string | null = after;
      const users = await retryTransaction(deps.db, async (tx) => {
        const page = await usersDueForRank(tx, { now, after: cursor, limit: RECONCILE_BATCH });
        await recordRankIntents(tx, workerOutbox(tx), page, { reason: RANK_REASON });
        return page;
      });
      ranked += users.length;
      if (users.length < RECONCILE_BATCH) {
        delete sweeps[RANK_SWEEP];
        break;
      }
      after = users.at(-1) ?? null;
    }
    const resumed =
      classification === undefined ? 0 : await resumePendingRebuilds(deps, classification, now);
    await recordHouseProgress(deps, JOB, now, complete, sweepCursorOf(sweeps));
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: reservations + ranked,
        reservations,
        rankIntents: ranked,
        resumedRebuilds: resumed,
        remaining: complete ? 0 : null,
      },
      'reconciled',
    );
  };
}

/** Re-enqueues each pending rebuild run once, and only while the primary engine is available. */
async function resumePendingRebuilds(
  deps: WorkerDeps,
  classification: ClassificationDeps,
  now: Date,
): Promise<number> {
  const availability = await primaryAvailability(
    deps.db,
    classification.router,
    deps.settingsEnv,
    now,
  );
  if (!availability.available) return 0;
  return retryTransaction(deps.db, async (tx) => {
    const sender = workerOutbox(tx);
    const reenrich = await takePendingRuns(tx, 'house.reenrich', now);
    for (const run of reenrich) await enqueueReenrich(sender, run);
    const rematch = await takePendingRuns(tx, 'house.rematch', now);
    for (const run of rematch) await enqueueRematch(sender, run);
    return reenrich.length + rematch.length;
  });
}
