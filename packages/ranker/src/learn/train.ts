import type { ReadonlyRankerConfig } from '../config.js';
import { minimumReasons, qualityReasons } from './activation.js';
import { FEATURE_SPEC_V1_SHA } from './feature-spec.js';
import { type RawFeatureSnapshot, snapshotCardScore, snapshotFeatures } from './features.js';
import { planFolds, type FoldPlan } from './folds.js';
import { fitLogistic, type LogisticFit } from './logistic.js';
import { auc, groupedBootstrapCi, logLoss } from './metrics.js';
import { modelContextSha, type Consent, type HeldCard, type StoredModel } from './model.js';
import { ownInputs } from './own-inputs.js';
import { applyPlatt, fitPlatt, type PlattParams } from './platt.js';
import { compareSamples, eligibleSetSha, sampleEligibility, type TrainingSample } from './samples.js';

export interface TrainArgs {
  samples: TrainingSample[];
  now: Date;
  config: ReadonlyRankerConfig;
  heldCards: HeldCard[];
  ratingSha: string | null;
  consent: Consent;
  seedMaterial: string;
  feedbackCutoffEventId: string | null;
}

export type ConfidenceInterval = [number, number] | null;

export interface TrainMetrics {
  skipped: Record<string, number>;
  nExplicit: number;
  nPos: number;
  nNeg: number;
  k: number | null;
  lambda: number | null;
  ownInputs: string[];
  cvAuc: number | null;
  cvLogloss: number | null;
  baselineAuc: number | null;
  baselineLogloss: number | null;
  ci: { cvAuc: ConfidenceInterval; baselineAuc: ConfidenceInterval; deltaAuc: ConfidenceInterval };
  research: boolean;
  contextSha: string | null;
  ratingSha: string | null;
  featureSpecSha: string;
  eligibleSetSha: string;
  feedbackCutoffEventId: string | null;
}

export interface TrainResult {
  model: StoredModel | null;
  metrics: TrainMetrics;
  activation: { eligible: boolean; reasons: string[] };
}

const IDENTITY: PlattParams = { a: 1, b: 0 };
const VAR_EPS = 1e-12;
const CLIP = 1e-6;

/**
 * The λ with the lowest calibrated out-of-fold loss, ties (|Δ| ≤ 1e-12·max(1, |loss|)) to the
 * larger λ (spec 06 §8.3).
 */
export function chooseLambda(lossByLambda: readonly { lambda: number; loss: number }[]): number {
  const finite = lossByLambda.filter((e) => Number.isFinite(e.loss));
  if (finite.length === 0) return Math.max(...lossByLambda.map((e) => e.lambda));
  const min = Math.min(...finite.map((e) => e.loss));
  const tol = 1e-12 * Math.max(1, Math.abs(min));
  return Math.max(...finite.filter((e) => e.loss <= min + tol).map((e) => e.lambda));
}

interface Row {
  s: TrainingSample;
  f: RawFeatureSnapshot;
  vecs: Map<string, Record<string, number>>;
}

interface Design {
  names: string[];
  dropped: string[];
  own: string[];
  mean: number[];
  scale: number[];
  X: number[][];
  y: number[];
  w: number[];
  std: (rows: readonly Row[]) => number[][];
}

interface Ctx {
  cfg: ReadonlyRankerConfig;
  held: readonly HeldCard[];
  grid: readonly number[];
}

function vectorOf(row: Row, own: readonly string[], cfg: ReadonlyRankerConfig): Record<string, number> {
  const key = own.join(',');
  let v = row.vecs.get(key);
  if (v === undefined) {
    v = snapshotFeatures(row.f, cfg, own);
    row.vecs.set(key, v);
  }
  return v;
}

/** Own inputs, columns, zero-variance dropping and standardization from one partition only (spec 06 §8.3). */
function buildDesign(rows: readonly Row[], ctx: Ctx): Design {
  const own = ownInputs(
    rows.map((r) => r.s),
    ctx.held,
    ctx.cfg,
  );
  const first = rows[0];
  const all = first === undefined ? [] : Object.keys(vectorOf(first, own, ctx.cfg));
  const n = rows.length;
  const sum = new Float64Array(all.length);
  const sq = new Float64Array(all.length);
  for (const row of rows) {
    const v = vectorOf(row, own, ctx.cfg);
    for (let j = 0; j < all.length; j += 1) {
      const x = v[all[j] ?? ''] ?? 0;
      sum[j] = (sum[j] ?? 0) + x;
      sq[j] = (sq[j] ?? 0) + x * x;
    }
  }
  const names: string[] = [];
  const dropped: string[] = [];
  const mean: number[] = [];
  const scale: number[] = [];
  for (let j = 0; j < all.length; j += 1) {
    const m = (sum[j] ?? 0) / n;
    const sd = Math.sqrt(Math.max((sq[j] ?? 0) / n - m * m, 0));
    const name = all[j] ?? '';
    if (sd < VAR_EPS) dropped.push(name);
    else {
      names.push(name);
      mean.push(m);
      scale.push(sd);
    }
  }
  const std = (list: readonly Row[]): number[][] =>
    list.map((row) => {
      const v = vectorOf(row, own, ctx.cfg);
      return names.map((name, j) => ((v[name] ?? 0) - (mean[j] ?? 0)) / (scale[j] ?? 1));
    });
  return {
    names,
    dropped,
    own,
    mean,
    scale,
    X: std(rows),
    y: rows.map((r) => r.s.y),
    w: rows.map((r) => r.s.weight),
    std,
  };
}

function fitGrid(d: Design, grid: readonly number[]): LogisticFit[] {
  let init: { weights: number[]; intercept: number } | undefined;
  return grid.map((lambda) => {
    const fit = fitLogistic(d.X, d.y, d.w, lambda, init === undefined ? undefined : { init });
    if (fit.ok) init = { weights: fit.weights, intercept: fit.intercept };
    return fit;
  });
}

function logitsOf(fit: Extract<LogisticFit, { ok: true }>, X: readonly (readonly number[])[]): number[] {
  return X.map((row) => {
    let z = fit.intercept;
    for (let j = 0; j < fit.weights.length; j += 1) z += (fit.weights[j] ?? 0) * (row[j] ?? 0);
    return z;
  });
}

interface FoldFit {
  design: Design;
  trainRows: Row[];
  fits: LogisticFit[];
  valX: number[][];
  valY: number[];
  valRows: Row[];
}

function cvFolds(rows: readonly Row[], plan: FoldPlan, ctx: Ctx): FoldFit[] {
  const out: FoldFit[] = [];
  for (let f = 0; f < plan.k; f += 1) {
    const trainRows = rows.filter((_, i) => plan.folds[i] !== f);
    const valRows = rows.filter((r, i) => plan.folds[i] === f && r.s.explicit);
    const design = buildDesign(trainRows, ctx);
    out.push({
      design,
      trainRows,
      fits: fitGrid(design, ctx.grid),
      valX: design.std(valRows),
      valY: valRows.map((r) => r.s.y),
      valRows,
    });
  }
  return out;
}

function oof(folds: readonly FoldFit[], li: number): { z: number[]; y: number[] } | null {
  const z: number[] = [];
  const y: number[] = [];
  for (const fold of folds) {
    const fit = fold.fits[li];
    if (fit === undefined || !fit.ok) return null;
    z.push(...logitsOf(fit, fold.valX));
    y.push(...fold.valY);
  }
  return { z, y };
}

function lambdaLosses(folds: readonly FoldFit[], ctx: Ctx): { lambda: number; loss: number }[] {
  return ctx.grid.map((lambda, li) => {
    const o = oof(folds, li);
    if (o === null) return { lambda, loss: Number.POSITIVE_INFINITY };
    const platt = fitPlatt(o.z, o.y);
    return { lambda, loss: logLoss(o.z.map((z) => applyPlatt(platt, z)), o.y) };
  });
}

/** λ and Platt chosen on a partition's own inner folds; the largest λ and identity when none can be formed. */
function innerSelect(rows: readonly Row[], seed: string, ctx: Ctx): { lambda: number; platt: PlattParams } {
  const largest = Math.max(...ctx.grid);
  const plan = planFolds(
    rows.map((r) => r.s),
    seed,
  );
  if (plan === null) return { lambda: largest, platt: IDENTITY };
  const folds = cvFolds(rows, plan, ctx);
  const losses = lambdaLosses(folds, ctx);
  if (!losses.some((e) => Number.isFinite(e.loss))) return { lambda: largest, platt: IDENTITY };
  const lambda = chooseLambda(losses);
  const o = oof(folds, ctx.grid.indexOf(lambda));
  return { lambda, platt: o === null ? IDENTITY : fitPlatt(o.z, o.y) };
}

function baselineScore(row: Row, cfg: ReadonlyRankerConfig): number {
  return Math.min(Math.max(snapshotCardScore(row.f, cfg.strengthWeights) ?? 0, CLIP), 1 - CLIP);
}

function baselineOf(
  rows: readonly Row[],
  cfg: ReadonlyRankerConfig,
): { scores: number[]; y: number[]; groups: string[] } {
  const explicit = rows.filter((r) => r.s.explicit);
  return {
    groups: explicit.map((r) => r.s.groupId),
    scores: explicit.map((r) => baselineScore(r, cfg)),
    y: explicit.map((r) => r.s.y),
  };
}

/**
 * The pure personal-model trainer (spec 06 §8.1-8.3): eligibility, grouped CV with per-partition
 * own inputs and scaling, λ and Platt by nested folds, the cards-only baseline and the activation
 * reasons. `research` mode skips the minimums, flags the metrics and is never eligible.
 */
export function trainUserModel(args: TrainArgs, opts: { mode: 'production' | 'research' }): TrainResult {
  const cfg = args.config;
  const mc = cfg.model;
  const research = opts.mode === 'research';
  const elig = { now: args.now, historyDays: mc.historyDays, ratingSha: args.ratingSha };
  const skipped: Record<string, number> = {};
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const ordered = [...args.samples].sort(compareSamples);
  const latest = new Map<string, Row>();
  for (const s of ordered) {
    const e = sampleEligibility(s, elig);
    if (!e.ok) {
      bump(e.reason);
      continue;
    }
    const prev = latest.get(s.articleId);
    if (prev !== undefined) {
      bump('duplicate');
      if (prev.s.feedbackAt.getTime() > s.feedbackAt.getTime()) continue;
    }
    latest.set(s.articleId, { s, f: s.features as RawFeatureSnapshot, vecs: new Map() });
  }
  const rows = [...latest.values()];
  const explicitRows = rows.filter((r) => r.s.explicit);
  const nPos = explicitRows.filter((r) => r.s.y === 1).length;
  const metrics: TrainMetrics = {
    skipped: Object.fromEntries(Object.entries(skipped).sort(([a], [b]) => (a < b ? -1 : 1))),
    nExplicit: explicitRows.length,
    nPos,
    nNeg: explicitRows.length - nPos,
    k: null,
    lambda: null,
    ownInputs: [],
    cvAuc: null,
    cvLogloss: null,
    baselineAuc: null,
    baselineLogloss: null,
    ci: { cvAuc: null, baselineAuc: null, deltaAuc: null },
    research,
    contextSha: null,
    ratingSha: args.ratingSha,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    eligibleSetSha: eligibleSetSha(args.samples, elig),
    feedbackCutoffEventId: args.feedbackCutoffEventId,
  };
  const reject = (reasons: string[]): TrainResult => ({
    model: null,
    metrics,
    activation: { eligible: false, reasons },
  });

  const minimums = minimumReasons(metrics, mc);
  if (rows.length === 0 || (!research && minimums.length > 0)) {
    return reject(minimums.length > 0 ? minimums : ['insufficient_explicit']);
  }

  const ctx: Ctx = { cfg, held: args.heldCards, grid: mc.lambdaGrid };
  const largest = Math.max(...ctx.grid);
  const seed = args.seedMaterial;
  const plan = planFolds(
    rows.map((r) => r.s),
    `${seed}|outer`,
  );
  if (plan === null && !research) return reject(['insufficient_validation']);

  const base = baselineOf(rows, cfg);
  metrics.baselineAuc = auc(base.scores, base.y);
  metrics.baselineLogloss = base.y.length > 0 ? logLoss(base.scores, base.y) : null;
  metrics.ci.baselineAuc = groupedBootstrapCi(
    base.groups,
    (m) => auc(base.scores, base.y, m),
    `${seed}|baseline`,
  );

  let lambda = largest;
  let platt = IDENTITY;
  if (plan !== null) {
    metrics.k = plan.k;
    const folds = cvFolds(rows, plan, ctx);
    const losses = lambdaLosses(folds, ctx);
    if (losses.some((e) => Number.isFinite(e.loss))) {
      lambda = chooseLambda(losses);
      const o = oof(folds, ctx.grid.indexOf(lambda));
      if (o !== null) platt = fitPlatt(o.z, o.y);
    }

    const probs: number[] = [];
    const ys: number[] = [];
    const groups: string[] = [];
    const baseScores: number[] = [];
    for (const [f, fold] of folds.entries()) {
      const chosen = innerSelect(fold.trainRows, `${seed}|inner|${f}`, ctx);
      const fit = fold.fits[ctx.grid.indexOf(chosen.lambda)];
      if (fit === undefined || !fit.ok) return reject([fit?.ok === false ? fit.reason : 'nonconverged']);
      for (const z of logitsOf(fit, fold.valX)) probs.push(applyPlatt(chosen.platt, z));
      ys.push(...fold.valY);
      for (const row of fold.valRows) {
        groups.push(row.s.groupId);
        baseScores.push(baselineScore(row, cfg));
      }
    }
    metrics.ci.cvAuc = groupedBootstrapCi(groups, (m) => auc(probs, ys, m), `${seed}|cv`);
    metrics.ci.deltaAuc = groupedBootstrapCi(
      groups,
      (m) => {
        const model = auc(probs, ys, m);
        const baseline = auc(baseScores, ys, m);
        return model === null || baseline === null ? null : model - baseline;
      },
      `${seed}|delta`,
    );
    metrics.cvAuc = auc(probs, ys);
    metrics.cvLogloss = ys.length > 0 ? logLoss(probs, ys) : null;
  }
  metrics.lambda = lambda;

  const design = buildDesign(rows, ctx);
  const final = fitLogistic(design.X, design.y, design.w, lambda);
  if (!final.ok) return reject([final.reason]);
  metrics.ownInputs = design.own;
  const heldById = new Map(args.heldCards.map((h) => [h.cardId, h]));
  if (args.ratingSha !== null) {
    metrics.contextSha = modelContextSha({
      ratingSha: args.ratingSha,
      featureSpecSha: FEATURE_SPEC_V1_SHA,
      strengthWeights: cfg.strengthWeights,
      modelConfig: mc,
      consent: args.consent,
      ownInputs: design.own.flatMap((id) => {
        const h = heldById.get(id);
        return h === undefined ? [] : [h];
      }),
    });
  }
  const model: StoredModel = {
    features: design.names,
    weights: final.weights,
    scaler: { mean: design.mean, scale: design.scale },
    intercept: final.intercept,
    platt,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    lambda,
    ownInputs: design.own,
    contextSha: metrics.contextSha,
    ratingSha: args.ratingSha,
    feedbackCutoffEventId: args.feedbackCutoffEventId,
    dropped: design.dropped,
  };
  if (research) return { model, metrics, activation: { eligible: false, reasons: ['research'] } };
  const reasons = qualityReasons(metrics, mc);
  return { model, metrics, activation: { eligible: reasons.length === 0, reasons } };
}

