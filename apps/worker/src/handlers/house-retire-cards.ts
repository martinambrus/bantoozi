import {
  deleteRetiredCardsPage,
  retireUnheldCardsPage,
  retryTransaction,
  unretireHeldCardsPage,
  type CardsPage,
} from '@bantoozi/db';
import type { Transaction } from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.retire-cards' as const;
/** Cards handled per transaction. */
export const RETIRE_CARDS_BATCH = 100;

/**
 * `house.retire-cards` (daily at 04:30, spec 05 §5.1, spec 11 §5): clears the retirement of cards
 * held again, retires unheld non-public cards, and deletes the answers and then the card 30 days
 * after retirement unless a library version, publication request or eval row references it.
 */
export function createRetireCardsHandler(deps: WorkerDeps): QueueHandler<'house.retire-cards'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const counts = { unretired: 0, retired: 0, deleted: 0, kept: 0, answers: 0 };
    let complete = true;

    const sweep = async <P extends CardsPage>(
      page: (tx: Transaction, after: string | null) => Promise<P>,
      each: (result: P) => void,
    ): Promise<void> => {
      let after: string | null = null;
      for (;;) {
        if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
          complete = false;
          return;
        }
        const cursor: string | null = after;
        const result: P = await retryTransaction(deps.db, (tx) => page(tx, cursor));
        each(result);
        if (result.examined < RETIRE_CARDS_BATCH || result.lastId === null) return;
        after = result.lastId;
      }
    };
    const limit = RETIRE_CARDS_BATCH;
    await sweep(
      (tx, after) => unretireHeldCardsPage(tx, { after, limit }),
      (r) => {
        counts.unretired += r.changed;
      },
    );
    if (complete) {
      await sweep(
        (tx, after) => retireUnheldCardsPage(tx, { now, after, limit }),
        (r) => {
          counts.retired += r.changed;
        },
      );
    }
    if (complete) {
      await sweep(
        (tx, after) => deleteRetiredCardsPage(tx, { now, after, limit }),
        (r) => {
          counts.deleted += r.changed;
          counts.kept += r.kept;
          counts.answers += r.answers;
        },
      );
    }

    await recordHouseProgress(deps, JOB, now, complete);
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: counts.unretired + counts.retired + counts.deleted,
        ...counts,
        remaining: complete ? 0 : null,
      },
      'cards retired',
    );
  };
}
