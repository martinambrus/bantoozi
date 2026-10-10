import {
  auc,
  logLoss,
  sampleEligibility,
  scoreModel,
  snapshotCardScore,
  snapshotFeatures,
  trainUserModel,
  type ReadonlyRankerConfig,
  type RawFeatureSnapshot,
  type StoredModel,
  type TrainingSample,
} from '@bantoozi/ranker';

import type { RunData } from '../report/run-data.js';
import { buildRaterSamples, type LearningArticle, type RaterSamples } from './samples.js';

export type CurveMode = 'production' | 'research' | 'insufficient';

/** One rater at one training size, evaluated on the rater's fixed test ratings. */
export interface CurveRow {
  n: number;
  trainIds: string[];
  trainN: number;
  pos: number;
  neg: number;
  skipped: Record<string, number>;
  testIds: string[];
  testN: number;
  testPos: number;
  testNeg: number;
  mode: CurveMode;
  activation: string[];
  cardsAuc: number | null;
  modelAuc: number | null;
  deltaAuc: number | null;
  cardsLogloss: number | null;
  modelLogloss: number | null;
  ownInputs: string[];
}

export interface RaterCurve {
  raterId: string;
  participantKey: string;
  devCount: number;
  testCount: number;
  testIds: string[];
  rows: CurveRow[];
}

export interface LearningCurve {
  sizes: number[];
  raters: RaterCurve[];
}

const CLIP = 1e-6;

function cardsScore(
  features: RawFeatureSnapshot,
  weights: ReadonlyRankerConfig['strengthWeights'],
): number {
  return Math.min(Math.max(snapshotCardScore(features, weights) ?? 0, CLIP), 1 - CLIP);
}

function trainOnce(
  samples: RaterSamples,
  train: TrainingSample[],
  now: Date,
  config: ReadonlyRankerConfig,
  seedMaterial: string,
  mode: 'production' | 'research',
) {
  return trainUserModel(
    {
      samples: train,
      now,
      config,
      heldCards: samples.heldCards,
      ratingSha: null,
      consent: { implicitFeedback: false, implicitNegative: false },
      seedMaterial,
      feedbackCutoffEventId: null,
    },
    { mode },
  );
}

function evaluate(
  test: readonly TrainingSample[],
  model: StoredModel | null,
  config: ReadonlyRankerConfig,
): Pick<CurveRow, 'cardsAuc' | 'modelAuc' | 'deltaAuc' | 'cardsLogloss' | 'modelLogloss'> {
  const y = test.map((s) => s.y);
  const cards = test.map((s) =>
    cardsScore(s.features as RawFeatureSnapshot, config.strengthWeights),
  );
  const cardsAuc = auc(cards, y);
  const cardsLogloss = y.length > 0 ? logLoss(cards, y) : null;
  let probabilities: number[] | null = null;
  if (model !== null) {
    const scored = test.map(
      (s) =>
        scoreModel(
          model,
          snapshotFeatures(s.features as RawFeatureSnapshot, config, model.ownInputs),
        )?.p ?? null,
    );
    probabilities = scored.every((p): p is number => p !== null) ? scored : null;
  }
  const modelAuc = probabilities === null ? null : auc(probabilities, y);
  return {
    cardsAuc,
    modelAuc,
    deltaAuc: modelAuc === null || cardsAuc === null ? null : modelAuc - cardsAuc,
    cardsLogloss,
    modelLogloss: probabilities === null || y.length === 0 ? null : logLoss(probabilities, y),
  };
}

/**
 * Replay each rater's stored ratings (spec 10, spec 06 §8.3): train on the first n development
 * ratings in arrival order and evaluate every n on the same untouched test ratings. Training time
 * is the rater's last rating, never the wall clock. Production mode when the minimums are met,
 * research mode below them, `insufficient` when even research yields no model.
 */
export function computeLearningCurve(input: {
  run: RunData;
  articles: ReadonlyMap<string, LearningArticle>;
  config: ReadonlyRankerConfig;
  sizes: readonly number[];
}): LearningCurve {
  const { run, articles, config } = input;
  const sizes = [...new Set(input.sizes)].sort((a, b) => a - b);
  const raters: RaterCurve[] = [];
  for (const rater of run.config.raters) {
    const samples = buildRaterSamples({ run, raterId: rater.raterId, articles });
    if (samples.now === null) continue;
    const now = samples.now;
    const eligibility = { now, historyDays: config.model.historyDays, ratingSha: null };
    const test = samples.test.filter((s) => sampleEligibility(s, eligibility).ok);
    const testIds = test.map((s) => s.articleId);
    const testPos = test.filter((s) => s.y === 1).length;
    const rows = sizes.map((n): CurveRow => {
      const train = samples.dev.slice(0, n);
      const seed = `learning-curve|${run.datasetVersion}|${rater.raterId}|${n}`;
      const production = trainOnce(samples, train, now, config, seed, 'production');
      let used = production;
      let mode: CurveMode = 'production';
      if (production.model === null) {
        used = trainOnce(samples, train, now, config, seed, 'research');
        mode = used.model === null ? 'insufficient' : 'research';
      }
      return {
        n,
        trainIds: train.map((s) => s.articleId),
        trainN: train.length,
        pos: train.filter((s) => s.y === 1).length,
        neg: train.filter((s) => s.y === 0).length,
        skipped: used.metrics.skipped,
        testIds,
        testN: test.length,
        testPos,
        testNeg: test.length - testPos,
        mode,
        activation: production.activation.reasons,
        ...evaluate(test, used.model, config),
        ownInputs: used.model?.ownInputs ?? [],
      };
    });
    raters.push({
      raterId: rater.raterId,
      participantKey: samples.participantKey,
      devCount: samples.dev.length,
      testCount: samples.test.length,
      testIds,
      rows,
    });
  }
  return { sizes, raters };
}

export interface ThresholdRule {
  n: number;
  raters: number;
  notBeating: number;
  proposalNeeded: boolean;
}

/**
 * The PLAN M7-T7 rule: a threshold change is proposed when the model does not beat cards-only
 * (model AUC above cards AUC) at `n` for more than half of the raters. `null` when `n` was not run.
 */
export function thresholdRule(curve: LearningCurve, n = 50): ThresholdRule | null {
  if (!curve.sizes.includes(n)) return null;
  const rows = curve.raters.map((rater) => rater.rows.find((row) => row.n === n));
  const notBeating = rows.filter((row) => row?.deltaAuc == null || row.deltaAuc <= 0).length;
  return { n, raters: rows.length, notBeating, proposalNeeded: notBeating * 2 > rows.length };
}
