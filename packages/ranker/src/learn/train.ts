import type { ReadonlyRankerConfig } from '../config.js';
import { minimumReasons, qualityReasons } from './activation.js';
import { FEATURE_SPEC_V1_SHA } from './feature-spec.js';
import { type RawFeatureSnapshot, snapshotCardScore, snapshotFeatures } from './features.js';
import { INNER_MAX_K, planFolds, type FoldPlan } from './folds.js';
import { fitLogistic, type LogisticFit } from './logistic.js';
import { aucScorer, groupedBootstrapCi, logLoss } from './metrics.js';
import { modelContextSha, type Consent, type HeldCard, type StoredModel } from './model.js';
import { ownInputs } from './own-inputs.js';
import { applyPlatt, fitPlatt, type PlattParams } from './platt.js';
import {
  compareSamples,
  eligibleSetSha,
  sampleEligibility,
  type TrainingSample,
} from './samples.js';

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
/**
 * From this many explicit samples on, each outer fold is reported at the outer λ and Platt instead
 * of choosing its own with inner folds (D-261): the nested estimate guards small samples against an
 * optimistic `cv_auc` (+0.023 at 300 on the owner's data), which vanishes as samples accumulate
 * (+0.005 at 2,000, none at 3,452) while the inner folds cost three quarters of a run.
 */
export const NESTED_CV_MAX_EXPLICIT = 1_000;
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

/** One eligible training sample with its stored snapshot. */
export interface TrainingRow {
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
  std: (rows: readonly TrainingRow[]) => number[][];
}

interface Ctx {
  cfg: ReadonlyRankerConfig;
  held: readonly HeldCard[];
  grid: readonly number[];
}

function vectorOf(
  row: TrainingRow,
  own: readonly string[],
  cfg: ReadonlyRankerConfig,
): Record<string, number> {
  const key = own.join(',');
  let v = row.vecs.get(key);
  if (v === undefined) {
    v = snapshotFeatures(row.f, cfg, own);
    row.vecs.set(key, v);
  }
  return v;
}

/** Own inputs, columns, zero-variance dropping and standardization from one partition only (spec 06 §8.3). */
function buildDesign(rows: readonly TrainingRow[], ctx: Ctx): Design {
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
  const std = (list: readonly TrainingRow[]): number[][] =>
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

/**
 * Fits every grid value, in grid order. Each fit starts from the previous converged one, walking
 * from the largest λ down (D-261): the most penalized fit converges fastest from zero and is the
 * closest start for the next (15 % fewer Newton steps on the owner's data than walking up).
 */
function fitGrid(d: Design, grid: readonly number[]): LogisticFit[] {
  let init: { weights: number[]; intercept: number } | undefined;
  const fits = new Map<number, LogisticFit>();
  for (const lambda of [...grid].sort((a, b) => b - a)) {
    const fit = fitLogistic(d.X, d.y, d.w, lambda, init === undefined ? undefined : { init });
    if (fit.ok) init = { weights: fit.weights, intercept: fit.intercept };
    fits.set(lambda, fit);
  }
  return grid.map((lambda) => fits.get(lambda) as LogisticFit);
}

function logitsOf(
  fit: Extract<LogisticFit, { ok: true }>,
  X: readonly (readonly number[])[],
): number[] {
  return X.map((row) => {
    let z = fit.intercept;
    for (let j = 0; j < fit.weights.length; j += 1) z += (fit.weights[j] ?? 0) * (row[j] ?? 0);
    return z;
  });
}

interface FoldFit {
  design: Design;
  trainRows: TrainingRow[];
  fits: LogisticFit[];
  valX: number[][];
  valY: number[];
  valRows: TrainingRow[];
}

function cvFolds(rows: readonly TrainingRow[], plan: FoldPlan, ctx: Ctx): FoldFit[] {
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

function lambdaLosses(
  oofAt: (li: number) => { z: number[]; y: number[] } | null,
  ctx: Ctx,
): { lambda: number; loss: number }[] {
  return ctx.grid.map((lambda, li) => {
    const o = oofAt(li);
    if (o === null) return { lambda, loss: Number.POSITIVE_INFINITY };
    const platt = fitPlatt(o.z, o.y);
    return {
      lambda,
      loss: logLoss(
        o.z.map((z) => applyPlatt(platt, z)),
        o.y,
      ),
    };
  });
}

/** λ and Platt chosen on a partition's own inner folds; the largest λ and identity when none can be formed. */
function innerSelect(
  rows: readonly TrainingRow[],
  seed: string,
  ctx: Ctx,
): { lambda: number; platt: PlattParams } {
  const largest = Math.max(...ctx.grid);
  const plan = planFolds(
    rows.map((r) => r.s),
    seed,
    INNER_MAX_K,
  );
  if (plan === null) return { lambda: largest, platt: IDENTITY };
  const folds = cvFolds(rows, plan, ctx);
  const losses = lambdaLosses((li) => oof(folds, li), ctx);
  if (!losses.some((e) => Number.isFinite(e.loss))) return { lambda: largest, platt: IDENTITY };
  const lambda = chooseLambda(losses);
  const o = oof(folds, ctx.grid.indexOf(lambda));
  return { lambda, platt: o === null ? IDENTITY : fitPlatt(o.z, o.y) };
}

/** The eligible rows, latest sample per article, and the skip counts (spec 06 §8.1). */
export function eligibleRows(
  samples: readonly TrainingSample[],
  elig: { now: Date; historyDays: number; ratingSha: string | null },
): { rows: TrainingRow[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const ordered = [...samples].sort(compareSamples);
  const latest = new Map<string, TrainingRow>();
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
  return { rows: [...latest.values()], skipped };
}

/** The clipped cards-only score of a row. */
export function baselineScore(row: TrainingRow, cfg: ReadonlyRankerConfig): number {
  return Math.min(Math.max(snapshotCardScore(row.f, cfg.strengthWeights) ?? 0, CLIP), 1 - CLIP);
}

function baselineOf(
  rows: readonly TrainingRow[],
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
 * One outer fold of a training run (D-262), as plain data a thread can return: per grid value the
 * fit status and the out-of-fold explicit logits, the validation labels, groups and cards-only
 * scores, and, for a nested run, the partition's own λ and Platt.
 */
export interface FoldResult {
  fits: ({ ok: true } | { ok: false; reason: 'singular' | 'nonfinite' | 'nonconverged' })[];
  valLogits: (number[] | null)[];
  valY: number[];
  valGroups: string[];
  valBaseline: number[];
  inner: { lambda: number; platt: PlattParams } | null;
}

interface Setup {
  rows: TrainingRow[];
  metrics: TrainMetrics;
  research: boolean;
  ctx: Ctx;
  plan: FoldPlan | null;
  /** A rejection decided before any fold runs. */
  rejected: string[] | null;
}

function setup(
  args: TrainArgs,
  opts: { mode: 'production' | 'research' },
  withSha: boolean,
): Setup {
  const cfg = args.config;
  const mc = cfg.model;
  const research = opts.mode === 'research';
  const elig = { now: args.now, historyDays: mc.historyDays, ratingSha: args.ratingSha };
  const { rows, skipped } = eligibleRows(args.samples, elig);
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
    eligibleSetSha: withSha ? eligibleSetSha(args.samples, elig) : '',
    feedbackCutoffEventId: args.feedbackCutoffEventId,
  };
  const ctx: Ctx = { cfg, held: args.heldCards, grid: mc.lambdaGrid };
  const minimums = minimumReasons(metrics, mc);
  if (rows.length === 0 || (!research && minimums.length > 0)) {
    return {
      rows,
      metrics,
      research,
      ctx,
      plan: null,
      rejected: minimums.length > 0 ? minimums : ['insufficient_explicit'],
    };
  }
  const plan = planFolds(
    rows.map((r) => r.s),
    `${args.seedMaterial}|outer`,
  );
  const rejected = plan === null && !research ? ['insufficient_validation'] : null;
  return { rows, metrics, research, ctx, plan, rejected };
}

/** How many outer folds {@link trainFold} must run for these arguments (0: none). */
export function trainingFolds(args: TrainArgs, opts: { mode: 'production' | 'research' }): number {
  const { plan, rejected } = setup(args, opts, false);
  return rejected === null && plan !== null ? plan.k : 0;
}

/** Outer fold `f` of {@link trainUserModel} (D-262): independent of the other folds. */
export function trainFold(
  args: TrainArgs,
  opts: { mode: 'production' | 'research' },
  f: number,
): FoldResult {
  const { rows, metrics, ctx, plan } = setup(args, opts, false);
  if (plan === null || f < 0 || f >= plan.k) throw new RangeError(`no outer fold ${f}`);
  const trainRows = rows.filter((_, i) => plan.folds[i] !== f);
  const valRows = rows.filter((r, i) => plan.folds[i] === f && r.s.explicit);
  const design = buildDesign(trainRows, ctx);
  const fits = fitGrid(design, ctx.grid);
  const valX = design.std(valRows);
  return {
    fits: fits.map((fit) =>
      fit.ok ? { ok: true as const } : { ok: false as const, reason: fit.reason },
    ),
    valLogits: fits.map((fit) => (fit.ok ? logitsOf(fit, valX) : null)),
    valY: valRows.map((r) => r.s.y),
    valGroups: valRows.map((r) => r.s.groupId),
    valBaseline: valRows.map((r) => baselineScore(r, ctx.cfg)),
    inner:
      metrics.nExplicit < NESTED_CV_MAX_EXPLICIT
        ? innerSelect(trainRows, `${args.seedMaterial}|inner|${f}`, ctx)
        : null,
  };
}

/**
 * The pure personal-model trainer (spec 06 §8.1-8.3): eligibility, grouped CV with per-partition
 * own inputs and scaling, λ and Platt by nested folds, the cards-only baseline and the activation
 * reasons. `research` mode skips the minimums, flags the metrics and is never eligible.
 */
export function trainUserModel(
  args: TrainArgs,
  opts: { mode: 'production' | 'research' },
): TrainResult {
  const k = trainingFolds(args, opts);
  return finishTraining(
    args,
    opts,
    Array.from({ length: k }, (_, f) => trainFold(args, opts, f)),
  );
}

/**
 * {@link trainUserModel} from the results of its outer folds, in fold order (D-262): the λ and
 * Platt choice, the metrics with their intervals, and the final fit. Running the folds anywhere
 * (threads) gives the same result as running them here.
 */
export function finishTraining(
  args: TrainArgs,
  opts: { mode: 'production' | 'research' },
  folds: readonly FoldResult[],
): TrainResult {
  const { rows, metrics, research, ctx, plan, rejected } = setup(args, opts, true);
  const cfg = args.config;
  const mc = cfg.model;
  const reject = (reasons: string[]): TrainResult => ({
    model: null,
    metrics,
    activation: { eligible: false, reasons },
  });
  if (rejected !== null) return reject(rejected);
  if ((plan?.k ?? 0) !== folds.length) {
    throw new RangeError(`expected ${plan?.k ?? 0} fold results, got ${folds.length}`);
  }

  const largest = Math.max(...ctx.grid);
  const seed = args.seedMaterial;
  const base = baselineOf(rows, cfg);
  const baselineAucOf = aucScorer(base.scores, base.y);
  metrics.baselineAuc = baselineAucOf();
  metrics.baselineLogloss = base.y.length > 0 ? logLoss(base.scores, base.y) : null;
  metrics.ci.baselineAuc = groupedBootstrapCi(
    base.groups,
    (m) => baselineAucOf(m),
    `${seed}|baseline`,
  );

  let lambda = largest;
  let platt = IDENTITY;
  if (plan !== null) {
    metrics.k = plan.k;
    const oofAt = (li: number): { z: number[]; y: number[] } | null => {
      const z: number[] = [];
      const y: number[] = [];
      for (const fold of folds) {
        const logits = fold.valLogits[li];
        if (logits === undefined || logits === null) return null;
        z.push(...logits);
        y.push(...fold.valY);
      }
      return { z, y };
    };
    const losses = lambdaLosses(oofAt, ctx);
    if (losses.some((e) => Number.isFinite(e.loss))) {
      lambda = chooseLambda(losses);
      const o = oofAt(ctx.grid.indexOf(lambda));
      if (o !== null) platt = fitPlatt(o.z, o.y);
    }

    const probs: number[] = [];
    const ys: number[] = [];
    const groups: string[] = [];
    const baseScores: number[] = [];
    for (const fold of folds) {
      const chosen = fold.inner ?? { lambda, platt };
      const li = ctx.grid.indexOf(chosen.lambda);
      const fit = fold.fits[li];
      const logits = fold.valLogits[li];
      if (fit === undefined || !fit.ok || logits === undefined || logits === null)
        return reject([fit?.ok === false ? fit.reason : 'nonconverged']);
      for (const z of logits) probs.push(applyPlatt(chosen.platt, z));
      ys.push(...fold.valY);
      groups.push(...fold.valGroups);
      baseScores.push(...fold.valBaseline);
    }
    const cvAucOf = aucScorer(probs, ys);
    const foldBaselineAucOf = aucScorer(baseScores, ys);
    metrics.ci.cvAuc = groupedBootstrapCi(groups, (m) => cvAucOf(m), `${seed}|cv`);
    metrics.ci.deltaAuc = groupedBootstrapCi(
      groups,
      (m) => {
        const model = cvAucOf(m);
        const baseline = foldBaselineAucOf(m);
        return model === null || baseline === null ? null : model - baseline;
      },
      `${seed}|delta`,
    );
    metrics.cvAuc = cvAucOf();
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
