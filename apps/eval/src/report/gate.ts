import { mergeRankerConfig, type RankerThresholds } from '@bantoozi/ranker';
import { compareBigIntStrings } from '@bantoozi/shared';

import {
  chooseCardMode,
  chooseLanguageMode,
  chooseTier2Cap,
  composeConfiguration,
  confirmGate,
  CORE_CANDIDATES,
  CORE_VARIANTS,
  recommendDailyBudget,
  runEligibility,
  selectBaseline,
  selectCore,
  selectDemotionCutoff,
  selectForYou,
  selectMaybe,
  selectTiers,
  weightPool,
  type BaselineCandidate,
  type CardModeDecision,
  type ConfirmationDecision,
  type CoreCandidate,
  type DemotionDecision,
  type Eligibility,
  type LanguageModeDecision,
  type Profile,
  type ThresholdDecision,
  type Tier2Decision,
  type TierDecision,
} from './decision.js';
import {
  DEMOTION_FLAGS,
  demotionSamples,
  precisionRecallAtCutoff,
  type CutoffResult,
  type DemotionFlag,
} from './enrichment.js';
import { g1ConfigSha, type G1File } from './g1-schema.js';
import { groundTruthSha, onSplit, runScore, scoringCoverage, type RatedItem } from './items.js';
import { compositionView, runView, type ReportModel, type ScoreView } from './model.js';
import type { PolicyConfig } from './policy.js';
import {
  buildCells,
  macroAuc,
  pairedMacroDelta,
  type BootstrapSettings,
  type Cell,
} from './ranking.js';
import { assessReadiness, type Readiness } from './readiness.js';
import { uncachedUsd } from './render.js';
import type { RunData } from './run-data.js';

/**
 * Gate G1 (spec 10 §5) over loaded data, without I/O. The command runs it in three steps so the
 * test split stays sealed until the selection is locked:
 *
 * 1. {@link assessGateRuns} and readiness (label counts only, no scores);
 * 2. {@link selectOnDevelopment}: every choice from development items only — the function receives
 *    the development items and nothing else, so a test label cannot influence it;
 * 3. after the lock, {@link confirmOnTest} evaluates the actual composed per-language
 *    configuration against the locked baseline on test items.
 */

export const GATE_EXPERIMENTS = [
  'B0',
  'B1',
  'B1-T',
  'E1',
  'E2',
  'E3',
  'E3b',
  'E4',
  'E5',
  'E6',
  'E7',
] as const;

/** Experiments whose answers must all come from the pinned Jev engine (spec 10 §3). */
const PINNED_ENGINE = new Set(['E1', 'E2', 'E3', 'E3b', 'E4', 'E6', 'E7']);

export interface GateDataset {
  version: string;
  snapshotSha: string;
  splitSha: string;
}

export interface RunAssessment extends Eligibility {
  experiment: string;
  run: RunData | null;
}

/** Eligibility of every gate run against the dataset hashes and the reference run. */
export function assessGateRuns(
  model: ReportModel,
  runs: ReadonlyMap<string, RunData>,
  dataset: GateDataset,
): Map<string, RunAssessment> {
  const reference = model.reference;
  const cohortSha = reference?.config.cohort.sha ?? null;
  const truth = reference === null ? null : groundTruthSha(reference.config);
  const result = new Map<string, RunAssessment>();
  for (const experiment of GATE_EXPERIMENTS) {
    const run = runs.get(experiment) ?? null;
    if (run === null) {
      result.set(experiment, { experiment, run, eligible: false, reasons: ['no run'] });
      continue;
    }
    const computed = scoringCoverage(run, model.items);
    const stored = run.results?.coverage;
    const merge = (
      mine: Map<string, { expected: number; valid: number }>,
      theirs: Record<string, { expected: number; valid: number }> | undefined,
    ) => {
      const out: Record<string, { expected: number; valid: number }> = {};
      for (const [key, value] of mine) out[key] = value;
      for (const [key, value] of Object.entries(theirs ?? {})) {
        const current = out[key];
        // The stricter of the runner's and the report's view.
        if (
          current === undefined ||
          (value.expected > 0 &&
            value.valid / value.expected < current.valid / Math.max(1, current.expected))
        ) {
          out[key] = value;
        }
      }
      return out;
    };
    const informational = experiment === 'E6' || experiment === 'E7';
    let foreign = 0;
    if (PINNED_ENGINE.has(experiment)) {
      for (const answers of run.cards.values()) {
        for (const answer of answers.values())
          if (answer.ok && answer.engine !== 'typesafe') foreign += 1;
      }
    }
    const eligibility = runEligibility({
      experiment,
      runId: run.id,
      status: run.results?.status ?? null,
      datasetMatches:
        run.datasetVersion === dataset.version &&
        run.config.snapshotSha === dataset.snapshotSha &&
        run.config.splitSha === dataset.splitSha,
      cohortMatches: run.config.cohort.sha === cohortSha,
      groundTruthMatches: groundTruthSha(run.config) === truth,
      // E6/E7 rerun subsets; their coverage is reported, not gated.
      coverage: informational
        ? { byLang: {}, byRater: {} }
        : {
            byLang: merge(computed.byLang, stored?.byLang),
            byRater: merge(computed.byRater, stored?.byRater),
          },
      foreignEngineAnswers: foreign,
    });
    result.set(experiment, { experiment, run, ...eligibility });
  }
  return result;
}

/**
 * The gate's languages: every language of the dataset plus any the reference run served, so a run
 * limited to a subset (`--langs en`) leaves the others visible as unmeasured instead of dropping
 * them from readiness, composition and the budget.
 */
export function gateLangs(model: ReportModel): string[] {
  return [...new Set([...model.langs, ...(model.reference?.config.langs ?? [])])].sort();
}

export function gateReadiness(model: ReportModel, profile: Profile): Readiness {
  return assessReadiness(profile, model.items, gateLangs(model));
}

// ── Development selection ───────────────────────────────────────────────────────────────────

export interface DevelopmentInput {
  profile: Profile;
  dataset: GateDataset;
  /** Development items only. */
  devItems: readonly RatedItem[];
  runs: ReadonlyMap<string, RunAssessment>;
  /** Languages of the dataset. */
  langs: readonly string[];
  /** Development sample articles per language (for the demotion cutoffs). */
  devArticles: ReadonlyMap<string, readonly string[]>;
  labels: ReportModel['labels'];
  /** Non-English-card contexts (spec 10 §5 step 2). */
  nonEnglishCardContexts: ReadonlySet<string>;
  /** Contexts per language that also read English (bilingual comparisons). */
  raterLangs: ReadonlyMap<string, readonly string[]>;
  /** Language of every sample article (both splits), to attribute a run's work to languages. */
  articleLang: ReadonlyMap<string, string>;
  dailyRevisions: number;
}

/**
 * How the budget's per-article cost was attributed to languages: `per_language` from the runs'
 * recorded `cost.byLang`; `run_total` charges each composed run's whole uncached cost to the
 * articles of the languages it serves (an upper bound when no per-language split is recorded).
 */
export type CostBasis = 'per_language' | 'run_total';

/** Articles of `run` (any answer) whose sample language is in `langs`. */
function processedArticlesIn(
  run: RunData,
  langs: ReadonlySet<string>,
  articleLang: ReadonlyMap<string, string>,
): number {
  const ids = new Set<string>([...run.enrich.keys(), ...run.cards.keys()]);
  for (const scores of run.scores.values()) for (const id of scores.keys()) ids.add(id);
  for (const answers of run.extra.values()) for (const id of answers.keys()) ids.add(id);
  let n = 0;
  for (const id of ids) if (langs.has(articleLang.get(id) ?? '')) n += 1;
  return n;
}

function uncachedOf(
  cost:
    | {
        billedUsd?: number | null | undefined;
        estimatedUsd?: number | null | undefined;
        cacheSavingsUsd?: number | null | undefined;
      }
    | null
    | undefined,
): number | null {
  if (cost === null || cost === undefined) return null;
  if (cost.billedUsd === null || cost.billedUsd === undefined) return cost.estimatedUsd ?? null;
  return cost.billedUsd + (cost.cacheSavingsUsd ?? 0);
}

/**
 * The uncached $ per article of the composed configuration (spec 10 §5 budget): each language's
 * per-article cost under the run composed for it, weighted by the language's development share.
 * Language-specific spend (e.g. E3's translation of SK/CS) is never averaged over articles of
 * languages the run does not serve. With `cost.byLang` recorded, a language's cost is its own
 * uncached spend over its own processed articles. Without it, the run's whole uncached cost is
 * charged to the articles of the languages it serves (`run_total`): never below the true cost,
 * since the run's other-language spend only adds to it.
 */
export function composedCostPerArticle(
  compositionRuns: Readonly<Record<string, RunData | null>>,
  devArticles: ReadonlyMap<string, readonly string[]>,
  articleLang: ReadonlyMap<string, string>,
): { usdPerArticle: number | null; basis: CostBasis } {
  let devTotal = 0;
  for (const ids of devArticles.values()) devTotal += ids.length;
  const share = (lang: string) =>
    devTotal === 0 ? 0 : (devArticles.get(lang)?.length ?? 0) / devTotal;
  // Every development language must be served by a run whose accounting is complete and that
  // processed it; otherwise the budget is unmeasured, never an understated average.
  for (const [lang, ids] of devArticles) {
    if (ids.length === 0) continue;
    const source = compositionRuns[lang];
    if (source === null || source === undefined || source.results?.cost?.incomplete === true)
      return { usdPerArticle: null, basis: 'run_total' };
    if (processedArticlesIn(source, new Set([lang]), articleLang) === 0)
      return { usdPerArticle: null, basis: 'run_total' };
  }
  const served = new Map<RunData, Set<string>>();
  for (const [lang, source] of Object.entries(compositionRuns)) {
    if (source === null || share(lang) === 0) continue;
    const langs = served.get(source) ?? new Set<string>();
    langs.add(lang);
    served.set(source, langs);
  }
  const perLanguage = [...served].every(([run, langs]) =>
    [...langs].every((lang) => uncachedOf(run.results?.cost?.byLang?.[lang]) !== null),
  );
  const basis: CostBasis = perLanguage ? 'per_language' : 'run_total';
  let total = 0;
  for (const [lang, source] of Object.entries(compositionRuns)) {
    const w = share(lang);
    if (w === 0) continue;
    if (source === null) return { usdPerArticle: null, basis };
    const langs = served.get(source) ?? new Set([lang]);
    const usd = perLanguage
      ? uncachedOf(source.results?.cost?.byLang?.[lang])
      : uncachedUsd(source);
    const articles = processedArticlesIn(
      source,
      perLanguage ? new Set([lang]) : langs,
      articleLang,
    );
    if (usd === null || articles === 0) return { usdPerArticle: null, basis };
    total += w * (usd / articles);
  }
  return { usdPerArticle: total, basis };
}

export interface GateSelection {
  profile: Profile;
  dataset: GateDataset;
  status: 'selected' | 'needs_more_data';
  reasons: string[];
  baseline: BaselineCandidate | null;
  core: CoreCandidate | null;
  devMacro: Record<string, number | null>;
  cardMode: CardModeDecision;
  languages: LanguageModeDecision[];
  tier2: Tier2Decision;
  composition: Record<string, CoreCandidate>;
  forYou: ThresholdDecision;
  maybe: ThresholdDecision;
  tiers: TierDecision;
  demotion: DemotionDecision[];
  thresholds: RankerThresholds;
  languageModes: Record<string, 'native' | 'translate'>;
  laya: boolean;
  budget: {
    value: number;
    status: 'measured' | 'unmeasured';
    costPer1000Usd: number | null;
    costBasis: CostBasis;
    dailyRevisions: number;
  };
  runs: Record<string, string>;
  developmentRunIds: string[];
  configSha: string;
}

const eligibleRun = (
  runs: ReadonlyMap<string, RunAssessment>,
  experiment: string,
): RunData | null => {
  const a = runs.get(experiment);
  return a?.eligible === true ? a.run : null;
};

function scoreOf(run: RunData | null): (item: RatedItem) => number | null {
  return (item) => (run === null ? null : runScore(run, item));
}

function devMacro(cells: readonly Cell[], run: RunData | null): number | null {
  return run === null ? null : macroAuc(cells, scoreOf(run)).value;
}

/** Spec 10 §5 steps 1–5 on development data only. */
export function selectOnDevelopment(input: DevelopmentInput): GateSelection {
  const reasons: string[] = [];
  const items = input.devItems.filter((item) => item.split === 'dev');
  const contextCells = buildCells(items, 'context');
  const langCells = buildCells(items, 'context-lang');
  const run = (e: string) => eligibleRun(input.runs, e);

  // Step 1.
  const devMacroByRun: Record<string, number | null> = {};
  for (const e of ['B0', 'B1', 'B1-T', ...CORE_CANDIDATES, 'E4', 'E5']) {
    devMacroByRun[e] = devMacro(contextCells, run(e));
  }
  const baseline = selectBaseline(
    (['B1', 'B1-T'] as const).map((e) => ({
      experiment: e,
      eligible: run(e) !== null,
      devMacroAuc: devMacroByRun[e] ?? null,
    })),
  );
  if (baseline === null) reasons.push('no eligible keyword baseline (B1/B1-T)');
  const core = selectCore(
    CORE_CANDIDATES.map((e) => ({
      experiment: e,
      eligible: run(e) !== null,
      devMacroAuc: devMacroByRun[e] ?? null,
    })),
  );
  if (core === null) reasons.push('no eligible core candidate (E1/E2/E3/E3b)');

  // Step 2: the paired card-mode gain inside the selected state family.
  const family = core === null ? 'native' : CORE_VARIANTS[core].family;
  const [asWrittenExp, englishExp] =
    family === 'native' ? (['E1', 'E2'] as const) : (['E3', 'E3b'] as const);
  const nonEnglishCells = contextCells.filter((c) => input.nonEnglishCardContexts.has(c.contextId));
  const cardMode = chooseCardMode({
    asWritten: nonEnglishCells.length === 0 ? null : devMacro(nonEnglishCells, run(asWrittenExp)),
    english: nonEnglishCells.length === 0 ? null : devMacro(nonEnglishCells, run(englishExp)),
  });

  // Step 3: per-language modes within the selected card mode.
  const nativeExp: CoreCandidate = cardMode.mode === 'english' ? 'E2' : 'E1';
  const translatedExp: CoreCandidate = cardMode.mode === 'english' ? 'E3b' : 'E3';
  const nativeRun = run(nativeExp);
  const translatedRun = run(translatedExp);
  const languages: LanguageModeDecision[] = [];
  const tier2Gains: Record<string, number | null> = {};
  const e4 = run('E4');
  const e4Matches = e4 !== null && e4.config.variant?.cards === cardMode.mode;
  for (const lang of [...new Set(input.langs)].sort()) {
    if (lang === 'en') continue;
    const cells = langCells.filter((c) => c.lang === lang);
    const bilingualContexts = new Set(
      [...input.raterLangs]
        .filter(([, langs]) => langs.includes('en') && langs.includes(lang))
        .map(([id]) => id),
    );
    const bNative = cells.filter((c) => bilingualContexts.has(c.contextId));
    const bEnglish = langCells.filter((c) => c.lang === 'en' && bilingualContexts.has(c.contextId));
    const native = devMacro(cells, nativeRun);
    const translated = devMacro(cells, translatedRun);
    languages.push(
      chooseLanguageMode({
        lang,
        native,
        translated,
        bilingual: {
          native: bNative.length === 0 ? null : devMacro(bNative, nativeRun),
          english: bEnglish.length === 0 ? null : devMacro(bEnglish, nativeRun),
        },
      }),
    );
    const e4Auc = e4Matches ? devMacro(cells, e4) : null;
    tier2Gains[lang] = e4Auc === null || translated === null ? null : e4Auc - translated;
  }
  const tier2 = chooseTier2Cap(tier2Gains);
  const modes: Record<string, 'native' | 'translate' | null> = Object.fromEntries(
    languages.map((l) => [l.lang, l.mode]),
  );
  const composition = composeConfiguration(input.langs, cardMode.mode, modes);
  const compositionRuns: Record<string, RunData | null> = Object.fromEntries(
    Object.entries(composition).map(([lang, e]) => [lang, run(e)]),
  );
  for (const [lang, e] of Object.entries(composition)) {
    if (compositionRuns[lang] === null)
      reasons.push(`composition needs ${e} for ${lang}, which is not eligible`);
  }
  const composed = compositionView('composition', compositionRuns, null);

  // Step 4: one global threshold object from the pooled composed scores. Only supported
  // development contexts (≥ 20 items, ≥ 5 per class) contribute: hierarchical weighting gives each
  // context an equal share of its participant, so an unsupported one could swing the thresholds.
  const supportedContexts = new Set(
    contextCells.filter((c) => c.supported).map((c) => c.contextId),
  );
  const pool = weightPool(
    items
      .filter((item) => supportedContexts.has(item.contextId))
      .map((item) => ({ item, p: composed.score(item) }))
      .filter((x): x is { item: RatedItem; p: number } => x.p !== null && x.p >= 0 && x.p <= 1)
      .map(({ item, p }) => ({
        participantKey: item.participantKey,
        contextId: item.contextId,
        articleId: item.articleId,
        p,
        liked: item.liked,
      })),
  );
  const forYou = selectForYou(pool, input.profile);
  const maybe = selectMaybe(pool, forYou.value, input.profile);
  const tiers = selectTiers(pool);
  const demotion = DEMOTION_FLAGS.map(({ flag }) => {
    const samples = [...input.devArticles.entries()].flatMap(([lang, ids]) => {
      const source = compositionRuns[lang] ?? null;
      return source === null
        ? []
        : demotionSamples(flag, ids, input.labels, (id, key) => source.enrich.get(id)?.get(key));
    });
    return selectDemotionCutoff(flag, samples);
  });
  const demotionValues = Object.fromEntries(demotion.map((d) => [d.flag, d.value])) as Record<
    DemotionFlag,
    number
  >;
  const thresholds: RankerThresholds = {
    lanes: { forYou: forYou.value, maybe: maybe.value },
    tiers: tiers.value,
    demotion: demotionValues,
  };
  mergeRankerConfig(thresholds);

  const cost = composedCostPerArticle(compositionRuns, input.devArticles, input.articleLang);
  // Spec 10 §5: the budget is measured; without a measurement the gate cannot select.
  if (cost.usdPerArticle === null)
    reasons.push(
      'budget unmeasured: a composed language has no run that processed it, or its cost accounting is incomplete',
    );
  const costPer1000 = cost.usdPerArticle === null ? null : cost.usdPerArticle * 1000;
  const budget = {
    ...recommendDailyBudget(costPer1000, input.dailyRevisions),
    costPer1000Usd: costPer1000,
    costBasis: cost.basis,
    dailyRevisions: input.dailyRevisions,
  };

  const languageModes: Record<string, 'native' | 'translate'> = {};
  if (input.langs.includes('en')) languageModes['en'] = 'native';
  // An unmeasured language keeps the default mode, native (spec 10 §5), written explicitly: the
  // composition above scored, thresholded and budgeted it as native, so applying G1 must not leave
  // a stored `translate` in place and deploy a configuration the gate never confirmed.
  for (const l of languages) languageModes[l.lang] = l.mode ?? 'native';

  const runs: Record<string, string> = {};
  for (const [experiment, a] of input.runs)
    if (a.run !== null && a.eligible) runs[experiment] = a.run.id;
  const developmentRunIds = [...new Set(Object.values(runs))].sort(compareBigIntStrings);
  const laya = languages.some((l) => l.layaRecommended);
  const configSha = g1ConfigSha({
    language_modes: languageModes,
    card_text_mode: cardMode.mode,
    ranker_thresholds: thresholds,
    recommended_daily_budget_usd: budget.value,
    translate_tier2_daily_cap: tier2.cap,
    laya_track_recommended: laya,
    runs,
    dataset: {
      version: input.dataset.version,
      snapshotSha: input.dataset.snapshotSha,
      splitSha: input.dataset.splitSha,
    },
    profile: input.profile,
  });
  return {
    profile: input.profile,
    dataset: input.dataset,
    status: reasons.length === 0 ? 'selected' : 'needs_more_data',
    reasons,
    baseline,
    core,
    devMacro: devMacroByRun,
    cardMode,
    languages,
    tier2,
    composition,
    forYou,
    maybe,
    tiers,
    demotion,
    thresholds,
    languageModes,
    laya,
    budget,
    runs,
    developmentRunIds,
    configSha,
  };
}

/** Build the development-only input from a report model (the only place test items are dropped). */
export function developmentInput(
  model: ReportModel,
  runs: ReadonlyMap<string, RunAssessment>,
  profile: Profile,
  dataset: GateDataset,
  dailyRevisions: number,
): DevelopmentInput {
  const cards = model.reference?.config.cards ?? [];
  const nonEnglish = new Set(
    cards
      .filter(
        (c) => c.strength !== 'never' && c.lang !== undefined && c.lang !== null && c.lang !== 'en',
      )
      .map((c) => c.raterId),
  );
  const devArticles = new Map<string, string[]>();
  const articleLang = new Map<string, string>();
  for (const info of model.sample.values()) {
    articleLang.set(info.articleId, info.lang);
    if (info.split !== 'dev') continue;
    devArticles.set(info.lang, [...(devArticles.get(info.lang) ?? []), info.articleId]);
  }
  return {
    profile,
    dataset,
    devItems: onSplit(model.items, 'dev'),
    runs,
    langs: gateLangs(model),
    devArticles,
    articleLang,
    labels: model.labels,
    nonEnglishCardContexts: nonEnglish,
    raterLangs: new Map((model.reference?.config.raters ?? []).map((r) => [r.raterId, r.langs])),
    dailyRevisions,
  };
}

// ── Test confirmation ───────────────────────────────────────────────────────────────────────

export interface TestConfirmation {
  decision: ConfirmationDecision;
  macro: number | null;
  baselineMacro: number | null;
  delta: ReturnType<typeof pairedMacroDelta>;
  participants: Map<string, { candidate: number | null; baseline: number | null }>;
  composedView: ScoreView;
  baselineView: ScoreView | null;
  policyConfig: PolicyConfig;
}

/** The selected per-language composition vs the locked baseline on the test split only. */
export function confirmOnTest(
  model: ReportModel,
  runs: ReadonlyMap<string, RunAssessment>,
  selection: GateSelection,
  settings: BootstrapSettings,
): TestConfirmation {
  const testItems = onSplit(model.items, 'test');
  const cells = buildCells(testItems, 'context');
  const compositionRuns: Record<string, RunData | null> = Object.fromEntries(
    Object.entries(selection.composition).map(([lang, e]) => [lang, eligibleRun(runs, e)]),
  );
  const composedView = compositionView('G1 composition', compositionRuns, null);
  const baselineRun = selection.baseline === null ? null : eligibleRun(runs, selection.baseline);
  const baselineView = baselineRun === null ? null : runView(baselineRun);
  const macro = macroAuc(cells, composedView.score);
  const base = baselineView === null ? null : macroAuc(cells, baselineView.score);
  const participantKeys = [...new Set(testItems.map((i) => i.participantKey))].sort();
  const participants = new Map(
    participantKeys.map((key) => [
      key,
      {
        candidate: macro.byParticipant.get(key) ?? null,
        baseline: base?.byParticipant.get(key) ?? null,
      },
    ]),
  );
  const decision =
    selection.status !== 'selected'
      ? { status: 'needs_more_data' as const, reasons: selection.reasons }
      : confirmGate({ macro: macro.value, baselineMacro: base?.value ?? null, participants });
  const delta = pairedMacroDelta(cells, composedView.score, baselineView?.score ?? (() => null), {
    ...settings,
    seed: `${settings.seed}:test:composition`,
  });
  const merged = mergeRankerConfig(selection.thresholds);
  return {
    decision,
    macro: macro.value,
    baselineMacro: base?.value ?? null,
    delta,
    participants,
    composedView,
    baselineView,
    policyConfig: merged,
  };
}

/** The decision file of a finished gate. */
export function buildG1(input: {
  selection: GateSelection;
  status: 'pass' | 'fail' | 'needs_more_data';
  participants: number;
  lockedAt: Date;
  reportSha: string;
  notes: string;
  dryRun: boolean;
}): G1File {
  const s = input.selection;
  return {
    language_modes: s.languageModes,
    card_text_mode: s.cardMode.mode,
    ranker_thresholds: s.thresholds,
    recommended_daily_budget_usd: s.budget.value,
    translate_tier2_daily_cap: s.tier2.cap,
    laya_track_recommended: s.laya,
    runs: s.runs,
    notes: input.notes,
    dataset: {
      version: s.dataset.version,
      snapshotSha: s.dataset.snapshotSha,
      splitSha: s.dataset.splitSha,
    },
    selection: {
      developmentRunIds: s.developmentRunIds,
      lockedAt: input.lockedAt.toISOString(),
      configSha: s.configSha,
    },
    gate: {
      profile: s.profile,
      participants: input.participants,
      status: input.status,
      reportSha: input.reportSha,
    },
    ...(input.dryRun ? { dryRun: true } : {}),
  };
}

/**
 * Test precision and recall of every demotion cutoff, pooled over the languages of the composed
 * configuration (each language's Call A answers from its composed run), at the configured default
 * and at the selected value (spec 10 §5: reported, and below 0.80 an owner-review item).
 */
export function demotionOnTest(
  model: ReportModel,
  runs: ReadonlyMap<string, RunAssessment>,
  selection: GateSelection,
): { flag: DemotionFlag; configured: CutoffResult; selected: CutoffResult; samples: number }[] {
  const byLang = new Map<string, string[]>();
  for (const info of model.sample.values()) {
    if (info.split !== 'test') continue;
    byLang.set(info.lang, [...(byLang.get(info.lang) ?? []), info.articleId]);
  }
  return selection.demotion.map((decision) => {
    const spec = DEMOTION_FLAGS.find((d) => d.flag === decision.flag);
    const direction = spec?.direction ?? 'gte';
    const samples = [...byLang.entries()].flatMap(([lang, ids]) => {
      const experiment = selection.composition[lang];
      const source = experiment === undefined ? null : eligibleRun(runs, experiment);
      return source === null
        ? []
        : demotionSamples(decision.flag, ids, model.labels, (id, key) =>
            source.enrich.get(id)?.get(key),
          );
    });
    return {
      flag: decision.flag,
      configured: precisionRecallAtCutoff(samples, decision.default, direction),
      selected: precisionRecallAtCutoff(samples, decision.value, direction),
      samples: samples.length,
    };
  });
}
