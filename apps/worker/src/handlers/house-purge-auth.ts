import {
  PURGE_AUTH_RULES,
  purgeAuthBatch,
  readStoredSetting,
  retryTransaction,
  updateSettingLocked,
  type PurgeAuthRule,
  type Transaction,
} from '@bantoozi/db';
import {
  HOUSE_PROGRESS_CURSORS,
  RANK_WINDOW_DAYS,
  canonicalJson,
  parseSetting,
  readSetting,
  type HouseProgressCursor,
  type HouseProgressJob,
} from '@bantoozi/shared';

import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';
import { StaleWorkerError } from '../stale-worker.js';

const JOB = 'house.purge-auth' as const;
/** Rows deleted per transaction. */
export const PURGE_AUTH_BATCH = 1_000;
/** Wall time after which a housekeeping run stops starting batches and leaves the rest to its next run. */
export const HOUSE_RUN_BUDGET_MS = 5 * 60_000;

/**
 * Records a housekeeping run in `settings['house.progress']` (spec 02 §2, spec 11 §6). The job's
 * cursor is replaced by `cursor`, or dropped when none is given.
 */
export async function recordHouseProgress(
  deps: Pick<WorkerDeps, 'db'>,
  job: HouseProgressJob,
  now: Date,
  complete: boolean,
  cursor?: HouseProgressCursor<SweepJob | 'house.purge-users' | 'house.translate-cards'>,
): Promise<void> {
  await retryTransaction(deps.db, (tx) =>
    updateSettingLocked(tx, 'house.progress', {}, (current) => {
      const progress = parseSetting('house.progress', current ?? {});
      const completedAt = complete ? now.toISOString() : progress[job]?.completedAt;
      return parseSetting('house.progress', {
        ...progress,
        [job]: {
          ...(cursor === undefined ? {} : { cursor }),
          updatedAt: now.toISOString(),
          ...(completedAt === undefined ? {} : { completedAt }),
          version: 1,
        },
      });
    }),
  );
}

/** The housekeeping jobs that resume their keyset sweeps from `house.progress` after a budget cut. */
export type SweepJob =
  'house.purge-articles' | 'house.purge-bodies' | 'house.retire-cards' | 'house.reconcile';

/**
 * The saved keyset positions of `job`'s unfinished sweeps, by sweep name; a missing or malformed
 * cursor holds none, so every sweep starts from the beginning.
 */
export async function readSweepCursors(
  deps: WorkerDeps,
  job: SweepJob,
): Promise<Record<string, string>> {
  const progress = readSetting(
    'house.progress',
    await readStoredSetting(deps.db, 'house.progress'),
    deps.settingsEnv,
  );
  const parsed = HOUSE_PROGRESS_CURSORS[job].safeParse(progress?.[job]?.cursor);
  return parsed.success ? { ...parsed.data.sweeps } : {};
}

/** The `cursor` to record for the sweep positions left, or none when every sweep finished. */
export const sweepCursorOf = (
  sweeps: Record<string, string>,
): { sweeps: Record<string, string> } | undefined =>
  Object.keys(sweeps).length === 0 ? undefined : { sweeps };

/** The rebuild jobs whose unavailable-engine runs wait in `settings['house.progress']`. */
export type RebuildJob = 'house.reenrich' | 'house.rematch';
export type RebuildRun = HouseProgressCursor<RebuildJob>['pending'][number];

/** Park the final attempt's frozen scope when a stale fence fails during a rebuild pass. */
export function recoverStaleRebuild<Q extends RebuildJob>(
  deps: WorkerDeps,
  job: Q,
  handle: QueueHandler<Q>,
): QueueHandler<Q> {
  return async (payload, context) => {
    const started = nowOf(deps);
    const frozen = {
      ...payload,
      since:
        payload.since ??
        new Date(started.getTime() - RANK_WINDOW_DAYS * 24 * 60 * 60_000).toISOString(),
    };
    try {
      await handle(frozen, context);
    } catch (error) {
      if (
        error instanceof StaleWorkerError &&
        (context.retry === undefined || context.retry.count >= context.retry.limit)
      ) {
        await recordRebuildProgress(deps, job, started, { complete: false, pending: frozen });
      }
      throw error;
    }
  };
}

/** At most this many pending runs per job are kept (HOUSE_PROGRESS_CURSORS caps the list). */
const MAX_PENDING_RUNS = 20;

/** The runs of `job` recorded as pending; a malformed cursor holds none. */
function pendingOf(job: RebuildJob, cursor: unknown): RebuildRun[] {
  const parsed = HOUSE_PROGRESS_CURSORS[job].safeParse(cursor);
  return parsed.success ? parsed.data.pending : [];
}

/**
 * Records a pass of a rebuild job (`house.reenrich`, `house.rematch`) in `house.progress`:
 * `updatedAt` always, `completedAt` when the pass finished, and, when the primary engine was
 * unavailable, the run itself (its payload with the frozen `since` and cursor) as pending, for
 * `house.reconcile` to enqueue again (spec 11 §6). Other pending runs are kept; when they would exceed the cap they collapse into one unscoped run.
 */
export async function recordRebuildProgress(
  deps: WorkerDeps,
  job: RebuildJob,
  now: Date,
  outcome: { complete: boolean; pending?: RebuildRun },
): Promise<void> {
  await retryTransaction(deps.db, (tx) =>
    updateSettingLocked(tx, 'house.progress', {}, (current) => {
      const progress = parseSetting('house.progress', current ?? {});
      const previous = progress[job];
      const pending = pendingOf(job, previous?.cursor);
      if (outcome.pending !== undefined) {
        const key = canonicalJson(outcome.pending);
        if (!pending.some((run) => canonicalJson(run) === key)) pending.push(outcome.pending);
        // The stored list is bounded. Past the cap the runs are coalesced into one unscoped run
        // (`{}`), which covers every scoped run; none is dropped.
        if (pending.length > MAX_PENDING_RUNS) pending.splice(0, pending.length, {});
      }
      const completedAt = outcome.complete ? now.toISOString() : previous?.completedAt;
      return parseSetting('house.progress', {
        ...progress,
        [job]: {
          ...(pending.length === 0 ? {} : { cursor: { pending } }),
          updatedAt: now.toISOString(),
          ...(completedAt === undefined ? {} : { completedAt }),
          version: 1,
        },
      });
    }),
  );
}

/** Removes and returns the pending runs of `job`, in the caller's transaction. */
export async function takePendingRuns(
  tx: Transaction,
  job: RebuildJob,
  now: Date,
): Promise<RebuildRun[]> {
  let taken: RebuildRun[] = [];
  await updateSettingLocked(tx, 'house.progress', {}, (current) => {
    const progress = parseSetting('house.progress', current ?? {});
    const previous = progress[job];
    taken = pendingOf(job, previous?.cursor);
    if (previous === undefined || taken.length === 0) return progress;
    return parseSetting('house.progress', {
      ...progress,
      [job]: {
        updatedAt: now.toISOString(),
        ...(previous.completedAt === undefined ? {} : { completedAt: previous.completedAt }),
        version: 1,
      },
    });
  });
  return taken;
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
