import {
  deleteExpiredRules,
  recordRankIntents,
  retryTransaction,
  updateSettingLocked,
  workerOutbox,
} from '@bantoozi/db';
import { parseSetting } from '@bantoozi/shared';

import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.expire-rules' as const;
/** Expired rules deleted per transaction. */
export const EXPIRE_RULES_BATCH = 1_000;

/**
 * `house.expire-rules` (hourly at minute 5, spec 11 §6): deletes the rules that expired by the
 * run's `now` in bounded batches and, in each batch's transaction, records `user.rank {full}` for
 * the affected users (bumping their rank revision, spec 06 §7). Ranking already ignores an expired
 * rule (its row's `next_rank_at` is the expiry), so the deletion only tidies and invalidates.
 * Records the run in `settings['house.progress']` for the startup catch-up.
 */
export function createExpireRulesHandler(deps: WorkerDeps): QueueHandler<'house.expire-rules'> {
  return async () => {
    const now = nowOf(deps);
    let deleted = 0;
    const users = new Set<string>();
    for (;;) {
      const batch = await retryTransaction(deps.db, async (tx) => {
        const result = await deleteExpiredRules(tx, { now, limit: EXPIRE_RULES_BATCH });
        await recordRankIntents(tx, workerOutbox(tx), result.userIds, {
          reason: 'rule_expired',
          full: true,
        });
        return result;
      });
      deleted += batch.deleted;
      for (const userId of batch.userIds) users.add(userId);
      if (batch.deleted < EXPIRE_RULES_BATCH) break;
    }
    await retryTransaction(deps.db, (tx) =>
      updateSettingLocked(tx, 'house.progress', {}, (current) => {
        const progress = parseSetting('house.progress', current ?? {});
        return parseSetting('house.progress', {
          ...progress,
          [JOB]: { updatedAt: now.toISOString(), completedAt: now.toISOString(), version: 1 },
        });
      }),
    );
    deps.logger.info({ job: JOB, deleted, users: users.size }, 'expired rules removed');
  };
}
