import {
  deactivateUserModels,
  insertUserModel,
  loadModelState,
  lockLearnUser,
  pruneUserModels,
  recordRankIntents,
  retryTransaction,
  workerOutbox,
  type StoredModelRow,
} from '@bantoozi/db';
import {
  FEATURE_SPEC_V1_SHA,
  decideActivation,
  trainUserModel,
  type TrainResult,
  type TrainingSample,
} from '@bantoozi/ranker';
import { enqueueLearn, enqueueSuggest } from '@bantoozi/shared';

import { currentContextSha, loadLearnInputs, type LearnInputs } from '../learn/inputs.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'user.learn' as const;

/**
 * Why a stored active model may no longer score (spec 06 §8.1, §8.4): its context differs from the
 * one the current state implies for its own inputs, or an article it trained on has lost its sample
 * (undo, un-rate, deletion) or its eligible sample (aged past the history window). A re-rate keeps the
 * article's sample and so does not count.
 */
export function modelStaleness(
  inputs: LearnInputs,
  active: StoredModelRow,
): 'incompatible' | 'lost_evidence' | null {
  const own = Array.isArray(active.metrics['ownInputs']) ? active.metrics['ownInputs'] : [];
  const ids = own.map((entry) => String((entry as { cardId?: unknown }).cardId));
  if (currentContextSha(inputs, active.featureSpecSha, ids) !== active.metrics['contextSha']) {
    return 'incompatible';
  }
  const keys = Array.isArray(active.metrics['sampleKeys']) ? active.metrics['sampleKeys'] : [];
  const present = new Set(inputs.eligible.map((s) => s.articleId));
  return keys.some((key) => !present.has(String(Array.isArray(key) ? key[0] : key)))
    ? 'lost_evidence'
    : null;
}

function train(userId: string, inputs: LearnInputs): TrainResult {
  return trainUserModel(
    {
      samples: inputs.samples as unknown as TrainingSample[],
      now: inputs.now,
      config: inputs.config,
      heldCards: inputs.held,
      ratingSha: inputs.ratingSha,
      consent: inputs.consent,
      seedMaterial: `learn:${userId}:${inputs.eligibleSetSha}`,
      feedbackCutoffEventId: inputs.cutoffEventId,
    },
    { mode: 'production' },
  );
}

function attemptMetrics(
  result: TrainResult,
  trainedOn: LearnInputs,
  status: 'activated' | 'rejected' | 'superseded',
  reason: string | null,
) {
  const heldById = new Map(trainedOn.held.map((card) => [card.cardId, card]));
  return {
    ...result.metrics,
    status,
    reason,
    feedbackCutoffEventId: trainedOn.cutoffEventId,
    inputSha: trainedOn.inputSha,
    contextSha: result.metrics.contextSha,
    ratingSha: trainedOn.ratingSha,
    ownInputs: (result.model?.ownInputs ?? []).flatMap((id) => {
      const card = heldById.get(id);
      return card === undefined ? [] : [card];
    }),
    sampleKeys: trainedOn.eligible.map((s) => [s.articleId, s.eventId, s.y, s.weight]),
    attemptAt: trainedOn.now.toISOString(),
  };
}

/**
 * `user.learn {userId}` (spec 06 §8.4, PLAN M7-T4). Captures the user's samples, rating fingerprint,
 * held cards, config and consent under a share lock; trains only when their `inputSha` differs from
 * the latest stored attempt's. A second transaction under the per-user learn lock re-reads the
 * inputs: changed inputs store the attempt as `superseded` and enqueue another run, otherwise the
 * attempt is stored and, when eligible and still compatible, replaces the active model. An active
 * model whose context no longer matches or whose training evidence is gone is deactivated.
 * Activation or deactivation bumps the rank revision with a full `user.rank`; activation also
 * enqueues `user.suggest`. Retention keeps the active row and the newest `model.keepVersions` others.
 */
export function createUserLearnHandler(deps: WorkerDeps): QueueHandler<'user.learn'> {
  return async ({ userId }) => {
    const prepared = await retryTransaction(deps.db, async (tx) => {
      if (!(await lockLearnUser(tx, userId, 'share'))) return null;
      const inputs = await loadLearnInputs(tx, deps, userId, nowOf(deps));
      return { inputs, state: await loadModelState(tx, userId) };
    });
    if (prepared === null) return;
    const { inputs, state } = prepared;
    const unchanged = state.latest?.metrics['inputSha'] === inputs.inputSha;
    if (unchanged && (state.active === null || modelStaleness(inputs, state.active) === null)) {
      return;
    }
    const result = unchanged ? null : train(userId, inputs);

    const outcome = await retryTransaction(deps.db, async (tx) => {
      if (!(await lockLearnUser(tx, userId, 'update'))) return 'gone';
      const fresh = await loadLearnInputs(tx, deps, userId, nowOf(deps));
      const current = await loadModelState(tx, userId);
      const sender = workerOutbox(tx);
      const keep = fresh.config.model.keepVersions;
      let activated = false;
      let deactivated = false;
      let version = current.latest?.version ?? 0;

      const duplicate = current.latest?.metrics['inputSha'] === inputs.inputSha;
      if (result !== null && !duplicate) {
        const model = result.model;
        const base = {
          userId,
          featureSpecSha: FEATURE_SPEC_V1_SHA,
          nLabels: result.metrics.nExplicit,
          nPos: result.metrics.nPos,
          nNeg: result.metrics.nNeg,
          weights: model === null ? {} : { features: model.features, weights: model.weights },
          intercept: model?.intercept ?? 0,
          scaler: model?.scaler ?? {},
          calibration: {
            method: 'platt',
            a: model?.platt.a ?? 1,
            b: model?.platt.b ?? 0,
          },
        };
        if (fresh.inputSha !== inputs.inputSha) {
          await insertUserModel(tx, {
            ...base,
            active: false,
            metrics: attemptMetrics(result, inputs, 'superseded', 'inputs_changed'),
          });
          await enqueueLearn(sender, { userId });
          await pruneUserModels(tx, userId, keep);
          return 'superseded';
        }
        const decision =
          model === null
            ? { activate: false, reasons: result.activation.reasons }
            : decideActivation(result, {
                currentRatingSha: fresh.ratingSha,
                currentContextSha: currentContextSha(fresh, model.featureSpecSha, model.ownInputs),
              });
        if (decision.activate) {
          deactivated = await deactivateUserModels(tx, userId);
          activated = true;
        }
        version = await insertUserModel(tx, {
          ...base,
          active: decision.activate,
          metrics: attemptMetrics(
            result,
            inputs,
            decision.activate ? 'activated' : 'rejected',
            decision.activate ? null : decision.reasons.join(','),
          ),
        });
      }
      if (!activated && current.active !== null && modelStaleness(fresh, current.active) !== null) {
        deactivated = await deactivateUserModels(tx, userId);
      }
      await pruneUserModels(tx, userId, keep);
      if (activated || deactivated) {
        await recordRankIntents(tx, sender, [userId], {
          reason: `model-${activated ? 'on' : 'off'}-v${version}`,
          full: true,
        });
      }
      if (activated) await enqueueSuggest(sender, { userId });
      return activated ? 'activated' : deactivated ? 'deactivated' : 'stored';
    });
    deps.logger.info({ job: JOB, userId, outcome }, 'learn finished');
  };
}
