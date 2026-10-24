import { listEstimateSweepUsers, retryTransaction, workerOutbox } from '@bantoozi/db';
import type { RankerSettings } from '@bantoozi/ranker';
import { enqueueEstimateMany } from '@bantoozi/shared';

import type { WorkerDeps } from '../handlers/deps.js';
import { estimateAction, loadEstimateInputs } from './inputs.js';

const DAY_MS = 86_400_000;
const JOB = 'house.nightly-learn';

/**
 * The nightly estimate sweep: records `user.estimate {userId}` for every reader whose stored word model
 * (or missing one) is stale without any trigger, that is, whose `user.estimate` would delete or train
 * (`estimateAction`). `user.estimate` stays the authority; this only decides who to wake. One reader
 * whose check throws is logged and skipped, never failing the page.
 */
export async function enqueueStaleEstimates(
  deps: WorkerDeps,
  options: {
    now: Date;
    config: RankerSettings['config'];
    pageSize?: number;
    loadInputs?: typeof loadEstimateInputs;
  },
): Promise<{ examined: number; enqueued: number; failed: number; ms: number }> {
  const started = performance.now();
  const { now, config, pageSize = 200, loadInputs = loadEstimateInputs } = options;
  const since = new Date(now.getTime() - config.model.historyDays * DAY_MS);
  let after: string | null = null;
  let examined = 0;
  let enqueued = 0;
  let failed = 0;
  for (;;) {
    const page = await listEstimateSweepUsers(deps.db, {
      after,
      limit: pageSize,
      since,
      minRatings: config.estimate.minRatings,
    });
    const due: string[] = [];
    for (const userId of page) {
      try {
        const action = estimateAction(await loadInputs(deps.db, userId, config, now));
        if (action === 'delete' || action === 'train') due.push(userId);
      } catch (err) {
        deps.logger.warn({ job: JOB, userId, err }, 'estimate check failed');
        failed += 1;
      }
    }
    if (due.length > 0) {
      await retryTransaction(deps.db, async (tx) => {
        const sender = workerOutbox(tx);
        await enqueueEstimateMany(sender, due);
      });
    }
    examined += page.length;
    enqueued += due.length;
    if (page.length < pageSize) break;
    after = page[page.length - 1] ?? null;
  }
  return { examined, enqueued, failed, ms: Math.round(performance.now() - started) };
}
