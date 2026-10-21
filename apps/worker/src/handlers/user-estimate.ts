import {
  deleteEstimateModels,
  insertEstimateModel,
  loadEstimateRatings,
  loadEstimateState,
  lockEstimateUser,
  pruneEstimateModels,
  retryTransaction,
  workerOutbox,
} from '@bantoozi/db';
import {
  DEFAULT_ESTIMATE_OPTIONS,
  ESTIMATE_SPEC,
  estimateGate,
  estimateInputSha,
} from '@bantoozi/ranker';
import { enqueueRank } from '@bantoozi/shared';

import { inlineEstimateTrainer } from '../estimate/trainer.js';
import { loadRankerSettings } from '../rank/settings.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const DAY_MS = 86_400_000;
const KEEP_VERSIONS = 2;

/**
 * `user.estimate {userId}` (visible-learning §4.4, spec 06 §8.6): trains the reader's word model from
 * the explicit ratings of the last `model.historyDays` days, stores it (the newest 2 versions are
 * kept) and records the estimate refresh rank. A repeated run with unchanged inputs is a no-op; below
 * the gate no model is stored and a stored one is deleted.
 */
export function createUserEstimateHandler(deps: WorkerDeps): QueueHandler<'user.estimate'> {
  return async ({ userId }) => {
    const now = nowOf(deps);
    const { config } = await loadRankerSettings(deps.db);
    const options = {
      ...DEFAULT_ESTIMATE_OPTIONS,
      minRatings: config.estimate.minRatings,
      minEachClass: config.estimate.minEachClass,
    };
    const since = new Date(now.getTime() - config.model.historyDays * DAY_MS);
    const ratings = await loadEstimateRatings(deps.db, userId, since);
    const inputSha = estimateInputSha(ratings, options);
    const state = await loadEstimateState(deps.db, userId);
    const finish = (outcome: string) =>
      deps.logger.info({ job: 'user.estimate', userId, outcome }, 'estimate finished');

    if (state !== null && state.spec === ESTIMATE_SPEC && state.metrics['inputSha'] === inputSha) {
      finish('unchanged');
      return;
    }

    const nPos = ratings.filter((r) => r.rating === 1).length;
    const counts = { n: ratings.length, nPos, nNeg: ratings.length - nPos };
    if (!estimateGate(counts, options).open) {
      if (state === null) {
        finish('closed');
        return;
      }
      const outcome = await retryTransaction(deps.db, async (tx) => {
        if (!(await lockEstimateUser(tx, userId))) return 'gone';
        if ((await deleteEstimateModels(tx, userId)) === 0) return 'closed';
        await enqueueRank(workerOutbox(tx), { userId, reason: 'estimate', estimate: {} });
        return 'deleted';
      });
      finish(outcome);
      return;
    }

    const result = await (deps.estimateTrainer ?? inlineEstimateTrainer)(ratings, options);
    if (!result.ok) {
      finish('closed');
      return;
    }
    const { model } = result;

    const outcome = await retryTransaction(deps.db, async (tx) => {
      if (!(await lockEstimateUser(tx, userId))) return 'gone';
      const current = await loadEstimateState(tx, userId);
      if (
        current !== null &&
        current.spec === ESTIMATE_SPEC &&
        current.metrics['inputSha'] === inputSha
      ) {
        return 'duplicate';
      }
      await insertEstimateModel(tx, {
        userId,
        spec: model.spec,
        n: model.metrics.n,
        nPos: model.metrics.nPos,
        nNeg: model.metrics.nNeg,
        intercept: model.intercept,
        weights: model.weights,
        platt: model.platt,
        metrics: { ...model.metrics, inputSha, options },
      });
      await pruneEstimateModels(tx, userId, KEEP_VERSIONS);
      await enqueueRank(workerOutbox(tx), { userId, reason: 'estimate', estimate: {} });
      return 'trained';
    });
    finish(outcome);
  };
}
