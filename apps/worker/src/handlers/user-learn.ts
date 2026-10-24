import {
  appendLearningHistory,
  deactivateUserModels,
  insertUserModel,
  lockLearnUser,
  pruneUserModels,
  recordRankIntents,
  registerRatingFingerprint,
  retryTransaction,
  workerOutbox,
  type StoredModelRow,
} from '@bantoozi/db';
import {
  FEATURE_SPEC_V1_SHA,
  decideActivation,
  type TrainResult,
  type TrainingSample,
} from '@bantoozi/ranker';
import { enqueueLearn, enqueueSuggest } from '@bantoozi/shared';

import { guardedRegistration } from '../learn/fingerprints.js';
import { currentContextSha, loadLearnInputs, type LearnInputs } from '../learn/inputs.js';
import { inlineTrainer, type Trainer } from '../learn/trainer.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

const JOB = 'user.learn' as const;

/**
 * Why a stored active model may no longer score (spec 06 §8.1, §8.4): its context differs from the
 * one the current state implies for its own inputs, or an article it trained on has lost its sample
 * (undo, un-rate, deletion), its eligible sample (aged past the history window), or its label or
 * signal weight. A re-rate with the same label and weight keeps the evidence.
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
  const present = new Map(inputs.eligible.map((sample) => [sample.articleId, sample]));
  return keys.some((key) => {
    const [articleId, , label, weight] = Array.isArray(key) ? key : [key];
    const sample = present.get(String(articleId));
    return (
      sample === undefined ||
      (label !== undefined && sample.y !== Number(label)) ||
      (weight !== undefined && sample.weight !== Number(weight))
    );
  })
    ? 'lost_evidence'
    : null;
}

function train(trainer: Trainer, userId: string, inputs: LearnInputs): Promise<TrainResult> {
  return trainer(
    {
      samples: inputs.samples as unknown as TrainingSample[],
      now: inputs.now,
      config: inputs.config,
      heldCards: inputs.held,
      ratingSha: inputs.ratingSha,
      familySha: inputs.familySha,
      families: inputs.families,
      consent: inputs.consent,
      seedMaterial: `learn:${userId}:${inputs.eligibleSetSha}`,
      feedbackCutoffEventId: inputs.cutoffEventId,
    },
    'production',
  );
}

function attemptMetrics(
  result: TrainResult,
  trainedOn: LearnInputs,
  status: 'activated' | 'rejected' | 'superseded',
  reason: string | null,
  strictMarker = trainedOn.strict,
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
    familySha: trainedOn.familySha,
    ...(strictMarker ? { strictRatingSha: trainedOn.ratingSha } : {}),
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
 * the latest terminal (not superseded) attempt's. A second transaction under the per-user learn lock re-reads the
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
      return loadLearnInputs(tx, deps, userId, nowOf(deps));
    });
    if (prepared === null) return;
    const inputs = prepared;
    const state = inputs.modelState;
    if (!inputs.registered) {
      await guardedRegistration(
        () => registerRatingFingerprint(deps.db, inputs.fingerprint, nowOf(deps)),
        deps.logger,
        { rethrow: true },
      );
    }
    const unchanged = state.latestTerminal?.metrics['inputSha'] === inputs.inputSha;
    if (unchanged && (state.active === null || modelStaleness(inputs, state.active) === null)) {
      return;
    }
    const result = unchanged ? null : await train(deps.trainer ?? inlineTrainer, userId, inputs);

    const outcome = await retryTransaction(deps.db, async (tx) => {
      if (!(await lockLearnUser(tx, userId, 'update'))) return 'gone';
      const fresh = await loadLearnInputs(tx, deps, userId, nowOf(deps));
      const current = fresh.modelState;
      const sender = workerOutbox(tx);
      const keep = fresh.config.model.keepVersions;
      let activated = false;
      let deactivated = false;
      let guarded = false;
      let version = current.latest?.version ?? 0;

      const duplicate = current.latestTerminal?.metrics['inputSha'] === inputs.inputSha;
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
                currentFamilySha: fresh.familySha,
                currentContextSha: currentContextSha(fresh, model.featureSpecSha, model.ownInputs),
              });
        guarded = result.activation.reasons.includes('upgrade_regression');
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
            inputs.strict || guarded,
          ),
        });
        if (model !== null) {
          const pin = fresh.fingerprint.settings['engine.model_pin'];
          const pinned = (pin as { model?: unknown } | null | undefined)?.model;
          await appendLearningHistory(tx, {
            userId,
            kind: 'model',
            n: result.metrics.nExplicit,
            auc: result.metrics.cvAuc,
            baselineAuc: result.metrics.baselineAuc,
            activated: decision.activate,
            turnedOn: decision.activate && current.active === null,
            engineModel: typeof pinned === 'string' && pinned !== '' ? pinned : null,
          });
        }
        if (guarded) {
          deactivated =
            (await deactivateUserModels(tx, userId, {
              at: nowOf(deps),
              reason: 'upgrade_regression',
            })) || deactivated;
          await enqueueLearn(sender, { userId });
        }
      }
      const stale =
        activated || guarded || current.active === null
          ? null
          : modelStaleness(fresh, current.active);
      if (stale !== null) {
        deactivated = await deactivateUserModels(tx, userId, { at: nowOf(deps), reason: stale });
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
