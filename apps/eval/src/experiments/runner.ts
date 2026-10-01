import { performance } from 'node:perf_hooks';

import {
  createRun,
  finishRun,
  freezeDataset,
  getDataset,
  getRun,
  headDataset,
  latestFinishedRunId,
  lockDatasetAdditions,
  loadDatasetTruth,
  loadEvalAssignments,
  loadEvalFacetLabels,
  loadEvalRaterCards,
  loadEvalRaters,
  loadEvalRatings,
  loadRunAnswers,
  loadSample,
  readStoredSetting,
  type RunLock,
  runCallSpend,
  runCallSpendByArticle,
  tryLockRun,
  findDerivedRunId,
  updateRunResults,
  upsertRunAnswers,
  type DatasetRow,
  type ArticleCallSpend,
  type DatasetSplit,
  type Executor,
  type RunAnswerInput,
} from '@bantoozi/db';
import { OLLAMA_PRICE_TABLE_VERSION, type EngineLogger } from '@bantoozi/engine';
import { ENRICH_V1, MATCH_V1, type Answer, type StateVariant } from '@bantoozi/questions';
import { mergeRankerConfig, type CardAnswer, type RankerConfig } from '@bantoozi/ranker';
import { parseSetting, type CardTextMode, type JsonValue } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';
import { TRANSLATION_POLICY_VERSION } from '@bantoozi/translate';
import { z } from 'zod';

import { asSnapshot, type EvalSnapshot } from '../dataset/snapshot.js';
import { EvalCommandError, type EvalRuntime } from '../runtime.js';
import { createEvalCache, EVAL_CACHE_VERSION, type EvalCache } from './cache.js';
import {
  askCards,
  askEnrich,
  createRunStats,
  ENGINE_ADAPTER_VERSIONS,
  jsonAnswer,
  translateArticle,
  translateCard,
  type AbortState,
  type CallEnv,
  type CardAsk,
  type CardResult,
  type LangCost,
  type RunStats,
} from './calls.js';
import { EXPERIMENTS, type ExperimentDefinition, type ExperimentId } from './definitions.js';
import { planE6, type E6Plan } from './e6.js';
import { planE7, type E7Item } from './e7.js';
import {
  assignmentsByRater,
  compareIds,
  parseRunConfig,
  runCardOf,
  runFacetLabelOf,
  runRaterOf,
  runRatingOf,
  withConfigSha,
  type RunCard,
  type RunConfig,
  type RunEngine,
} from './run-config.js';
import {
  bm25Corpus,
  bm25ScoreRow,
  bm25Text,
  cardsComplete,
  cardsScoreRow,
  chronoScores,
  rankCardOf,
  type ScoreRow,
} from './scores.js';
import {
  createEvalRouter,
  evalCredentials,
  evalTranslators,
  type EvalServiceOverrides,
  type EvalTranslators,
} from './services.js';
import {
  buildCardQuestion,
  buildState,
  E7_GENERIC_SENTENCE,
  e7TargetedSentence,
  modelInputOf,
  steeredInput,
  type BuiltCard,
  type FrozenTranslation,
} from './states.js';
import { currentGitSha, formatUsd, latencySummary, mapPool } from './util.js';

/**
 * The experiment runner (M3a-T6, spec 10 §3). `runExperiment` is the programmatic API behind
 * `eval run <experiment>` (and the in-process dry run, M3a-T8):
 *
 * 1. Collect the run's inputs (dataset version, raters, cards, assignments, ratings, facet labels;
 *    E6/E7 take them from the E1 run they build on) and the cohort.
 * 2. Estimate the cost with the cache consulted and nothing sent, and print it. Above $1 the run
 *    needs `--yes` or an interactive confirmation.
 * 3. Freeze the dataset version (idempotent) before the first model call, then write `eval.runs`
 *    with its immutable config (D-110).
 * 4. Ask through one eval router (`kind = 'eval'`, `budgetOverrideUsd = --max-usd`,
 *    `ignoreDailyCaps`, `requiredEngine`, `{type: 'eval', runId}`) and the cache, upserting the
 *    answers per article, so a resumed run (`--resume <runId>`) never duplicates them.
 * 5. Score every rated (article, rater) pair and finish the run with coverage, cost and latency.
 *    Reaching the invocation cap stops the run as `aborted` with the answers so far.
 */

export const DEFAULT_MAX_USD = 10;
/** Above this estimate the run asks for confirmation unless `--yes` (spec 10 §3). */
export const CONFIRM_ABOVE_USD = 1;

export type RunStatus = 'complete' | 'partial' | 'aborted' | 'skipped';

export interface CostEstimate {
  estimatedUsd: number;
  /** Requests the run would send (cache misses). */
  uncachedCalls: number;
  cacheHits: number;
}

export interface RunExperimentOptions {
  experiment: ExperimentId;
  /** Default: the head dataset version. */
  datasetVersion?: string;
  /** Default: the experiment's languages, else every language of the version. */
  langs?: readonly string[];
  /** Default: every rater. */
  raterIds?: readonly string[];
  /** Skip the confirmation above $1. */
  yes?: boolean;
  /** The invocation cap; default 10. */
  maxUsd?: number;
  /** Default: the dataset version's seed. */
  seed?: string;
  /** E4's card text mode (the global mode selected on development); default `as_written`. */
  cardTextMode?: CardTextMode;
  /** E6/E7: the E1 run; default the newest finished E1 run of the version. */
  baseRunId?: string;
  /** Continue an unfinished or partial run of the same experiment (answers are upserted). */
  resumeRunId?: string;
  /** Asked when the estimate exceeds $1 without `yes`; absent → the run is declined. */
  confirm?: (estimate: CostEstimate) => Promise<boolean>;
  services?: EvalServiceOverrides;
  /** Default: `git rev-parse HEAD`. */
  gitSha?: string;
  /** Articles in flight at once; default 4. */
  concurrency?: number;
  /** Internal: a replay's frozen plan (see `replay.ts`). */
  replay?: ReplayPlan;
}

/** What a replay hands the runner: the compared run's config with the proposed change. */
export interface ReplayPlan {
  baseRunId: string;
  config: Omit<RunConfig, 'configSha'>;
  translations: Map<string, FrozenTranslation | null>;
}

export interface RunResults {
  status: RunStatus;
  reason?: string;
  coverage: {
    byLang: Record<string, { expected: number; valid: number }>;
    byRater: Record<string, { expected: number; valid: number }>;
    enrich?: Record<string, { expected: number; valid: number }>;
  };
  /**
   * Translated-state experiments only: articles per language whose translation failed or was
   * graded unusable, so they were answered on native text. Their answers carry `variant: 'native'`
   * and are not valid coverage (the translated variant was never evaluated).
   */
  translationFallbacks?: Record<string, number>;
  /**
   * English-card runs only: distinct cards per card language whose attempted English translation
   * failed or was weak (`failed`/`weak`), so questions used the original text. Cards production
   * itself never translates (`english`, `undetermined`, `unconfirmed`, `unsupported`) are faithful
   * to production and not counted. Every pair scored
   * with such a card is not valid coverage, and its card and score rows carry
   * `cardTextFallback: true`.
   */
  cardTextFallbacks?: Record<string, number>;
  cost: {
    estimatedUsd: number;
    billedUsd: number;
    cacheHits: number;
    cacheMisses: number;
    cacheSavingsUsd: number;
    failedCallUsd: number;
    tokens: { input: number; output: number };
    /**
     * The same costs split by the language of each call's article (translations by their source
     * article; calls about no article under `und`). Every total is the sum of its split.
     */
    byLang: Record<string, { estimatedUsd: number; billedUsd: number; cacheSavingsUsd: number }>;
    /**
     * Invocations this cost covers (a `--resume` adds one; D-110). Billed, failed-call, token and
     * cache figures are summed over them; the estimate is the first invocation's whole-run one.
     */
    invocations?: number;
    /** True when an earlier invocation ended without recording its cost (a crash): a lower bound. */
    incomplete?: boolean;
  };
  latencyMs: Record<string, { p50: number; p95: number; n: number }>;
  cacheLookupMs: { p50: number; p95: number; n: number };
  e6?: {
    examplesAdded: Record<string, { yes: number; no: number }>;
    earlierArticleIds: string[];
    laterArticleIds: string[];
  };
  e7?: { items: Array<{ articleId: string; raterId: string; targetedCardId: string }> };
}

export interface RunExperimentResult {
  /** Null when the run was declined before it started. */
  runId: string | null;
  status: RunStatus | 'declined';
  estimate: CostEstimate;
  results: RunResults | null;
}

interface SampleItem {
  snapshot: EvalSnapshot;
  split: DatasetSplit;
  lang: string;
}

interface Pair {
  raterId: string;
  articleId: string;
}

/** Everything one execution needs, derived from a run config and the frozen samples. */
interface Plan {
  def: ExperimentDefinition;
  config: Omit<RunConfig, 'configSha'>;
  cardMode: CardTextMode;
  samples: Map<string, SampleItem>;
  pairs: Pair[];
  cardsByRater: Map<string, RunCard[]>;
  /** Articles that get Call A (card experiments other than E6/E7). */
  enrichArticles: string[];
  /** Raters per article (Call B demand). */
  ratersByArticle: Map<string, string[]>;
  /** Frozen translations a replay reuses; absent entries are produced by the run. */
  frozenTranslations: Map<string, FrozenTranslation | null> | null;
  /** Answers already stored (resume). */
  existing: Map<string, Record<string, unknown>>;
  e6: E6Plan | null;
  e7: E7Item[] | null;
}

/** E6 rerun answers of one rater's cards (`card_id` = the card): `e6.r<raterId>`. */
export const e6AnswerKey = (raterId: string) => `e6.r${raterId}`;

/**
 * A rater's own Call B answer of a shared card id whose copy was asked with different text than the
 * first rater's (`card_id` = the card): `card.r<raterId>`; the report prefers it over `card`.
 */
export const raterCardAnswerKey = (raterId: string) => `card.r${raterId}`;

const answerKey = (articleId: string, cardId: string | null, key: string) =>
  `${articleId}|${cardId ?? ''}|${key}`;

const silentLogger = (rt: EvalRuntime): EngineLogger => ({
  info: (obj, msg) => rt.logger.info(obj, msg),
  warn: (obj, msg) => rt.logger.warn(obj, msg),
  error: (obj, msg) => rt.logger.error(obj, msg),
});

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

async function resolveDataset(rt: EvalRuntime, version: string | undefined): Promise<DatasetRow> {
  const dataset =
    version === undefined ? await headDataset(rt.db) : await getDataset(rt.db, version);
  if (dataset === null) {
    throw new EvalCommandError(
      version === undefined
        ? 'no golden dataset exists yet; run `eval sample` first'
        : `dataset version ${version} does not exist`,
    );
  }
  return dataset;
}

function engineOf(rt: EvalRuntime, def: ExperimentDefinition): RunEngine | null {
  if (def.engine !== 'typesafe') return null;
  return {
    provider: 'typesafe',
    model: rt.config.typesafeModel,
    requiredEngine: 'typesafe',
    pricePerMTokUsd: rt.config.typesafePricePerMtokUsd,
    maxOutputTokens: null,
  };
}

function runtimeInfo(): Record<string, JsonValue> {
  return {
    node: process.version,
    platform: process.platform,
    evalCache: EVAL_CACHE_VERSION,
    adapters: { ...ENGINE_ADAPTER_VERSIONS },
    translationPolicy: TRANSLATION_POLICY_VERSION,
    ollamaPriceTable: OLLAMA_PRICE_TABLE_VERSION,
  };
}

const uniqSorted = (ids: Iterable<string>) => [...new Set(ids)].sort(compareIds);

/** The stored `ranker.thresholds` partial (the deployed lane policy; `{}` when unset). */
export async function deployedRankerThresholds(db: Executor): Promise<Record<string, unknown>> {
  const stored = await readStoredSetting(db, 'ranker.thresholds');
  return parseSetting('ranker.thresholds', stored ?? {}) as Record<string, unknown>;
}

/**
 * The effective ranker config of a run: the `ranker.thresholds` it froze when it started over the
 * defaults, else (a run written before thresholds were recorded) the stored setting now. E6's
 * example suggestions and the replay baseline both use it (D-114 addendum).
 */
export async function runRankerConfig(
  db: Executor,
  config: Pick<RunConfig, 'rankerThresholds'>,
): Promise<{ ranker: RankerConfig; source: 'base_run' | 'settings' }> {
  return config.rankerThresholds !== undefined
    ? { ranker: mergeRankerConfig(config.rankerThresholds), source: 'base_run' }
    : { ranker: mergeRankerConfig(await deployedRankerThresholds(db)), source: 'settings' };
}

/** The draft config of a new run, read from the rater tables (or from the base run for E6/E7). */
async function draftConfig(
  rt: EvalRuntime,
  db: Executor,
  def: ExperimentDefinition,
  options: RunExperimentOptions,
  dataset: DatasetRow,
  cardMode: CardTextMode,
  maxUsd: number,
): Promise<Omit<RunConfig, 'configSha'>> {
  const sample = await loadSample(db, dataset.version);
  const sampleById = new Map(sample.map((row) => [row.articleId, row]));
  const allLangs = uniqSorted(sample.map((row) => row.lang)).sort();
  const common = {
    experiment: def.id,
    variant: {
      state: def.variant.state,
      cards: cardMode,
    } as RunConfig['variant'],
    datasetVersion: dataset.version,
    snapshotSha: dataset.snapshotSha,
    splitSha: dataset.splitSha,
    seed: options.seed ?? dataset.seed,
    engine: engineOf(rt, def),
    questionSets:
      def.engine === null
        ? null
        : {
            enrich: { version: ENRICH_V1.version, sha: ENRICH_V1.sha256 },
            match: { version: MATCH_V1.version, sha: MATCH_V1.sha256 },
          },
    translation: {
      articles: def.translation.articles,
      cards: def.translation.cards,
      ...(def.translation.articles === 'ollama' ? { model: rt.config.ollamaModelFast } : {}),
    },
    developmentOnly: def.developmentOnly,
    maxUsd,
    rankerThresholds: await deployedRankerThresholds(db),
    runtime: runtimeInfo(),
  };

  if (def.baseExperiment !== null) {
    const baseRunId =
      options.baseRunId ??
      (await latestFinishedRunId(db, {
        datasetVersion: dataset.version,
        experiment: def.baseExperiment,
        statuses: ['complete', 'partial'],
      }));
    if (baseRunId === null) {
      throw new EvalCommandError(
        `${def.id} builds on a finished ${def.baseExperiment} run of ${dataset.version}; run ${def.baseExperiment} first`,
      );
    }
    const baseRun = await getRun(db, baseRunId);
    if (baseRun === null || baseRun.datasetVersion !== dataset.version) {
      throw new EvalCommandError(`base run ${baseRunId} is not a run of ${dataset.version}`);
    }
    const base = parseRunConfig(baseRun.config);
    if (base.experiment !== def.baseExperiment) {
      throw new EvalCommandError(`base run ${baseRunId} is not an ${def.baseExperiment} run`);
    }
    // The plan reads the base run's answers more than once (estimate, run, resume): only a finished
    // base keeps them fixed, as the default lookup above requires.
    const baseStatus = (baseRun.results as { status?: unknown } | null)?.status;
    if (baseStatus !== 'complete' && baseStatus !== 'partial') {
      throw new EvalCommandError(
        `base run ${baseRunId} is not finished (${String(baseStatus ?? 'running')}); ${def.id} builds on a complete or partial ${def.baseExperiment} run`,
      );
    }
    const langs = base.langs.filter((lang) => options.langs?.includes(lang) ?? true);
    // `--raters` narrows the base run's raters (D-110 addendum); every id must be one of them.
    const wantedBase = options.raterIds === undefined ? null : new Set(options.raterIds);
    const raters = base.raters.filter((r) => wantedBase === null || wantedBase.has(r.raterId));
    if (wantedBase !== null && raters.length !== wantedBase.size) {
      throw new EvalCommandError('unknown rater id in --raters');
    }
    const ofRater = new Set(raters.map((r) => r.raterId));
    const isDev = (articleId: string) => {
      const row = sampleById.get(articleId);
      return row !== undefined && row.split === 'dev' && langs.includes(row.lang);
    };
    const ratings = base.ratings.filter((r) => ofRater.has(r.raterId) && isDev(r.articleId));
    const assignments = Object.fromEntries(
      Object.entries(base.assignments)
        .filter(([raterId]) => ofRater.has(raterId))
        .map(([raterId, ids]) => [raterId, ids.filter(isDev)]),
    );
    const articleIds = uniqSorted(ratings.map((r) => r.articleId));
    return {
      ...common,
      langs,
      raters,
      cohort: { articleIds, sha: canonicalSha256(articleIds) },
      assignments,
      ratings,
      cards: base.cards.filter((c) => ofRater.has(c.raterId)),
      facetLabels: [],
      baseRunId,
    };
  }

  const langs = [...(options.langs ?? def.defaultLangs ?? allLangs)].sort();
  const inScope = (articleId: string) => {
    const row = sampleById.get(articleId);
    return (
      row !== undefined && langs.includes(row.lang) && (!def.developmentOnly || row.split === 'dev')
    );
  };
  // A frozen version's ground truth is the snapshot taken when it froze (D-110 addendum): the live
  // rows may hold later raters, corrections or assignments that belong to a child version. Only
  // the estimate of a legacy version frozen before that snapshot existed reads the live tables;
  // the freeze transaction captures it before the config is read again.
  const truth = dataset.frozenAt === null ? null : await loadDatasetTruth(db, dataset.version);
  const wanted = options.raterIds === undefined ? null : new Set(options.raterIds);
  const raters =
    truth === null
      ? await loadEvalRaters(db, options.raterIds)
      : truth.raters.filter((r) => wanted === null || wanted.has(r.raterId));
  if (wanted !== null && raters.length !== wanted.size) {
    throw new EvalCommandError('unknown rater id in --raters');
  }
  const raterIds = raters.map((r) => r.raterId);
  const [cards, assignments, ratings, labels] =
    truth === null
      ? await Promise.all([
          loadEvalRaterCards(db, raterIds),
          loadEvalAssignments(db, dataset.version, raterIds),
          loadEvalRatings(db, dataset.version, raterIds),
          loadEvalFacetLabels(db, dataset.version),
        ])
      : (() => {
          const ofRater = new Set(raterIds);
          return [
            truth.cards.filter((c) => ofRater.has(c.raterId)),
            truth.assignments.filter((a) => ofRater.has(a.raterId)),
            truth.ratings.filter((r) => ofRater.has(r.raterId)),
            truth.facetLabels,
          ] as const;
        })();
  const scopedRatings = ratings.filter((r) => inScope(r.articleId));
  // Every experiment of a language scope shares one cohort (rated pairs plus facet-labelled
  // articles), so the gate compares runs on identical ground truth (D-110); only card
  // experiments ask Call A about the labelled articles.
  const facetLabels = labels.filter((label) => inScope(label.articleId));
  const articleIds = uniqSorted([
    ...scopedRatings.map((r) => r.articleId),
    ...facetLabels.map((l) => l.articleId),
  ]);
  return {
    ...common,
    langs,
    raters: raters.map(runRaterOf),
    cohort: { articleIds, sha: canonicalSha256(articleIds) },
    assignments: Object.fromEntries(
      Object.entries(assignmentsByRater(assignments)).map(([raterId, ids]) => [
        raterId,
        ids.filter(inScope),
      ]),
    ),
    ratings: scopedRatings.map(runRatingOf),
    cards: cards.map(runCardOf),
    facetLabels: facetLabels.map(runFacetLabelOf),
  };
}

/** Resolve a stored run config's inputs into an execution plan. */
async function buildPlan(
  rt: EvalRuntime,
  def: ExperimentDefinition,
  config: Omit<RunConfig, 'configSha'>,
  options: {
    frozenTranslations: Map<string, FrozenTranslation | null> | null;
    existing: Plan['existing'];
  },
): Promise<Plan> {
  const corpusIds = Object.values(config.assignments).flat();
  const wanted = uniqSorted([...config.cohort.articleIds, ...corpusIds]);
  const rows = await loadSample(rt.db, config.datasetVersion, { articleIds: wanted });
  const samples = new Map<string, SampleItem>(
    rows.map((row) => [
      row.articleId,
      { snapshot: asSnapshot(row.snapshot), split: row.split, lang: row.lang },
    ]),
  );
  const raterSet = new Set(config.raters.map((r) => r.raterId));
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const rating of config.ratings) {
    const key = `${rating.raterId}|${rating.articleId}`;
    if (seen.has(key) || !raterSet.has(rating.raterId) || !samples.has(rating.articleId)) continue;
    seen.add(key);
    pairs.push({ raterId: rating.raterId, articleId: rating.articleId });
  }
  pairs.sort((a, b) => compareIds(a.articleId, b.articleId) || compareIds(a.raterId, b.raterId));
  const cardsByRater = new Map<string, RunCard[]>();
  for (const card of config.cards) {
    const list = cardsByRater.get(card.raterId) ?? [];
    list.push(card);
    cardsByRater.set(card.raterId, list);
  }
  const ratersByArticle = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = ratersByArticle.get(pair.articleId) ?? [];
    list.push(pair.raterId);
    ratersByArticle.set(pair.articleId, list);
  }
  const cardMode = config.variant.cards;
  const plan: Plan = {
    def,
    config,
    cardMode,
    samples,
    pairs,
    cardsByRater,
    enrichArticles:
      def.score === 'cards' && def.baseExperiment === null
        ? config.cohort.articleIds.filter((id) => samples.has(id))
        : [],
    ratersByArticle,
    frozenTranslations: options.frozenTranslations,
    existing: options.existing,
    e6: null,
    e7: null,
  };

  if (def.baseExperiment !== null && config.baseRunId !== undefined) {
    // E1's shared `card` answers plus each rater's own copy of a shared card id (`card.r<raterId>`,
    // D-112 addendum): a rater's E6 suggestions and E7 target read the rater's own answer first.
    const baseAnswers = await loadRunAnswers(rt.db, config.baseRunId, { keyPrefix: 'card' });
    const answers = new Map<string, Map<string, { p: number; engine: string }>>();
    const own = new Map<string, Map<string, { p: number; engine: string } | null>>();
    for (const row of baseAnswers) {
      if (row.cardId === null) continue;
      const value = row.answer as { ok?: unknown; p?: unknown; engine?: unknown };
      const answer =
        value.ok === true && typeof value.p === 'number'
          ? { p: value.p, engine: String(value.engine) }
          : null;
      if (row.questionKey === 'card') {
        if (answer === null) continue;
        const map = answers.get(row.articleId) ?? new Map<string, { p: number; engine: string }>();
        map.set(row.cardId, answer);
        answers.set(row.articleId, map);
      } else if (row.questionKey.startsWith('card.r')) {
        const key = `${row.questionKey.slice('card.r'.length)}|${row.articleId}`;
        const map = own.get(key) ?? new Map<string, { p: number; engine: string } | null>();
        map.set(row.cardId, answer);
        own.set(key, map);
      }
    }
    const answersOf = (raterId: string, articleId: string) => {
      const shared = answers.get(articleId);
      const overrides = own.get(`${raterId}|${articleId}`);
      if (overrides === undefined) return shared;
      const merged = new Map(shared);
      for (const [cardId, answer] of overrides) {
        // A failed own copy never borrows another rater's answer.
        if (answer === null) merged.delete(cardId);
        else merged.set(cardId, answer);
      }
      return merged;
    };
    if (def.id === 'E6') {
      const articles = new Map(
        [...samples].map(([id, item]) => [
          id,
          { storyGroupId: item.snapshot.storyGroupId, title: item.snapshot.input.title },
        ]),
      );
      plan.e6 = planE6({
        cards: config.cards,
        ratings: config.ratings,
        articles,
        answers,
        answersOf,
        config: (await runRankerConfig(rt.db, config)).ranker,
      });
    } else if (def.id === 'E7') {
      plan.e7 = planE7({
        seed: config.seed,
        candidates: [...ratersByArticle].flatMap(([articleId, raterIds]) => {
          const item = samples.get(articleId);
          return item === undefined ? [] : [{ articleId, lang: item.lang, raterIds }];
        }),
        cardsByRater,
        answers: new Map(
          [...answers].map(([articleId, map]) => [
            articleId,
            new Map([...map].map(([cardId, a]) => [cardId, a.p])),
          ]),
        ),
        answersOf: (raterId, articleId) => {
          const map = answersOf(raterId, articleId);
          return map === undefined
            ? undefined
            : new Map([...map].map(([cardId, a]) => [cardId, a.p]));
        },
      });
    }
  }
  return plan;
}

// ── Execution ───────────────────────────────────────────────────────────────────────────────────

interface Execution {
  /** Card answers per article (the shared Call B), or per rater for E6. */
  answers: Map<string, Map<string, CardAnswer>>;
  raterAnswers: Map<string, Map<string, Map<string, CardAnswer>>>;
  /**
   * `raterId|articleId` → that rater's card answers, only for a rater whose copy of a shared card
   * id was asked with different text (`card.r<raterId>` rows); everyone else reads `answers`.
   */
  raterCardAnswers: Map<string, Map<string, CardAnswer>>;
  translations: Map<string, FrozenTranslation | null>;
  enrichValid: Map<string, boolean>;
  e7Valid: Map<string, boolean>;
}

type Sink = (rows: RunAnswerInput[]) => Promise<void>;

function cardAnswerOf(result: CardResult): CardAnswer | null {
  if (!result.ok) return null;
  const engine = result.engine === 'llm' || result.engine === 'laya' ? result.engine : 'typesafe';
  return { p: result.p, engine };
}

function cardRow(
  articleId: string,
  cardId: string,
  key: string,
  result: CardResult,
  variant?: StateVariant,
  cardTextFallback = false,
): RunAnswerInput {
  const tag = {
    ...(variant === undefined ? {} : { variant }),
    ...(cardTextFallback ? { cardTextFallback: true } : {}),
  };
  return {
    articleId,
    cardId,
    questionKey: key,
    answer: result.ok
      ? {
          ok: true,
          p: result.p,
          engine: result.engine,
          model: result.model,
          cached: result.cached,
          ...tag,
        }
      : { ok: false, reason: result.reason, ...tag },
  };
}

const CARD_TEXT_FALLBACK_STATUSES: ReadonlySet<string> = new Set(['failed', 'weak']);

/**
 * Whether an English-card run asked this card with its original text because its attempted
 * translation failed or was weak (spec 07 §5): the English-card variant was never evaluated for it.
 * A card production would not translate either (detected English, undetermined, unconfirmed or an
 * unsupported language) is asked exactly as production asks it, so it is not a fallback.
 */
export function cardTextFallback(card: RunCard, mode: CardTextMode): boolean {
  return mode === 'english' && CARD_TEXT_FALLBACK_STATUSES.has(card.textStatus ?? '');
}

/**
 * Whether a translated-state run answered this article on native text instead (its translation
 * failed or was graded unusable): a degraded observation that never counts as valid coverage.
 */
function translationFallback(plan: Plan, item: SampleItem, out: Execution): boolean {
  if (plan.config.translation.articles === null || item.lang === 'en' || item.lang === 'und') {
    return false;
  }
  const id = item.snapshot.articleId;
  if (!out.translations.has(id)) return false;
  return modelInputOf(item.snapshot, out.translations.get(id) ?? null).variant === 'native';
}

/** A stored answer is reused on resume only when it was made on the same article variant. */
function sameVariant(stored: Record<string, unknown> | undefined, variant: StateVariant): boolean {
  const recorded = stored?.['variant'];
  return recorded === undefined || recorded === variant;
}

function existingTranslation(value: Record<string, unknown> | undefined): FrozenTranslation | null {
  if (value?.['ok'] !== true) return null;
  const texts = value['texts'] as FrozenTranslation['texts'] | undefined;
  if (texts === undefined) return null;
  return {
    engine: value['engine'] === 'ollama' ? 'ollama' : 'libretranslate',
    model: typeof value['model'] === 'string' ? value['model'] : null,
    quality: (value['quality'] as FrozenTranslation['quality']) ?? 'fail',
    texts,
  };
}

async function articleTranslation(
  env: CallEnv,
  plan: Plan,
  item: SampleItem,
  rows: RunAnswerInput[],
): Promise<FrozenTranslation | null> {
  const provider = plan.config.translation.articles;
  if (provider === null || item.lang === 'en' || item.lang === 'und') return null;
  const articleId = item.snapshot.articleId;
  if (plan.frozenTranslations !== null) return plan.frozenTranslations.get(articleId) ?? null;
  const stored = existingTranslation(plan.existing.get(answerKey(articleId, null, 'translation')));
  if (stored !== null) return stored;
  const result = await translateArticle(env, { snapshot: item.snapshot, provider });
  if (env.estimating) return result.ok ? result.translation : null;
  if (!result.ok) {
    rows.push({
      articleId,
      cardId: null,
      questionKey: 'translation',
      answer: { ok: false, reason: result.reason },
    });
    return null;
  }
  if (result.translation === null) return null;
  rows.push({
    articleId,
    cardId: null,
    questionKey: 'translation',
    answer: {
      ok: true,
      engine: result.translation.engine,
      model: result.translation.model,
      quality: result.translation.quality,
      texts: result.translation.texts,
      cached: result.cached,
    },
  });
  return result.translation;
}

/** Stored complete Call A answers of an article (resume), or null. */
function existingEnrich(
  plan: Plan,
  articleId: string,
  variant: StateVariant,
): Record<string, unknown>[] | null {
  const keys = Object.keys(ENRICH_V1.questions);
  const values = keys.map((key) => plan.existing.get(answerKey(articleId, null, `enrich.${key}`)));
  return values.every((value) => value?.['ok'] === true && sameVariant(value, variant))
    ? (values as Record<string, unknown>[])
    : null;
}

async function processCardArticle(
  env: CallEnv,
  plan: Plan,
  articleId: string,
  out: Execution,
  sink: Sink | null,
): Promise<void> {
  const item = plan.samples.get(articleId);
  if (item === undefined) return;
  const rows: RunAnswerInput[] = [];
  const translation = await articleTranslation(env, plan, item, rows);
  out.translations.set(articleId, translation);
  const input = modelInputOf(item.snapshot, translation);
  const revision = item.snapshot.contentRevision;

  // Call A, once per article and variant.
  if (existingEnrich(plan, articleId, input.variant) !== null) {
    out.enrichValid.set(articleId, true);
  } else {
    const state = buildState(input, 'enrich');
    const result = await askEnrich(env, { articleId, revision, state });
    out.enrichValid.set(articleId, result.ok);
    for (const key of Object.keys(ENRICH_V1.questions)) {
      const answer: Answer | undefined = result.ok ? result.answers[key] : undefined;
      rows.push({
        articleId,
        cardId: null,
        questionKey: `enrich.${key}`,
        answer:
          result.ok && answer !== undefined
            ? {
                ok: true,
                answer: jsonAnswer(answer),
                engine: result.engine,
                model: result.model,
                cached: result.cached,
                variant: state.variant,
                stateSha256: state.sha256,
              }
            : {
                ok: false,
                reason: result.ok ? 'error:unanswered' : result.reason,
                variant: state.variant,
              },
      });
    }
  }

  // Call B with the cards of every rater who rated the article, in one shared request set. Raters
  // can share a card id (reused by text hash, D-100) while English-card mode froze a different
  // translation for each copy (the locale hint differs), so the set is deduplicated on what is
  // actually sent (the built question and the text status), never on the card id alone (D-112
  // addendum). The first rater (by id) of a card id keeps the shared `card` key; a rater whose copy
  // differs gets its own `card.r<raterId>` row.
  const raterIds = [...(plan.ratersByArticle.get(articleId) ?? [])].sort(compareIds);
  if (raterIds.length > 0) {
    interface Variant {
      card: RunCard;
      built: BuiltCard;
      canonical: boolean;
      raters: string[];
    }
    const variants = new Map<string, Variant>();
    const owners = new Set<string>();
    for (const raterId of raterIds) {
      for (const card of plan.cardsByRater.get(raterId) ?? []) {
        const built = buildCardQuestion(card, plan.cardMode);
        const id = `${card.cardId}|${built.sha256}|${card.textStatus ?? ''}`;
        let variant = variants.get(id);
        if (variant === undefined) {
          variant = { card, built, canonical: !owners.has(card.cardId), raters: [] };
          owners.add(card.cardId);
          variants.set(id, variant);
        }
        variant.raters.push(raterId);
      }
    }
    const keysOf = (variant: Variant) =>
      variant.canonical ? ['card'] : variant.raters.map(raterCardAnswerKey);
    const answers = new Map<string, CardAnswer>();
    const divergent = new Map<string, Map<string, CardAnswer | null>>();
    const settle = (variant: Variant, answer: CardAnswer | null) => {
      if (variant.canonical) {
        if (answer !== null) answers.set(variant.card.cardId, answer);
        return;
      }
      for (const raterId of variant.raters) {
        const map = divergent.get(raterId) ?? new Map<string, CardAnswer | null>();
        map.set(variant.card.cardId, answer);
        divergent.set(raterId, map);
      }
    };
    // Rounds of distinct card ids: a pack keys its questions by card id (spec 05 §5.2).
    const rounds: Variant[][] = [];
    const ordered = [...variants.values()].sort(
      (a, b) =>
        compareIds(a.card.cardId, b.card.cardId) ||
        Number(b.canonical) - Number(a.canonical) ||
        compareIds(a.raters[0] ?? '', b.raters[0] ?? ''),
    );
    for (const variant of ordered) {
      const stored = keysOf(variant).map((key) =>
        plan.existing.get(answerKey(articleId, variant.card.cardId, key)),
      );
      const first = stored[0];
      const reusable = stored.every(
        (value) =>
          value?.['ok'] === true &&
          typeof value['p'] === 'number' &&
          sameVariant(value, input.variant),
      );
      if (reusable && first !== undefined) {
        settle(variant, {
          p: first['p'] as number,
          engine: first['engine'] === 'llm' ? 'llm' : 'typesafe',
        });
        continue;
      }
      const round = rounds.find((r) => r.every((v) => v.card.cardId !== variant.card.cardId));
      if (round === undefined) rounds.push([variant]);
      else round.push(variant);
    }
    if (rounds.length > 0) {
      const state = buildState(input, 'match');
      for (const round of rounds) {
        const results = await askCards(env, {
          articleId,
          revision,
          state,
          cards: round.map((variant) => ({
            cardId: variant.card.cardId,
            built: variant.built,
            owner: variant.card.visibility === 'private' ? variant.card.ownerUserId : null,
          })),
        });
        for (const variant of round) {
          const cardId = variant.card.cardId;
          const result = results.get(cardId);
          if (result === undefined) continue;
          const fallback = cardTextFallback(variant.card, plan.cardMode);
          for (const key of keysOf(variant)) {
            rows.push(cardRow(articleId, cardId, key, result, state.variant, fallback));
          }
          settle(variant, cardAnswerOf(result));
        }
      }
    }
    out.answers.set(articleId, answers);
    for (const [raterId, overrides] of divergent) {
      const own = new Map(answers);
      for (const [cardId, answer] of overrides) {
        if (answer === null) own.delete(cardId);
        else own.set(cardId, answer);
      }
      out.raterCardAnswers.set(`${raterId}|${articleId}`, own);
    }
  }
  if (sink !== null && rows.length > 0) await sink(rows);
}

/**
 * A successful stored answer of a resumed run (`plan.existing`), or null when it is missing or
 * failed. E6/E7 reuse them like the shared Call B path, so a resume (even with a cleared cache or on
 * another host) asks and bills only the missing or failed tasks (D-114 addendum).
 */
function storedCardAnswer(
  plan: Plan,
  articleId: string,
  cardId: string,
  key: string,
): CardAnswer | null {
  const stored = plan.existing.get(answerKey(articleId, cardId, key));
  if (stored?.['ok'] !== true || typeof stored['p'] !== 'number') return null;
  return { p: stored['p'], engine: stored['engine'] === 'llm' ? 'llm' : 'typesafe' };
}

async function processE6(env: CallEnv, plan: Plan, out: Execution, sink: Sink | null) {
  const e6 = plan.e6;
  if (e6 === null) return;
  const work = [...e6.laterByRater].flatMap(([raterId, ids]) =>
    ids.map((articleId) => ({ raterId, articleId })),
  );
  await mapPool(work, 4, async ({ raterId, articleId }) => {
    const item = plan.samples.get(articleId);
    if (item === undefined) return;
    const cards = e6.cardsByRater.get(raterId) ?? [];
    const key = e6AnswerKey(raterId);
    const answers = new Map<string, CardAnswer>();
    const asks: CardAsk[] = [];
    for (const card of cards) {
      const stored = storedCardAnswer(plan, articleId, card.cardId, key);
      if (stored !== null) {
        answers.set(card.cardId, stored);
        continue;
      }
      asks.push({
        cardId: card.cardId,
        built: buildCardQuestion(card, plan.cardMode),
        owner: null,
      });
    }
    const results =
      asks.length === 0
        ? new Map<string, CardResult>()
        : await askCards(env, {
            articleId,
            revision: item.snapshot.contentRevision,
            state: buildState(modelInputOf(item.snapshot, null), 'match'),
            cards: asks,
          });
    const rows: RunAnswerInput[] = [];
    for (const [cardId, result] of results) {
      // Keyed per rater: raters can share a card id (reused by text hash, D-100) while E6 gives
      // each rater's copy different examples, so a shared `card` key would overwrite (D-114).
      const card = cards.find((c) => c.cardId === cardId);
      const fallback = card !== undefined && cardTextFallback(card, plan.cardMode);
      rows.push(cardRow(articleId, cardId, key, result, undefined, fallback));
      const answer = cardAnswerOf(result);
      if (answer !== null) answers.set(cardId, answer);
    }
    const byArticle = out.raterAnswers.get(raterId) ?? new Map<string, Map<string, CardAnswer>>();
    byArticle.set(articleId, answers);
    out.raterAnswers.set(raterId, byArticle);
    if (sink !== null && rows.length > 0) await sink(rows);
  });
}

async function processE7(env: CallEnv, plan: Plan, out: Execution, sink: Sink | null) {
  const items = plan.e7 ?? [];
  await mapPool(items, 4, async (e7) => {
    const item = plan.samples.get(e7.articleId);
    if (item === undefined) return;
    const base = modelInputOf(item.snapshot, null);
    const cards = plan.cardsByRater.get(e7.raterId) ?? [];
    const rows: RunAnswerInput[] = [];
    let valid = true;
    for (const [variant, sentence] of [
      ['targeted', e7TargetedSentence(e7.targetedInterest)],
      ['generic', E7_GENERIC_SENTENCE],
    ] as const) {
      const key = `e7.${variant}`;
      const asks: CardAsk[] = cards
        .filter((card) => storedCardAnswer(plan, e7.articleId, card.cardId, key) === null)
        .map((card) => ({
          cardId: card.cardId,
          built: buildCardQuestion(card, plan.cardMode),
          owner: null,
        }));
      if (asks.length === 0) continue;
      const results = await askCards(env, {
        articleId: e7.articleId,
        revision: item.snapshot.contentRevision,
        state: buildState(steeredInput(base, sentence), 'match'),
        cards: asks,
      });
      for (const [cardId, result] of results) {
        rows.push(cardRow(e7.articleId, cardId, key, result));
        valid &&= result.ok;
      }
    }
    out.e7Valid.set(`${e7.raterId}|${e7.articleId}`, valid && cards.length > 0);
    if (sink !== null && rows.length > 0) await sink(rows);
  });
}

async function execute(
  env: CallEnv,
  plan: Plan,
  sink: Sink | null,
  progress: ((done: number, total: number) => Promise<void>) | null,
  concurrency: number,
): Promise<Execution> {
  const out: Execution = {
    answers: new Map(),
    raterAnswers: new Map(),
    raterCardAnswers: new Map(),
    translations: new Map(),
    enrichValid: new Map(),
    e7Valid: new Map(),
  };
  const { def } = plan;
  if (def.id === 'E6') {
    await processE6(env, plan, out, sink);
    return out;
  }
  if (def.id === 'E7') {
    await processE7(env, plan, out, sink);
    return out;
  }
  if (def.score === 'bm25' && plan.config.translation.articles !== null) {
    // B1-T: frozen tier-1 English text of every article BM25 reads (pairs and corpora).
    const ids = uniqSorted([
      ...plan.pairs.map((p) => p.articleId),
      ...Object.values(plan.config.assignments).flat(),
    ]).filter((id) => plan.samples.has(id));
    await mapPool(ids, concurrency, async (articleId) => {
      const item = plan.samples.get(articleId);
      if (item === undefined) return;
      const rows: RunAnswerInput[] = [];
      out.translations.set(articleId, await articleTranslation(env, plan, item, rows));
      if (sink !== null && rows.length > 0) await sink(rows);
    });
    return out;
  }
  if (def.score !== 'cards') return out;
  let done = 0;
  await mapPool(plan.enrichArticles, concurrency, async (articleId) => {
    await processCardArticle(env, plan, articleId, out, sink);
    done += 1;
    if (progress !== null && done % 25 === 0) await progress(done, plan.enrichArticles.length);
  });
  return out;
}

// ── Scores, coverage, results ───────────────────────────────────────────────────────────────────

function scoreRows(
  plan: Plan,
  out: Execution,
): {
  rows: RunAnswerInput[];
  coverage: RunResults['coverage'];
  translationFallbacks: Record<string, number> | null;
  cardTextFallbacks: Record<string, number> | null;
} {
  const byLang: Record<string, { expected: number; valid: number }> = {};
  const byRater: Record<string, { expected: number; valid: number }> = {};
  const count = (lang: string, raterId: string, valid: boolean) => {
    const l = (byLang[lang] ??= { expected: 0, valid: 0 });
    const r = (byRater[raterId] ??= { expected: 0, valid: 0 });
    l.expected += 1;
    r.expected += 1;
    if (valid) {
      l.valid += 1;
      r.valid += 1;
    }
  };
  const rows: RunAnswerInput[] = [];
  const { def } = plan;

  if (def.id === 'E7') {
    for (const item of plan.e7 ?? []) {
      count(item.lang, item.raterId, out.e7Valid.get(`${item.raterId}|${item.articleId}`) === true);
    }
    return {
      rows,
      coverage: { byLang, byRater },
      translationFallbacks: null,
      cardTextFallbacks: null,
    };
  }

  const fallback = new Set<string>();
  let translationFallbacks: Record<string, number> | null = null;
  if (plan.config.translation.articles !== null) {
    translationFallbacks = {};
    for (const articleId of [...out.translations.keys()].sort(compareIds)) {
      const item = plan.samples.get(articleId);
      if (item === undefined || item.lang === 'en' || item.lang === 'und') continue;
      const degraded = translationFallback(plan, item, out);
      translationFallbacks[item.lang] = (translationFallbacks[item.lang] ?? 0) + (degraded ? 1 : 0);
      if (degraded) fallback.add(articleId);
    }
  }

  let cardTextFallbacks: Record<string, number> | null = null;
  if (plan.cardMode === 'english') {
    cardTextFallbacks = {};
    // One count per distinct card copy: raters sharing a card id may hold different translations.
    const seenCards = new Set<string>();
    for (const card of plan.config.cards) {
      const copy = `${card.cardId}|${card.textStatus ?? ''}|${card.lang ?? ''}`;
      if (seenCards.has(copy) || card.textStatus === 'english') continue;
      seenCards.add(copy);
      const lang = card.lang ?? 'und';
      if (lang === 'en') continue;
      cardTextFallbacks[lang] =
        (cardTextFallbacks[lang] ?? 0) + (cardTextFallback(card, plan.cardMode) ? 1 : 0);
    }
  }

  const pairs =
    def.id === 'E6'
      ? [...(plan.e6?.laterByRater ?? new Map<string, string[]>())].flatMap(([raterId, ids]) =>
          ids.map((articleId) => ({ raterId, articleId })),
        )
      : plan.pairs;
  const english = plan.cardMode === 'english';
  const pairsByRater = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = pairsByRater.get(pair.raterId) ?? [];
    list.push(pair.articleId);
    pairsByRater.set(pair.raterId, list);
  }
  const snapshots = new Map([...plan.samples].map(([id, item]) => [id, item.snapshot]));

  for (const [raterId, articleIds] of pairsByRater) {
    const raterCards =
      def.id === 'E6'
        ? (plan.e6?.cardsByRater.get(raterId) ?? [])
        : (plan.cardsByRater.get(raterId) ?? []);
    const cards = raterCards.map((card) => rankCardOf(card, english));
    // A score that used an untranslated card never evaluated the English-card variant.
    const cardFallback = raterCards.some((card) => cardTextFallback(card, plan.cardMode));
    let chrono: Map<string, number> | null = null;
    let corpus: ReturnType<typeof bm25Corpus> | null = null;
    // In a translated-state run, a corpus document left on native text (its translation failed or
    // is missing) changes the corpus statistics behind every score of this rater, rated or not.
    let corpusFallback = false;
    if (def.score === 'chrono') chrono = chronoScores(articleIds, snapshots);
    if (def.score === 'bm25') {
      const corpusIds = uniqSorted([...(plan.config.assignments[raterId] ?? []), ...articleIds]);
      corpusFallback =
        plan.config.translation.articles !== null &&
        corpusIds.some((id) => {
          const item = plan.samples.get(id);
          if (item === undefined || item.lang === 'en' || item.lang === 'und') return false;
          return !out.translations.has(id) || translationFallback(plan, item, out);
        });
      corpus = bm25Corpus(
        corpusIds.flatMap((id) => {
          const item = plan.samples.get(id);
          return item === undefined
            ? []
            : [bm25Text(item.snapshot, out.translations.get(id) ?? null)];
        }),
      );
    }
    for (const articleId of articleIds) {
      const item = plan.samples.get(articleId);
      if (item === undefined) continue;
      let row: ScoreRow;
      let valid: boolean;
      if (chrono !== null) {
        row = { score: chrono.get(articleId) ?? null, source: 'chrono' };
        valid = row.score !== null;
      } else if (corpus !== null) {
        row = bm25ScoreRow(
          cards,
          bm25Text(item.snapshot, out.translations.get(articleId) ?? null),
          corpus,
        );
        valid = row.score !== null;
      } else {
        const answers =
          def.id === 'E6'
            ? (out.raterAnswers.get(raterId)?.get(articleId) ?? new Map<string, CardAnswer>())
            : (out.raterCardAnswers.get(`${raterId}|${articleId}`) ??
              out.answers.get(articleId) ??
              new Map<string, CardAnswer>());
        const record = Object.fromEntries(answers);
        row = cardsScoreRow(cards, record);
        valid = cardsComplete(cards, record);
      }
      const degraded = fallback.has(articleId);
      count(item.lang, raterId, valid && !degraded && !cardFallback && !corpusFallback);
      rows.push({
        articleId,
        cardId: null,
        questionKey: `score.r${raterId}`,
        answer: {
          ...row,
          ...(plan.config.translation.articles === null || item.lang === 'en'
            ? {}
            : { variant: degraded ? 'native' : 'translated' }),
          ...(cardFallback ? { cardTextFallback: true } : {}),
          ...(corpusFallback ? { corpusFallback: true } : {}),
        },
      });
    }
  }
  // Raters without a single scored pair still appear, with nothing expected.
  for (const rater of plan.config.raters) byRater[rater.raterId] ??= { expected: 0, valid: 0 };

  const coverage: RunResults['coverage'] = { byLang, byRater };
  if (plan.enrichArticles.length > 0) {
    const enrich: Record<string, { expected: number; valid: number }> = {};
    for (const articleId of plan.enrichArticles) {
      const lang = plan.samples.get(articleId)?.lang ?? 'und';
      const cell = (enrich[lang] ??= { expected: 0, valid: 0 });
      cell.expected += 1;
      if (out.enrichValid.get(articleId) === true && !fallback.has(articleId)) cell.valid += 1;
    }
    coverage.enrich = enrich;
  }
  return { rows, coverage, translationFallbacks, cardTextFallbacks };
}

/** The per-language cost split of a run (`results.cost.byLang`, consumed by the G1 budget). */
export function costByLang(
  estimated: Readonly<Record<string, LangCost>>,
  live: Readonly<Record<string, LangCost>>,
  billed: readonly ArticleCallSpend[],
  articleLang: ReadonlyMap<string, string>,
): RunResults['cost']['byLang'] {
  const out: RunResults['cost']['byLang'] = {};
  const cell = (lang: string) =>
    (out[lang] ??= { estimatedUsd: 0, billedUsd: 0, cacheSavingsUsd: 0 });
  for (const [lang, c] of Object.entries(estimated)) cell(lang).estimatedUsd += c.estimateUsd;
  for (const [lang, c] of Object.entries(live)) cell(lang).cacheSavingsUsd += c.cacheSavingsUsd;
  for (const row of billed) {
    if (row.billedUsd === 0 && row.articleId === null) continue;
    const lang = row.articleId === null ? 'und' : (articleLang.get(row.articleId) ?? 'und');
    cell(lang).billedUsd += row.billedUsd;
  }
  return out;
}

function sumOf(
  byLang: RunResults['cost']['byLang'],
  field: 'estimatedUsd' | 'billedUsd' | 'cacheSavingsUsd',
): number {
  let total = 0;
  for (const lang of Object.keys(byLang).sort()) total += byLang[lang]?.[field] ?? 0;
  return total;
}

function statusOf(
  abort: AbortState,
  coverage: RunResults['coverage'],
): { status: RunStatus; reason?: string } {
  if (abort.aborted) return { status: 'aborted', reason: abort.reason ?? 'aborted' };
  const cells = [...Object.values(coverage.byLang), ...Object.values(coverage.enrich ?? {})];
  return cells.every((cell) => cell.valid === cell.expected)
    ? { status: 'complete' }
    : { status: 'partial', reason: 'some answers are missing; resume with --resume <runId>' };
}

function summarizeLatency(stats: RunStats): RunResults['latencyMs'] {
  return Object.fromEntries(
    Object.entries(stats.latencyMs).map(([kind, samples]) => [kind, latencySummary(samples)]),
  );
}

// ── The API ─────────────────────────────────────────────────────────────────────────────────────

function newEnv(
  rt: EvalRuntime,
  cache: EvalCache,
  plan: Plan,
  translators: EvalTranslators,
  services: EvalServiceOverrides,
  estimating: boolean,
): CallEnv {
  return {
    router: null,
    cache,
    runId: null,
    engine: plan.config.engine,
    typesafePricePerMTokUsd: rt.config.typesafePricePerMtokUsd,
    translators,
    credentials: evalCredentials(rt.db, rt.config, services),
    ollamaModel: plan.config.translation.model ?? rt.config.ollamaModelFast,
    stats: createRunStats(),
    abort: { aborted: false, reason: null },
    estimating,
    clockMs: () => performance.now(),
    articleLang: new Map([...plan.samples].map(([id, item]) => [id, item.lang])),
  };
}

function validateOptions(options: RunExperimentOptions): number {
  const maxUsd = options.maxUsd ?? DEFAULT_MAX_USD;
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    throw new EvalCommandError('--max-usd must be a non-negative number');
  }
  for (const lang of options.langs ?? []) {
    if (!/^[a-z]{2,3}$/.test(lang)) throw new EvalCommandError(`invalid language ${lang}`);
  }
  for (const id of [...(options.raterIds ?? []), options.baseRunId, options.resumeRunId]) {
    if (id !== undefined && !/^[1-9]\d{0,18}$/.test(id)) {
      throw new EvalCommandError(`invalid id ${id}`);
    }
  }
  return maxUsd;
}

export async function runExperiment(
  rt: EvalRuntime,
  options: RunExperimentOptions,
): Promise<RunExperimentResult> {
  // One invocation per run at a time (D-114 addendum): a resume claims the run before it reads the
  // run's resume state, and a new run is claimed as soon as its row exists. The claim lives for
  // the whole invocation and ends with its connection, so a crash never leaves a stale one.
  const claim: { lock: RunLock | null; base: RunLock | null } = { lock: null, base: null };
  try {
    return await runClaimed(rt, options, claim);
  } finally {
    await claim.lock?.release();
    await claim.base?.release();
  }
}

/** Attempts to freeze when the inputs keep changing between the estimate and the freeze. */
const MAX_FREEZE_ATTEMPTS = 3;

/** The inputs read under the freeze differ from the estimated ones (the freeze is rolled back). */
class InputsChanged extends Error {
  constructor(readonly config: Omit<RunConfig, 'configSha'>) {
    super('run inputs changed before the freeze');
    this.name = 'InputsChanged';
  }
}

/**
 * English card text (spec 07 §5) for every card of a config. Production hints card detection with
 * the user's locale; a rater has no UI locale here, so a rater with exactly one non-English
 * language uses it as the hint.
 */
async function translateRunCards(
  env: CallEnv,
  config: Omit<RunConfig, 'configSha'>,
): Promise<Omit<RunConfig, 'configSha'>> {
  const localeOf = new Map<string, string | null>();
  for (const rater of config.raters) {
    const others = [...new Set(rater.langs.filter((lang) => lang !== 'en'))];
    localeOf.set(rater.raterId, others.length === 1 ? (others[0] ?? null) : null);
  }
  const translated: RunCard[] = [];
  const byText = new Map<string, Promise<RunCard>>();
  for (const card of config.cards) {
    const locale = localeOf.get(card.raterId) ?? null;
    const key = JSON.stringify([card.interest, card.notFor, locale]);
    let pending = byText.get(key);
    if (pending === undefined) {
      pending = translateCard(env, card, locale);
      byText.set(key, pending);
    }
    const done = await pending;
    translated.push({
      ...card,
      interestEn: done.interestEn,
      notForEn: done.notForEn,
      lang: done.lang,
      textStatus: done.textStatus,
    });
  }
  return { ...config, cards: translated };
}

async function claimRun(rt: EvalRuntime, runId: string): Promise<RunLock> {
  const lock = await tryLockRun(rt.config.databaseUrlWorker, runId);
  if (lock === null) {
    throw new EvalCommandError(`run ${runId} is being executed by another eval run invocation`);
  }
  return lock;
}

async function runClaimed(
  rt: EvalRuntime,
  options: RunExperimentOptions,
  claim: { lock: RunLock | null; base: RunLock | null },
): Promise<RunExperimentResult> {
  const def = EXPERIMENTS[options.experiment];
  const maxUsd = validateOptions(options);
  const services = options.services ?? {};
  const gitSha = options.gitSha ?? currentGitSha();

  // A replay brings its own frozen config; a resume reuses the stored one.
  let dataset: DatasetRow;
  let config: Omit<RunConfig, 'configSha'>;
  let existingRunId: string | null = null;
  let prior: { cost: RunCost | null; incomplete: boolean } = { cost: null, incomplete: false };
  const cardMode: CardTextMode =
    def.variant.cards === 'selected' ? (options.cardTextMode ?? 'as_written') : def.variant.cards;
  if (options.replay !== undefined) {
    config = options.replay.config;
    dataset = await resolveDataset(rt, config.datasetVersion);
  } else if (options.resumeRunId !== undefined) {
    claim.lock = await claimRun(rt, options.resumeRunId);
    const run = await getRun(rt.db, options.resumeRunId);
    if (run === null) throw new EvalCommandError(`run ${options.resumeRunId} does not exist`);
    if (run.experiment !== def.id) {
      throw new EvalCommandError(`run ${run.id} is a ${run.experiment} run, not ${def.id}`);
    }
    const status = (run.results as { status?: unknown } | null)?.status;
    if (status === 'complete' || status === 'skipped') {
      throw new EvalCommandError(`run ${run.id} is ${String(status)}; nothing to resume`);
    }
    // A run that E6/E7 build on keeps its answers: they read them whenever they plan or resume.
    const derived = await findDerivedRunId(rt.db, run.id);
    if (derived !== null) {
      throw new EvalCommandError(
        `run ${run.id} is the base of run ${derived}, so its answers are final; start a new ${def.id} run instead`,
      );
    }
    const { configSha: _sha, ...stored } = parseRunConfig(run.config);
    config = stored;
    existingRunId = run.id;
    prior = priorRunCost(run.results);
    dataset = await resolveDataset(rt, run.datasetVersion);
    // Information only: `--max-usd` caps this invocation (spec 10 §3); earlier ones spent this.
    rt.out(
      `run ${run.id}: earlier invocations billed ${formatUsd(prior.cost?.billedUsd ?? 0)}` +
        `${prior.incomplete ? ' (as recorded; an earlier invocation recorded no cost, so this is a lower bound)' : ''}\n`,
    );
  } else {
    dataset = await resolveDataset(rt, options.datasetVersion);
    if (def.skipReason !== null) {
      return skipRun(rt, def, dataset, maxUsd, gitSha, options);
    }
    config = await draftConfig(rt, rt.db, def, options, dataset, cardMode, maxUsd);
  }
  if (config.baseRunId !== undefined) {
    // Hold the base run in shared mode for this whole invocation: a resume of the base (which
    // would add answers this run reads) needs it exclusively. Its row then names the base, which
    // refuses any later resume of it.
    claim.base = await tryLockRun(rt.config.databaseUrlWorker, config.baseRunId, 'shared');
    if (claim.base === null) {
      throw new EvalCommandError(
        `base run ${config.baseRunId} is being executed by another eval run invocation`,
      );
    }
    const baseStatus = (
      (await getRun(rt.db, config.baseRunId))?.results as {
        status?: unknown;
      } | null
    )?.status;
    if (baseStatus !== 'complete' && baseStatus !== 'partial') {
      throw new EvalCommandError(
        `base run ${config.baseRunId} is not finished (${String(baseStatus ?? 'running')})`,
      );
    }
  }

  const cache = createEvalCache({ dir: rt.config.evalCacheDir, now: rt.now });
  const translators = evalTranslators(rt.config, services);
  try {
    // 1. Estimate with the cache consulted and nothing sent (spec 10 §3).
    const existing = new Map<string, Record<string, unknown>>();
    if (existingRunId !== null) {
      for (const row of await loadRunAnswers(rt.db, existingRunId)) {
        existing.set(answerKey(row.articleId, row.cardId, row.questionKey), row.answer);
      }
    }
    const frozen = options.replay?.translations ?? null;
    const estimateFor = async (cfg: Omit<RunConfig, 'configSha'>) => {
      const plan = await buildPlan(rt, def, cfg, { frozenTranslations: frozen, existing });
      const envOf = newEnv(rt, cache, plan, translators, services, true);
      await execute(envOf, plan, null, null, 1);
      const value: CostEstimate = {
        estimatedUsd: envOf.stats.estimateUsd,
        uncachedCalls: envOf.stats.estimateCalls,
        cacheHits: envOf.stats.cacheHits,
      };
      return { env: envOf, estimate: value };
    };
    /** Print an estimate and apply the confirmation rule; false when the run is declined. */
    const announce = async (value: CostEstimate, revised: boolean): Promise<boolean> => {
      rt.out(
        `${def.id} on ${dataset.version}: ${revised ? 'revised estimate (the frozen inputs or card text changed)' : 'estimated cost'} ` +
          `${formatUsd(value.estimatedUsd)} ` +
          `(${value.uncachedCalls} uncached request(s), ${value.cacheHits} cache hit(s)); ` +
          `cap ${formatUsd(maxUsd)}\n`,
      );
      if (value.estimatedUsd > CONFIRM_ABOVE_USD && options.yes !== true) {
        return options.confirm === undefined ? false : await options.confirm(value);
      }
      return true;
    };
    let { env: estimateEnv, estimate } = await estimateFor(config);
    if (!(await announce(estimate, false))) {
      return { runId: null, status: 'declined', estimate, results: null };
    }

    const plan0 = await buildPlan(rt, def, config, { frozenTranslations: frozen, existing });
    const env = newEnv(rt, cache, plan0, translators, services, false);
    env.router = createEvalRouter({
      db: rt.db,
      config: rt.config,
      logger: silentLogger(rt),
      maxUsd,
      requiredEngine: config.engine?.requiredEngine === 'llm' ? 'llm' : 'typesafe',
      typesafeModel:
        config.engine?.provider === 'typesafe' ? config.engine.model : rt.config.typesafeModel,
      llmModel: config.engine?.provider === 'llm' ? config.engine.model : rt.config.ollamaModelFast,
      credentials: env.credentials,
      overrides: services,
      onLogicalRequest: (id) => env.stats.logicalRequestIds.push(id),
    });

    let runId = existingRunId;
    if (existingRunId === null && options.replay === undefined) {
      // 2. A new run: settle the final inputs and their estimate, then freeze and write the run
      // row in one transaction, so a run declined at any prompt freezes nothing (D-110 addendum).
      let shown = inputsSha(config);
      let draft = config;
      for (let attempt = 1; ; attempt += 1) {
        // 3. Card text in English mode is translated before the run is written, so the config
        // records the exact card text every question uses (LibreTranslate: free, not confirmed).
        const final = cardMode === 'english' ? await translateRunCards(env, draft) : draft;
        // Ratings, assignments or cards may have changed while the estimate was shown, and English
        // card text is only known now: estimate the exact final inputs again and, when that
        // differs, show it and ask again, still before the freeze, the run row and any engine call.
        if (inputsSha(final) !== shown) {
          const revised = await estimateFor(final);
          estimateEnv = revised.env;
          shown = inputsSha(final);
          if (
            revised.estimate.estimatedUsd !== estimate.estimatedUsd ||
            revised.estimate.uncachedCalls !== estimate.uncachedCalls
          ) {
            estimate = revised.estimate;
            if (!(await announce(estimate, true))) {
              return { runId: null, status: 'declined', estimate, results: null };
            }
          }
        }
        // 4. Freeze and read the inputs again in one transaction, under the dataset additions lock
        // that every post-freeze rating correction takes (and the row lock an open-head rating
        // write shares), so no rating, card or assignment lands between the freeze and the config
        // snapshot. The run row is written only when they are still the confirmed ones; otherwise
        // the freeze is rolled back and the new inputs go through the estimate again.
        const version = dataset.version;
        const draftSha = inputsSha(draft);
        const written = await rt.db
          .transaction(async (tx) => {
            await lockDatasetAdditions(tx);
            const frozenRow = await freezeDataset(tx, version);
            const locked = await draftConfig(rt, tx, def, options, frozenRow, cardMode, maxUsd);
            if (inputsSha(locked) !== draftSha) throw new InputsChanged(locked);
            const runConfig = withConfigSha({ ...locked, cards: final.cards });
            const run = await createRun(tx, {
              experiment: def.id,
              datasetVersion: frozenRow.version,
              config: runConfig as unknown as Record<string, unknown>,
              gitSha,
            });
            return { run, frozenRow, runConfig };
          })
          .catch((error: unknown) => {
            if (error instanceof InputsChanged) return error;
            throw error;
          });
        if (written instanceof InputsChanged) {
          if (attempt >= MAX_FREEZE_ATTEMPTS) {
            throw new EvalCommandError(
              `the ratings, cards or assignments of ${version} kept changing while the run was ` +
                'being set up; nothing was frozen, try again',
            );
          }
          draft = written.config;
          continue;
        }
        const { configSha: _sha, ...stored } = written.runConfig;
        dataset = written.frozenRow;
        config = stored;
        runId = written.run.id;
        claim.lock = await claimRun(rt, runId);
        rt.out(`run ${runId} started (config ${written.runConfig.configSha.slice(0, 12)})\n`);
        break;
      }
    } else if (runId === null) {
      // A replay's run row (its config is the compared run's, frozen already).
      const fullConfig = withConfigSha(config);
      const run = await createRun(rt.db, {
        experiment: `replay:${options.replay?.config.experiment ?? def.id}`,
        datasetVersion: dataset.version,
        config: fullConfig as unknown as Record<string, unknown>,
        gitSha,
      });
      runId = run.id;
      claim.lock = await claimRun(rt, runId);
      rt.out(`run ${runId} started (config ${fullConfig.configSha.slice(0, 12)})\n`);
    } else {
      rt.out(`resuming run ${runId}\n`);
    }
    env.runId = runId;
    const plan = await buildPlan(rt, def, config, { frozenTranslations: frozen, existing });
    // The cost split follows the final cohort (the inputs may have changed before the freeze).
    env.articleLang = new Map([...plan.samples].map(([id, item]) => [id, item.lang]));
    const id = runId;
    const sink: Sink = (rows) => upsertRunAnswers(rt.db, id, rows);

    // A resume records its in-flight state before any work, for every experiment: the earlier
    // invocations' cost carried and marked incomplete, so a kill at any point leaves a lower
    // bound that the next resume keeps (D-110).
    if (existingRunId !== null) {
      await updateRunResults(rt.db, id, {
        status: 'running',
        cost: { ...(prior.cost ?? emptyRunCost()), incomplete: true },
      });
    }

    let out: Execution;
    try {
      out = await execute(
        env,
        plan,
        sink,
        (done, total) =>
          updateRunResults(rt.db, id, {
            status: 'running',
            progress: { done, total },
            // Carried while in flight, so a crash of this invocation keeps the earlier ones' cost.
            ...(prior.cost === null ? {} : { cost: { ...prior.cost, incomplete: true } }),
          }),
        Math.max(1, options.concurrency ?? 4),
      );
    } catch (error) {
      await finishRun(rt.db, id, {
        status: 'aborted',
        reason: `error: ${error instanceof Error ? error.name : 'unknown'}`,
        cost: mergeRunCost(
          prior.cost,
          await invocationCost(rt, env, estimateEnv),
          prior.incomplete,
        ),
      });
      throw error;
    }

    // 5. Scores and results.
    const scored = scoreRows(plan, out);
    if (scored.rows.length > 0) await upsertRunAnswers(rt.db, id, scored.rows);
    const current = await invocationCost(rt, env, estimateEnv);
    const cost = mergeRunCost(prior.cost, current, prior.incomplete);
    const verdict = statusOf(env.abort, scored.coverage);
    const results: RunResults = {
      ...verdict,
      coverage: scored.coverage,
      ...(scored.translationFallbacks === null
        ? {}
        : { translationFallbacks: scored.translationFallbacks }),
      ...(scored.cardTextFallbacks === null ? {} : { cardTextFallbacks: scored.cardTextFallbacks }),
      cost,
      latencyMs: summarizeLatency(env.stats),
      cacheLookupMs: latencySummary(env.stats.cacheLookupMs),
      ...(plan.e6 === null
        ? {}
        : {
            e6: {
              examplesAdded: plan.e6.examplesAdded,
              earlierArticleIds: plan.e6.earlierArticleIds,
              laterArticleIds: plan.e6.laterArticleIds,
            },
          }),
      ...(plan.e7 === null
        ? {}
        : {
            e7: {
              items: plan.e7.map((item) => ({
                articleId: item.articleId,
                raterId: item.raterId,
                targetedCardId: item.targetedCardId,
              })),
            },
          }),
    };
    await finishRun(rt.db, id, results as unknown as Record<string, unknown>);
    rt.out(
      `run ${id} ${results.status}: billed ${formatUsd(current.billedUsd)}, ` +
        `${env.stats.cacheHits} cache hit(s), ${env.stats.cacheMisses} miss(es)` +
        (cost.invocations === undefined
          ? '\n'
          : `; ${cost.invocations} invocations billed ${formatUsd(cost.billedUsd)}\n`),
    );
    return { runId: id, status: results.status, estimate, results };
  } finally {
    await translators.close();
  }
}

const LangCostSchema = z.object({
  estimatedUsd: z.number(),
  billedUsd: z.number(),
  cacheSavingsUsd: z.number(),
});
const StoredCostSchema = z.object({
  estimatedUsd: z.number(),
  billedUsd: z.number(),
  cacheHits: z.number(),
  cacheMisses: z.number(),
  cacheSavingsUsd: z.number(),
  failedCallUsd: z.number(),
  tokens: z.object({ input: z.number(), output: z.number() }),
  byLang: z.record(z.string(), LangCostSchema).default({}),
  invocations: z.number().int().positive().optional(),
  incomplete: z.boolean().optional(),
});
type RunCost = RunResults['cost'];

/**
 * The cost an earlier invocation of a resumed run recorded, or `incomplete` when it recorded none
 * (it crashed while `running`; its engine calls are not attributable to the run any more).
 */
export function priorRunCost(results: Record<string, unknown> | null): {
  cost: RunCost | null;
  incomplete: boolean;
} {
  const parsed = StoredCostSchema.safeParse(results?.['cost']);
  if (parsed.success) {
    const { invocations, incomplete, ...cost } = parsed.data;
    return {
      cost: { ...cost, ...(invocations === undefined ? {} : { invocations }) },
      incomplete: incomplete === true,
    };
  }
  return { cost: null, incomplete: true };
}

/**
 * The cost of a resumed run (D-110): this invocation's billed, failed-call, token and cache figures
 * added to the earlier invocations' (per language too); the estimate stays the first invocation's
 * whole-run estimate when there is one. Totals remain the sums of the per-language split.
 */
export function mergeRunCost(
  prior: RunCost | null,
  current: RunCost,
  incomplete: boolean,
): RunCost {
  if (prior === null) return incomplete ? { ...current, incomplete: true } : current;
  const byLang: RunCost['byLang'] = {};
  const cell = (lang: string) =>
    (byLang[lang] ??= { estimatedUsd: 0, billedUsd: 0, cacheSavingsUsd: 0 });
  const priorHasEstimate = Object.keys(prior.byLang).length > 0 || prior.estimatedUsd > 0;
  for (const [lang, c] of Object.entries(prior.byLang)) {
    const target = cell(lang);
    target.estimatedUsd += c.estimatedUsd;
    target.billedUsd += c.billedUsd;
    target.cacheSavingsUsd += c.cacheSavingsUsd;
  }
  for (const [lang, c] of Object.entries(current.byLang)) {
    const target = cell(lang);
    if (!priorHasEstimate) target.estimatedUsd += c.estimatedUsd;
    target.billedUsd += c.billedUsd;
    target.cacheSavingsUsd += c.cacheSavingsUsd;
  }
  return {
    estimatedUsd: sumOf(byLang, 'estimatedUsd'),
    billedUsd: sumOf(byLang, 'billedUsd'),
    cacheHits: prior.cacheHits + current.cacheHits,
    cacheMisses: prior.cacheMisses + current.cacheMisses,
    cacheSavingsUsd: sumOf(byLang, 'cacheSavingsUsd'),
    failedCallUsd: prior.failedCallUsd + current.failedCallUsd,
    tokens: {
      input: prior.tokens.input + current.tokens.input,
      output: prior.tokens.output + current.tokens.output,
    },
    byLang,
    invocations: (prior.invocations ?? 1) + 1,
    ...(incomplete || prior.incomplete === true ? { incomplete: true } : {}),
  };
}

/** This invocation's cost: its own logical requests' engine calls, cache counters and estimate. */
async function invocationCost(
  rt: EvalRuntime,
  env: CallEnv,
  estimateEnv: CallEnv,
): Promise<RunCost> {
  const spend = await runCallSpend(rt.db, env.stats.logicalRequestIds);
  const byLang = costByLang(
    estimateEnv.stats.byLang,
    env.stats.byLang,
    await runCallSpendByArticle(rt.db, env.stats.logicalRequestIds),
    env.articleLang,
  );
  return {
    // Totals are the sums of the per-language split (identical up to float rounding to the
    // estimate printed above, the engine_calls sum and the live savings counter).
    estimatedUsd: sumOf(byLang, 'estimatedUsd'),
    billedUsd: sumOf(byLang, 'billedUsd'),
    cacheHits: env.stats.cacheHits,
    cacheMisses: env.stats.cacheMisses,
    cacheSavingsUsd: sumOf(byLang, 'cacheSavingsUsd'),
    failedCallUsd: spend.failedCallUsd,
    tokens: { input: spend.inputTokens, output: spend.outputTokens },
    byLang,
  };
}

/** The run inputs an estimate depends on (cohort, raters, ground truth, cards, assignments). */
/**
 * The draft-config fields an estimate and plan depend on. A change between the confirmed estimate
 * and the freeze (ground truth, the deployed `ranker.thresholds` that E6 suggests examples with,
 * the base run a default `--base` resolves to, the seed) forces a new estimate (D-110 addendum).
 */
function inputsSha(config: Omit<RunConfig, 'configSha'>): string {
  return canonicalSha256({
    seed: config.seed,
    rankerThresholds: config.rankerThresholds ?? null,
    baseRunId: config.baseRunId ?? null,
    langs: config.langs,
    cohort: config.cohort,
    raters: config.raters,
    ratings: config.ratings,
    cards: config.cards,
    assignments: config.assignments,
    facetLabels: config.facetLabels,
  });
}

function emptyRunCost(): RunCost {
  return {
    estimatedUsd: 0,
    billedUsd: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSavingsUsd: 0,
    failedCallUsd: 0,
    tokens: { input: 0, output: 0 },
    byLang: {},
  };
}

/** E5 and other stubs: a run row whose results say `skipped` and why (no freeze, no calls). */
async function skipRun(
  rt: EvalRuntime,
  def: ExperimentDefinition,
  dataset: DatasetRow,
  maxUsd: number,
  gitSha: string,
  options: RunExperimentOptions,
): Promise<RunExperimentResult> {
  const reason = def.skipReason ?? 'skipped';
  const config = withConfigSha({
    experiment: def.id,
    variant: { state: 'native', cards: 'as_written' },
    datasetVersion: dataset.version,
    snapshotSha: dataset.snapshotSha,
    splitSha: dataset.splitSha,
    seed: options.seed ?? dataset.seed,
    engine: null,
    questionSets: null,
    translation: { articles: null, cards: null },
    langs: [...(options.langs ?? [])].sort(),
    developmentOnly: def.developmentOnly,
    raters: [],
    cohort: { articleIds: [], sha: canonicalSha256([]) },
    assignments: {},
    ratings: [],
    cards: [],
    facetLabels: [],
    maxUsd,
    runtime: runtimeInfo(),
  });
  const run = await createRun(rt.db, {
    experiment: def.id,
    datasetVersion: dataset.version,
    config: config as unknown as Record<string, unknown>,
    gitSha,
  });
  const results: RunResults = {
    status: 'skipped',
    reason,
    coverage: { byLang: {}, byRater: {} },
    cost: {
      estimatedUsd: 0,
      billedUsd: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheSavingsUsd: 0,
      failedCallUsd: 0,
      tokens: { input: 0, output: 0 },
      byLang: {},
    },
    latencyMs: {},
    cacheLookupMs: latencySummary([]),
  };
  await finishRun(rt.db, run.id, results as unknown as Record<string, unknown>);
  rt.out(`${def.id}: skipped (${reason}); run ${run.id}\n`);
  return {
    runId: run.id,
    status: 'skipped',
    estimate: { estimatedUsd: 0, uncachedCalls: 0, cacheHits: 0 },
    results,
  };
}
