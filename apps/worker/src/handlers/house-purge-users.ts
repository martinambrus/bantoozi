import { listUsersDueForPurge, purgeUser, type DueUser } from '@bantoozi/db';
import { deletionEmailHmac } from '@bantoozi/shared/server';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.purge-users' as const;
/** Users listed per page. */
export const PURGE_USERS_PAGE = 50;

/**
 * `house.purge-users` (daily at 05:00, spec 11 §5.1, §6): hard-deletes accounts erased 7 days
 * ago. Each user's encrypted deletion ledger entry is appended first; without a configured
 * ledger and HMAC key, or when the append fails, the user is kept for the next run (with no
 * ledger the run records `disabled: ledger_unconfigured` in `house.progress` when users are due). A user whose
 * private card an eval or library row still references is skipped and logged.
 */
export function createPurgeUsersHandler(deps: WorkerDeps): QueueHandler<'house.purge-users'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const ledger = deps.deletionLedger;
    const key = deps.deletionHmacKey;
    if (ledger === undefined || key === undefined) {
      // Production refuses to start without them (loadConfig); elsewhere erasure waits, and
      // `house.alerts` raises `erasure.disabled` while a user is past the grace period.
      const due = await listUsersDueForPurge(deps.db, { now, after: null, limit: 1 });
      deps.logger.warn({ job: JOB, due: due.length > 0 }, 'deletion_ledger_unconfigured');
      await recordHouseProgress(
        deps,
        JOB,
        now,
        due.length === 0,
        due.length > 0 ? { disabled: 'ledger_unconfigured' } : undefined,
      );
      return;
    }
    const counts = { deleted: 0, skipped: 0, blocked: 0, ledgerFailed: 0, failed: 0 };
    let complete = true;
    let after: string | null = null;
    scan: for (;;) {
      const page: DueUser[] = await listUsersDueForPurge(deps.db, {
        now,
        after,
        limit: PURGE_USERS_PAGE,
      });
      for (const user of page) {
        if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
          complete = false;
          break scan;
        }
        try {
          const outcome = await purgeUser(deps.db, user, {
            now,
            emailHmac: (email) => deletionEmailHmac(email, key),
            append: (entry) => ledger.append(entry),
          });
          if (outcome === 'deleted') counts.deleted += 1;
          else if (outcome === 'skipped') counts.skipped += 1;
          else if (outcome === 'blocked') {
            counts.blocked += 1;
            deps.logger.warn({ job: JOB, userId: user.id }, 'user_purge_blocked_by_card_reference');
          } else {
            counts.ledgerFailed += 1;
            deps.logger.error({ job: JOB, userId: user.id }, 'deletion_ledger_append_failed');
          }
        } catch (err) {
          counts.failed += 1;
          deps.logger.error({ job: JOB, userId: user.id, err }, 'user_purge_failed');
        }
        after = user.id;
      }
      if (page.length < PURGE_USERS_PAGE) break;
    }

    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: counts.deleted,
        ...counts,
        remaining: complete ? 0 : null,
      },
      'erased users purged',
    );
  };
}
