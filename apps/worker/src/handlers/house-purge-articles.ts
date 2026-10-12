import {
  purgeArticlesPage,
  purgeEmptyClustersPage,
  purgeIdleFeedsPage,
  retryTransaction,
  type Transaction,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import {
  HOUSE_RUN_BUDGET_MS,
  readSweepCursors,
  recordHouseProgress,
  sweepCursorOf,
} from './house-purge-auth.js';
import type { QueueHandler } from './index.js';

const JOB = 'house.purge-articles' as const;
/** Articles examined per transaction. */
export const PURGE_ARTICLES_BATCH = 500;
const SWEEP_BATCH = 500;

type Page = { examined: number; deleted: number; lastId: string | null };
type PageFn = (
  tx: Transaction,
  input: { now: Date; after: string | null; limit: number },
) => Promise<Page>;

/**
 * `house.purge-articles` (daily at 03:30, spec 11 §5, §6): purges unreferenced articles 90 days
 * after their latest carrier arrival, then the story clusters left without members and the feeds
 * idle for 30 days. Short committed batches with a keyset cursor; a sweep cut by the run budget
 * saves its position in `house.progress` and the next run resumes after it (rows the rules keep,
 * such as protected articles, would otherwise be examined again first every day).
 */
export function createPurgeArticlesHandler(deps: WorkerDeps): QueueHandler<'house.purge-articles'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const counts = { articles: 0, clusters: 0, feeds: 0 };
    let complete = true;
    const sweeps = await readSweepCursors(deps, JOB);
    const sweep = async (page: PageFn, limit: number, key: keyof typeof counts): Promise<void> => {
      let after: string | null = sweeps[key] ?? null;
      for (;;) {
        if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
          complete = false;
          if (after !== null) sweeps[key] = after;
          return;
        }
        const cursor: string | null = after;
        const result: Page = await retryTransaction(deps.db, (tx) =>
          page(tx, { now, after: cursor, limit }),
        );
        counts[key] += result.deleted;
        if (result.examined < limit || result.lastId === null) {
          delete sweeps[key];
          return;
        }
        after = result.lastId;
      }
    };
    await sweep(purgeArticlesPage, PURGE_ARTICLES_BATCH, 'articles');
    if (complete) await sweep(purgeEmptyClustersPage, SWEEP_BATCH, 'clusters');
    if (complete) await sweep(purgeIdleFeedsPage, SWEEP_BATCH, 'feeds');
    await recordHouseProgress(deps, JOB, now, complete, sweepCursorOf(sweeps));
    deps.logger.info(
      {
        job: JOB,
        durationMs: Date.now() - started,
        affected: counts.articles + counts.clusters + counts.feeds,
        ...counts,
        remaining: complete ? 0 : null,
      },
      'articles purged',
    );
  };
}
