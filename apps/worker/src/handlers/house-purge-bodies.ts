import {
  clearHotBodiesPage,
  collectSnapshotsPage,
  deleteExpiredPins,
  markSnapshotsColdPage,
  markUnreferencedSnapshotsPage,
  retryTransaction,
  type BodiesPage,
  type ColdPage,
  type Transaction,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.purge-bodies' as const;
/** Rows handled per transaction. */
export const PURGE_BODIES_BATCH = 200;
const PIN_BATCH = 1_000;

type PageFn<P extends BodiesPage> = (
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
) => Promise<P>;

/**
 * `house.purge-bodies` (daily at 03:45, spec 11 §5.2, §6): deletes expired Undo pins, marks the
 * snapshots nothing holds (repairing releases that left no mark), marks snapshots cold at 30 days
 * when their checksum verifies, clears hot bodies 30 days old and collects snapshots 7 days past
 * their last release. A retained bookmark's snapshot is never deleted.
 */
export function createPurgeBodiesHandler(deps: WorkerDeps): QueueHandler<'house.purge-bodies'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const counts = { pins: 0, marked: 0, cold: 0, coldMismatched: 0, bodies: 0, snapshots: 0 };
    const compression: Record<string, number> = {};
    let complete = true;
    const expired = (): boolean => Date.now() - started > HOUSE_RUN_BUDGET_MS;

    while (!expired()) {
      const deleted = await retryTransaction(deps.db, (tx) =>
        deleteExpiredPins(tx, { now, limit: PIN_BATCH }),
      );
      counts.pins += deleted;
      if (deleted < PIN_BATCH) break;
    }
    if (expired()) complete = false;

    const sweep = async <P extends BodiesPage>(
      page: PageFn<P>,
      each: (result: P) => void,
    ): Promise<void> => {
      if (!complete) return;
      let after: string | null = null;
      for (;;) {
        if (expired()) {
          complete = false;
          return;
        }
        const cursor: string | null = after;
        const result: P = await retryTransaction(deps.db, (tx) =>
          page(tx, { now, after: cursor, limit: PURGE_BODIES_BATCH }),
        );
        each(result);
        if (result.examined < PURGE_BODIES_BATCH || result.lastId === null) return;
        after = result.lastId;
      }
    };
    await sweep(markUnreferencedSnapshotsPage, (r) => {
      counts.marked += r.changed;
    });
    await sweep<ColdPage>(markSnapshotsColdPage, (r) => {
      counts.cold += r.changed;
      counts.coldMismatched += r.mismatched;
      for (const [method, n] of Object.entries(r.compression)) {
        compression[method] = (compression[method] ?? 0) + n;
      }
    });
    await sweep(clearHotBodiesPage, (r) => {
      counts.bodies += r.changed;
    });
    await sweep(collectSnapshotsPage, (r) => {
      counts.snapshots += r.changed;
    });

    await recordHouseProgress(deps, JOB, now, complete);
    const log = {
      job: JOB,
      durationMs: Date.now() - started,
      affected: counts.pins + counts.marked + counts.cold + counts.bodies + counts.snapshots,
      ...counts,
      compression,
      remaining: complete ? 0 : null,
    };
    if (counts.coldMismatched > 0) {
      deps.logger.warn(log, 'snapshot checksum mismatch left hot');
    } else {
      deps.logger.info(log, 'bodies purged');
    }
  };
}
