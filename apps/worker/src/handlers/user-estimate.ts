import {
  appendLearningHistory,
  deleteEstimateModels,
  insertEstimateModel,
  loadEstimateState,
  lockEstimateUser,
  pruneEstimateModels,
  retryTransaction,
  workerOutbox,
} from '@bantoozi/db';
import { ESTIMATE_SPEC } from '@bantoozi/ranker';
import { canonicalJson, enqueueRank } from '@bantoozi/shared';

import { estimateAction, loadEstimateInputs } from '../estimate/inputs.js';
import { inlineEstimateTrainer } from '../estimate/trainer.js';
import { loadRankerSettings } from '../rank/settings.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

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
    const inputs = await loadEstimateInputs(deps.db, userId, config, now);
    const { ratings, options, inputSha } = inputs;
    const finish = (outcome: string) =>
      deps.logger.info({ job: 'user.estimate', userId, outcome }, 'estimate finished');

    const action = estimateAction(inputs);
    if (action === 'unchanged') {
      finish('unchanged');
      return;
    }
    if (action === 'idle') {
      finish('closed');
      return;
    }
    if (action === 'delete') {
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
      const ratedThrough = ratings.reduce<Date | null>(
        (max, r) => (max === null || r.ratedAt > max ? r.ratedAt : max),
        null,
      );
      // A model differs from the one before it by the reader's ratings alone when the spec and the
      // trainer options (seed, epochs, gate) are the same and a newer rating reached it.
      const earlierOptions = current?.metrics['options'];
      const previous =
        current !== null &&
        current.spec === ESTIMATE_SPEC &&
        earlierOptions !== undefined &&
        canonicalJson(earlierOptions) === canonicalJson(options)
          ? new Date(String(current.metrics['ratedThrough'] ?? ''))
          : null;
      const fromRatings =
        ratedThrough !== null &&
        previous !== null &&
        !Number.isNaN(previous.getTime()) &&
        ratedThrough > previous;
      await insertEstimateModel(tx, {
        userId,
        spec: model.spec,
        n: model.metrics.n,
        nPos: model.metrics.nPos,
        nNeg: model.metrics.nNeg,
        intercept: model.intercept,
        weights: model.weights,
        platt: model.platt,
        metrics: {
          ...model.metrics,
          inputSha,
          options,
          ratedThrough: ratedThrough?.toISOString() ?? null,
          fromRatings,
        },
      });
      await pruneEstimateModels(tx, userId, KEEP_VERSIONS);
      await appendLearningHistory(tx, {
        userId,
        kind: 'estimate',
        n: model.metrics.n,
        auc: model.metrics.auc,
        turnedOn: current === null || current.spec !== ESTIMATE_SPEC,
      });
      await enqueueRank(workerOutbox(tx), { userId, reason: 'estimate', estimate: {} });
      return 'trained';
    });
    finish(outcome);
  };
}
