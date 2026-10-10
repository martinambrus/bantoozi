import {
  purgeArticlesPage,
  purgeEmptyClustersPage,
  purgeIdleFeedsPage,
  retryTransaction,
  type Transaction,
} from '@bantoozi/db';

import { nowOf, type WorkerDeps } from './deps.js';
import { HOUSE_RUN_BUDGET_MS, recordHouseProgress } from './house-purge-auth.js';
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
 * idle for 30 days. Short committed batches with a keyset cursor; an unfinished pass resumes at
 * the next run because every rule is idempotent.
 */
export function createPurgeArticlesHandler(deps: WorkerDeps): QueueHandler<'house.purge-articles'> {
  return async () => {
    const now = nowOf(deps);
    const started = Date.now();
    const counts = { articles: 0, clusters: 0, feeds: 0 };
    let complete = true;
    const sweep = async (page: PageFn, limit: number, key: keyof typeof counts): Promise<void> => {
      let after: string | null = null;
      for (;;) {
        if (Date.now() - started > HOUSE_RUN_BUDGET_MS) {
          complete = false;
          return;
        }
        const cursor: string | null = after;
        const result: Page = await retryTransaction(deps.db, (tx) =>
          page(tx, { now, after: cursor, limit }),
        );
        counts[key] += result.deleted;
        if (result.examined < limit || result.lastId === null) return;
        after = result.lastId;
      }
    };
    await sweep(purgeArticlesPage, PURGE_ARTICLES_BATCH, 'articles');
    if (complete) await sweep(purgeEmptyClustersPage, SWEEP_BATCH, 'clusters');
    if (complete) await sweep(purgeIdleFeedsPage, SWEEP_BATCH, 'feeds');
    await recordHouseProgress(deps, JOB, now, complete);
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
