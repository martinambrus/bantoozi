import {
  PURGE_AUTH_RULES,
  purgeAuthBatch,
  retryTransaction,
  updateSettingLocked,
  type PurgeAuthRule,
} from '@bantoozi/db';
import { parseSetting, type HouseProgressJob } from '@bantoozi/shared';

import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.purge-auth' as const;
/** Rows deleted per transaction. */
export const PURGE_AUTH_BATCH = 1_000;
/** Wall time after which a housekeeping run stops starting batches and leaves the rest to its next run. */
export const HOUSE_RUN_BUDGET_MS = 5 * 60_000;

/** Records a housekeeping run in `settings['house.progress']` (spec 02 §2, spec 11 §6). */
export async function recordHouseProgress(
  deps: WorkerDeps,
  job: HouseProgressJob,
  now: Date,
  complete: boolean,
): Promise<void> {
  await retryTransaction(deps.db, (tx) =>
    updateSettingLocked(tx, 'house.progress', {}, (current) => {
      const progress = parseSetting('house.progress', current ?? {});
      const completedAt = complete ? now.toISOString() : progress[job]?.completedAt;
      return parseSetting('house.progress', {
        ...progress,
        [job]: {
          updatedAt: now.toISOString(),
          ...(completedAt === undefined ? {} : { completedAt }),
          version: 1,
        },
      });
    }),
  );
}

/**
 * `house.purge-auth` (hourly at minute 20, spec 11 §5, §6): deletes login codes, sessions,
 * rate-limit buckets, idle origin state, invites, waitlist rows and API receipts past their
 * retention at the run's `now`, in bounded batches. Rules are idempotent, so an unfinished pass
 * simply continues at the next run.
 */
export function createPurgeAuthHandler(deps: WorkerDeps): QueueHandler<'house.purge-auth'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    let affected = 0;
    let complete = true;
    for (const rule of Object.keys(PURGE_AUTH_RULES) as PurgeAuthRule[]) {
      for (;;) {
        if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
          complete = false;
          break;
        }
        const deleted = await retryTransaction(deps.db, (tx) =>
          purgeAuthBatch(tx, { rule, now, limit: PURGE_AUTH_BATCH }),
        );
        affected += deleted;
        if (deleted < PURGE_AUTH_BATCH) break;
      }
      if (!complete) break;
    }
    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      { job: JOB, durationMs: Date.now() - started, affected, remaining: complete ? 0 : null },
      'auth data purged',
    );
  };
}
