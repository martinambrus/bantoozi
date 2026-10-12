import {
  archiveOverCapItems,
  archiveReadItems,
  countArchivableReadItems,
  retryTransaction,
  usersOverUnreadCap,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.archive' as const;
/** Reader rows archived per transaction. */
export const ARCHIVE_BATCH = 500;
const USER_PAGE = 100;

/**
 * `house.archive` (daily at 03:15, spec 11 §5, §6): archives read, unprotected items 31 days after
 * their latest carrier arrival and the unread items beyond 1,000 per subscribed feed. Each archive
 * is a versioned reader-state write (`archived_at`, `state_version + 1`) with no feedback event
 * (spec 08 §1.1), made under the row lock, so an offline action built before it gets `STALE_STATE`.
 */
export function createArchiveHandler(deps: WorkerDeps): QueueHandler<'house.archive'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const expired = () => Date.now() - started > HOUSE_RUN_BUDGET_MS;
    let affected = 0;
    let complete = true;

    for (;;) {
      if (expired()) {
        complete = false;
        break;
      }
      const archived = await retryTransaction(deps.db, (tx) =>
        archiveReadItems(tx, { now, limit: ARCHIVE_BATCH }),
      );
      affected += archived;
      if (archived < ARCHIVE_BATCH) break;
    }

    let after: string | null = null;
    while (complete) {
      const cursor: string | null = after;
      const users: string[] = await retryTransaction(deps.db, (tx) =>
        usersOverUnreadCap(tx, { after: cursor, limit: USER_PAGE }),
      );
      if (users.length === 0) break;
      for (const userId of users) {
        for (;;) {
          if (expired()) {
            complete = false;
            break;
          }
          const archived = await retryTransaction(deps.db, (tx) =>
            archiveOverCapItems(tx, { userId, now, limit: ARCHIVE_BATCH }),
          );
          affected += archived;
          if (archived < ARCHIVE_BATCH) break;
        }
        if (!complete) break;
      }
      after = users.at(-1) ?? null;
    }

    const remaining = complete
      ? 0
      : await retryTransaction(deps.db, (tx) => countArchivableReadItems(tx, now));
    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      { job: JOB, durationMs: Date.now() - started, affected, remaining },
      'items archived',
    );
  };
}
