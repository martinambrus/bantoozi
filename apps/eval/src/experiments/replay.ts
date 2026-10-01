import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRun, loadRunAnswers, loadSample, type RunAnswerRow } from '@bantoozi/db';
import { DEFAULT_LLM_MAX_OUTPUT_TOKENS } from '@bantoozi/engine';
import { ENRICH_V1, MATCH_V1, type Answer } from '@bantoozi/questions';
import {
  applyLanePolicy,
  evaluateNeverCards,
  mergeRankerConfig,
  mustFloorCard,
  type CardAnswers,
  type RankCard,
  type RankerConfig,
} from '@bantoozi/ranker';
import { compareBigIntStrings } from '@bantoozi/shared';

import { asSnapshot } from '../dataset/snapshot.js';
import type { RatedItem } from '../report/items.js';
import { buildCells, macroAuc, pairedMacroDelta, type ScoreFn } from '../report/ranking.js';
import { EvalCommandError, type EvalRuntime } from '../runtime.js';
import {
  isExperimentId,
  KEYWORD_BASELINE_EXPERIMENT,
  KEYWORD_BASELINE_REPLAY,
  REPLAYABLE_EXPERIMENTS,
  type ExperimentId,
} from './definitions.js';
import { pairedAuc, type PairedAuc, type ScoredItem } from './paired-auc.js';
import { parseRunConfig, type RunConfig, type RunEngine } from './run-config.js';
import {
  runExperiment,
  runRankerConfig,
  type CostEstimate,
  type RunExperimentResult,
  type RunStatus,
} from './runner.js';
import { cardsComplete, rankCardOf } from './scores.js';
import type { EvalServiceOverrides } from './services.js';
import type { FrozenTranslation } from './states.js';

/**
 * `eval replay --against <runId>` (spec 10 §6): re-run a stored card experiment's frozen inputs
 * (the same dataset version, cohort, raters, cards, ratings and the run's own frozen translations)
 * with a proposed change: another Jev model (`--model`), the LLM fallback classifier
 * (`--engine llm --llm-model`, which answers Call A and Call B through the pinned `llm` engine), a
 * question set or ranker thresholds. Unchanged requests hit the cache, so a thresholds-only replay
 * costs nothing. The replay is a run of its own (`replay:<experiment>`, config `replay`), and the
 * markdown diff report compares it with the stored run: ΔAUC per rater and language with paired
 * story-group bootstrap intervals, the mean |Δp| per question key, the share of items changing
 * lane, policy regressions and the pass rule.
 */

export interface ReplayOptions {
  againstRunId: string;
  engine?: 'typesafe' | 'llm';
  /** The proposed `TYPESAFE_MODEL`. */
  model?: string;
  /** The LLM model of `--engine llm` (default `OLLAMA_MODEL_FAST`). */
  llmModel?: string;
  /** The proposed enrich question set (only versions this code builds). */
  questionSet?: string;
  /** Proposed `ranker.thresholds` (a deep partial, spec 06 §11). */
  thresholds?: unknown;
  maxUsd?: number;
  yes?: boolean;
  confirm?: (estimate: CostEstimate) => Promise<boolean>;
  services?: EvalServiceOverrides;
  gitSha?: string;
  /** Where the markdown report goes; default `apps/eval/reports/REPLAY-<run>-vs-<base>.md`. */
  reportPath?: string | null;
}

export interface ReplayResult {
  baseRunId: string;
  run: RunExperimentResult;
  report: string;
  reportPath: string | null;
  verdict: 'pass' | 'fail' | 'inconclusive' | null;
}

/** Cell support for an AUC (spec 10 §5: ≥ 20 items and ≥ 5 of each class). */
export const MIN_CELL_ITEMS = 20;
export const MIN_CELL_CLASS = 5;
/** Spec 10 §6 pass rule tolerances. */
export const MAX_CELL_AUC_DROP = 0.03;
export const MAX_FOR_YOU_PRECISION_DROP = 0.03;

const DEFAULT_REPORT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../reports',
);

function frozenTranslations(rows: readonly RunAnswerRow[]): Map<string, FrozenTranslation | null> {
  const map = new Map<string, FrozenTranslation | null>();
  for (const row of rows) {
    const value = row.answer as Record<string, unknown>;
    if (value['ok'] !== true) {
      map.set(row.articleId, null);
      continue;
    }
    map.set(row.articleId, {
      engine: value['engine'] === 'ollama' ? 'ollama' : 'libretranslate',
      model: typeof value['model'] === 'string' ? value['model'] : null,
      quality: value['quality'] as FrozenTranslation['quality'],
      texts: value['texts'] as FrozenTranslation['texts'],
    });
  }
  return map;
}

/**
 * The baseline side's ranker config (spec 10 §6: the comparison is against the deployed policy):
 * the effective config a base replay recorded, else the `ranker.thresholds` the base run froze when
 * it started, else the stored setting now (runs written before thresholds were recorded). A base
 * that was itself a replay keeps its own proposed thresholds on top.
 */
export async function baselineRanker(
  db: EvalRuntime['db'],
  config: RunConfig,
): Promise<{ ranker: RankerConfig; source: 'base_run' | 'settings' }> {
  if (config.replay?.replayRanker !== undefined) {
    return { ranker: mergeRankerConfig(config.replay.replayRanker), source: 'base_run' };
  }
  const proposed = config.replay?.thresholds ?? {};
  const frozen = await runRankerConfig(db, config);
  return { ranker: mergeRankerConfig(proposed, frozen.ranker), source: frozen.source };
}

/** A complete base run: finished `complete` with every coverage cell full (no missing output). */
function assertCompleteBase(id: string, results: unknown): void {
  const r = (results ?? {}) as {
    status?: unknown;
    coverage?: Record<string, Record<string, { expected?: unknown; valid?: unknown }> | undefined>;
  };
  if (r.status !== 'complete') {
    throw new EvalCommandError(
      `run ${id} is ${typeof r.status === 'string' ? r.status : 'unfinished'}, not complete; ` +
        'replay only a complete run (resume it first with `eval run --resume`)',
    );
  }
  for (const group of ['byLang', 'byRater', 'enrich'] as const) {
    for (const [key, cell] of Object.entries(r.coverage?.[group] ?? {})) {
      if (typeof cell.expected === 'number' && typeof cell.valid === 'number') {
        if (cell.valid < cell.expected) {
          throw new EvalCommandError(
            `run ${id} has incomplete ${group} coverage for ${key} (${cell.valid}/${cell.expected}); ` +
              'replay only a complete run',
          );
        }
      }
    }
  }
}

export async function replayRun(rt: EvalRuntime, options: ReplayOptions): Promise<ReplayResult> {
  const base = await getRun(rt.db, options.againstRunId);
  if (base === null) throw new EvalCommandError(`run ${options.againstRunId} does not exist`);
  if (base.finishedAt === null) {
    throw new EvalCommandError(`run ${base.id} has not finished; replay a finished run`);
  }
  const baseConfig = parseRunConfig(base.config);
  const baseExperiment = baseConfig.experiment;
  const keyword = baseExperiment === KEYWORD_BASELINE_EXPERIMENT;
  if (
    !isExperimentId(baseExperiment) ||
    !(REPLAYABLE_EXPERIMENTS.includes(baseExperiment) || keyword)
  ) {
    throw new EvalCommandError(
      `run ${base.id} (${base.experiment}) cannot be replayed; replayable: ${REPLAYABLE_EXPERIMENTS.join(', ')}` +
        ` (and ${KEYWORD_BASELINE_EXPERIMENT} with --engine llm for a first LLM fallback enablement)`,
    );
  }
  if (keyword && options.engine !== 'llm') {
    throw new EvalCommandError(
      `a ${KEYWORD_BASELINE_EXPERIMENT} run is the baseline only for a first enablement of the LLM ` +
        'fallback: replay it with --engine llm (spec 10 §6)',
    );
  }
  // Against the keyword baseline the replay side is the fallback classifier on E1's variant.
  const experiment: ExperimentId = keyword ? KEYWORD_BASELINE_REPLAY : baseExperiment;
  assertCompleteBase(base.id, base.results);
  const questionSet = options.questionSet ?? ENRICH_V1.version;
  if (questionSet !== ENRICH_V1.version) {
    throw new EvalCommandError(
      `question set ${questionSet} is not built by this code (available: ${ENRICH_V1.version})`,
    );
  }
  const baseline = await baselineRanker(rt.db, baseConfig);
  const baseRanker = baseline.ranker;
  let replayRanker: RankerConfig;
  try {
    replayRanker =
      options.thresholds === undefined
        ? baseRanker
        : mergeRankerConfig(options.thresholds, baseRanker);
  } catch {
    throw new EvalCommandError('the thresholds are not a valid ranker.thresholds partial');
  }

  const engineName = options.engine ?? (baseConfig.engine?.provider === 'llm' ? 'llm' : 'typesafe');
  const engine: RunEngine =
    engineName === 'llm'
      ? {
          provider: 'llm',
          model: options.llmModel ?? rt.config.ollamaModelFast,
          requiredEngine: 'llm',
          pricePerMTokUsd: null,
          maxOutputTokens: DEFAULT_LLM_MAX_OUTPUT_TOKENS,
        }
      : {
          provider: 'typesafe',
          model: options.model ?? baseConfig.engine?.model ?? rt.config.typesafeModel,
          requiredEngine: 'typesafe',
          pricePerMTokUsd: rt.config.typesafePricePerMtokUsd,
          maxOutputTokens: null,
        };
  const maxUsd = options.maxUsd ?? 10;
  const { configSha: _sha, ...stored } = baseConfig;
  const config: Omit<RunConfig, 'configSha'> = {
    ...stored,
    ...(keyword
      ? {
          experiment,
          variant: { state: 'native', cards: 'as_written' } as RunConfig['variant'],
          questionSets: {
            enrich: { version: ENRICH_V1.version, sha: ENRICH_V1.sha256 },
            match: { version: MATCH_V1.version, sha: MATCH_V1.sha256 },
          },
        }
      : {}),
    engine,
    maxUsd,
    baseRunId: base.id,
    replay: {
      of: base.id,
      engine: engineName,
      model: engine.model,
      questionSet,
      thresholds:
        options.thresholds === undefined ? null : (options.thresholds as Record<string, unknown>),
      baseRanker: { ...baseRanker },
      baseRankerSource: baseline.source,
      replayRanker: { ...replayRanker },
      baseline: keyword ? 'keyword' : 'run',
    },
  };
  const translations = frozenTranslations(
    await loadRunAnswers(rt.db, base.id, { questionKeys: ['translation'] }),
  );

  const run = await runExperiment(rt, {
    experiment,
    maxUsd,
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.services === undefined ? {} : { services: options.services }),
    ...(options.gitSha === undefined ? {} : { gitSha: options.gitSha }),
    replay: { baseRunId: base.id, config, translations },
  });
  if (run.runId === null) {
    return { baseRunId: base.id, run, report: '', reportPath: null, verdict: null };
  }

  const [baseAnswers, replayAnswers, sample] = await Promise.all([
    loadRunAnswers(rt.db, base.id),
    loadRunAnswers(rt.db, run.runId),
    loadSample(rt.db, baseConfig.datasetVersion, { articleIds: baseConfig.cohort.articleIds }),
  ]);
  const articles = new Map(
    sample.map((row) => [
      row.articleId,
      { lang: row.lang, storyGroupId: asSnapshot(row.snapshot).storyGroupId },
    ]),
  );
  const diff = replayDiff({
    config: baseConfig,
    articles,
    base: baseAnswers,
    replay: replayAnswers,
    baseRanker,
    replayRanker,
    replayStatus: run.status,
    keywordBaseline: keyword,
  });
  const report = renderReplayReport({
    baseRunId: base.id,
    baseExperiment: base.experiment,
    replayRunId: run.runId,
    config: baseConfig,
    change: config.replay ?? null,
    engine,
    run,
    diff,
  });
  let reportPath: string | null = null;
  if (options.reportPath !== null) {
    reportPath =
      options.reportPath ?? path.join(DEFAULT_REPORT_DIR, `REPLAY-${run.runId}-vs-${base.id}.md`);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report);
  }
  return { baseRunId: base.id, run, report, reportPath, verdict: diff.verdict };
}

// ── The diff (pure) ─────────────────────────────────────────────────────────────────────────────

type Lane = 'for_you' | 'maybe' | 'everything' | 'hidden' | 'new';

export interface ReplayCell {
  raterId: string;
  lang: string;
  auc: PairedAuc;
  eligible: boolean;
}

/** Lane-policy counts of one side over every rated pair (spec 10 §6). */
export interface PolicyCounts {
  hardHideFalseNegatives: number;
  liked: number;
  forYou: number;
  forYouLiked: number;
  /** Items in the Maybe lane, and the liked ones among them. */
  maybe: number;
  maybeLiked: number;
  /** Rated pairs the side placed (the denominator of the lane shares). */
  items: number;
}

export interface ReplayDiff {
  cells: ReplayCell[];
  /**
   * The gate's hierarchical macro AUC (spec 10 §4, D-110): supported reading contexts averaged
   * within each participant, then participants equally; the delta and its interval come from the
   * gate's paired story-group bootstrap on the same cells.
   */
  macro: {
    base: number | null;
    replay: number | null;
    delta: number | null;
    ci: [number, number] | null;
    participants: number;
  };
  /** Mean |Δp| per question key (`enrich.<key>`, `card`), with the number of compared answers. */
  deltaP: Array<{ key: string; meanAbs: number; n: number }>;
  laneChange: { changed: number; total: number };
  policy: {
    base: PolicyCounts;
    replay: PolicyCounts;
  };
  coverage: { base: number; replay: number; expected: number };
  verdict: 'pass' | 'fail' | 'inconclusive';
  reasons: string[];
}

/** One number per answer for |Δp|: Noul p, Score score, the probability of Choice's base pick. */
function comparable(answer: Answer, reference: Answer | undefined): number | null {
  if (answer.type === 'noul') return answer.p;
  if (answer.type === 'score') return answer.score;
  const pick = reference?.type === 'choice' ? reference.choice : answer.choice;
  return answer.probabilities[pick] ?? 0;
}

function answerIndex(rows: readonly RunAnswerRow[]) {
  const scores = new Map<string, number | null>();
  const cards = new Map<string, Map<string, { p: number; engine: string }>>();
  const enrich = new Map<string, Answer>();
  /** `articleId|raterId|cardId` of a rater's own copy that failed: never the shared answer. */
  const ownFailed = new Set<string>();
  for (const row of rows) {
    const value = row.answer as Record<string, unknown>;
    if (row.questionKey.startsWith('card.r') && row.cardId !== null && value['ok'] !== true) {
      ownFailed.add(`${row.articleId}|${row.questionKey.slice('card.r'.length)}|${row.cardId}`);
    } else if (row.questionKey.startsWith('score.r')) {
      const score = value['score'];
      scores.set(
        `${row.questionKey.slice('score.r'.length)}|${row.articleId}`,
        typeof score === 'number' ? score : null,
      );
    } else if (
      (row.questionKey === 'card' || row.questionKey.startsWith('card.r')) &&
      row.cardId !== null &&
      value['ok'] === true
    ) {
      // `card.r<raterId>`: that rater's copy of a shared card id, asked with its own text (D-112).
      const at =
        row.questionKey === 'card'
          ? row.articleId
          : `${row.articleId}|${row.questionKey.slice('card.r'.length)}`;
      const map = cards.get(at) ?? new Map<string, { p: number; engine: string }>();
      map.set(row.cardId, { p: Number(value['p']), engine: String(value['engine']) });
      cards.set(at, map);
    } else if (row.questionKey.startsWith('enrich.') && value['ok'] === true) {
      enrich.set(`${row.articleId}|${row.questionKey}`, value['answer'] as Answer);
    }
  }
  return { scores, cards, enrich, ownFailed };
}

/** The policy lane of an item (spec 06 §2 bootstrap subset, `applyLanePolicy`). */
export function policyLane(
  cards: readonly RankCard[],
  answers: CardAnswers,
  score: number | null,
  config: RankerConfig,
): Lane {
  const item = { cardAnswers: answers, inferenceFeedIds: [] as string[] };
  const never = evaluateNeverCards(cards, item, config);
  if (never.effect === 'hide') return 'hidden';
  if (score === null) return 'new';
  const must = mustFloorCard(cards, item, config);
  return applyLanePolicy(
    {
      p: score,
      source: 'cards',
      coverage: cardsComplete(cards, answers) ? 'complete' : 'pending',
      floors: must === null ? [] : [{ kind: 'must', cardId: must.cardId }],
      neverSoftCardId: never.effect === 'soft_cap' ? never.cardId : null,
    },
    config,
  ).lane;
}

const emptyPolicy = (): PolicyCounts => ({
  hardHideFalseNegatives: 0,
  liked: 0,
  forYou: 0,
  forYouLiked: 0,
  maybe: 0,
  maybeLiked: 0,
  items: 0,
});

export function replayDiff(input: {
  config: RunConfig;
  articles: ReadonlyMap<string, { lang: string; storyGroupId: string }>;
  base: readonly RunAnswerRow[];
  replay: readonly RunAnswerRow[];
  baseRanker: RankerConfig;
  replayRanker: RankerConfig;
  replayStatus: RunStatus | 'declined';
  /**
   * The base is the B1 keyword baseline (a first LLM fallback enablement): it has no card answers
   * and so no lane policy, and only the AUC rules of the pass rule apply.
   */
  keywordBaseline?: boolean;
}): ReplayDiff {
  const base = answerIndex(input.base);
  const replay = answerIndex(input.replay);
  const english = input.config.variant.cards === 'english';
  const cardsByRater = new Map<string, RankCard[]>();
  for (const card of input.config.cards) {
    const list = cardsByRater.get(card.raterId) ?? [];
    list.push(rankCardOf(card, english));
    cardsByRater.set(card.raterId, list);
  }

  const cellItems = new Map<string, { raterId: string; lang: string; items: ScoredItem[] }>();
  // Every rated pair as the gate's rated item (the macro cells and bootstrap reuse the gate's).
  const participantOf = new Map(input.config.raters.map((r) => [r.raterId, r.participantKey]));
  const rated: RatedItem[] = [];
  let laneChanged = 0;
  let laneTotal = 0;
  const policy = {
    base: emptyPolicy(),
    replay: emptyPolicy(),
  };
  let baseValid = 0;
  let replayValid = 0;
  let expected = 0;
  const seen = new Set<string>();
  for (const rating of input.config.ratings) {
    const key = `${rating.raterId}|${rating.articleId}`;
    const article = input.articles.get(rating.articleId);
    if (seen.has(key) || article === undefined) continue;
    seen.add(key);
    expected += 1;
    const b = base.scores.get(key) ?? null;
    const r = replay.scores.get(key) ?? null;
    rated.push({
      key,
      raterId: rating.raterId,
      contextId: rating.raterId,
      participantKey: participantOf.get(rating.raterId) ?? rating.raterId,
      articleId: rating.articleId,
      lang: article.lang,
      // Not read by the macro or the bootstrap (the replay compares the run's whole cohort).
      split: 'dev',
      groupId: article.storyGroupId,
      firstSeenAt: 0,
      liked: rating.rating === 1,
      title: null,
    });
    if (b !== null) baseValid += 1;
    if (r !== null) replayValid += 1;
    const cards = cardsByRater.get(rating.raterId) ?? [];
    const answersOf = (index: typeof base) =>
      Object.fromEntries(
        [
          ...(index.cards.get(rating.articleId) ??
            new Map<string, { p: number; engine: string }>()),
          ...(index.cards.get(`${rating.articleId}|${rating.raterId}`) ??
            new Map<string, { p: number; engine: string }>()),
        ]
          .filter(
            ([cardId]) => !index.ownFailed.has(`${rating.articleId}|${rating.raterId}|${cardId}`),
          )
          .map(([cardId, a]) => [
            cardId,
            { p: a.p, engine: a.engine === 'llm' ? 'llm' : 'typesafe' },
          ]),
      ) as CardAnswers;
    const laneBase = policyLane(cards, answersOf(base), b, input.baseRanker);
    const laneReplay = policyLane(cards, answersOf(replay), r, input.replayRanker);
    laneTotal += 1;
    if (laneBase !== laneReplay) laneChanged += 1;
    const liked = rating.rating === 1;
    for (const [side, lane] of [
      ['base', laneBase],
      ['replay', laneReplay],
    ] as const) {
      const p = policy[side];
      p.items += 1;
      if (liked) p.liked += 1;
      if (lane === 'maybe') {
        p.maybe += 1;
        if (liked) p.maybeLiked += 1;
      }
      if (liked && lane === 'hidden') p.hardHideFalseNegatives += 1;
      if (lane === 'for_you') {
        p.forYou += 1;
        if (liked) p.forYouLiked += 1;
      }
    }
    if (b === null || r === null) continue;
    const cellKey = `${rating.raterId}|${article.lang}`;
    const cell = cellItems.get(cellKey) ?? {
      raterId: rating.raterId,
      lang: article.lang,
      items: [],
    };
    cell.items.push({ label: liked ? 1 : 0, base: b, replay: r, group: article.storyGroupId });
    cellItems.set(cellKey, cell);
  }

  const cells: ReplayCell[] = [...cellItems.values()]
    .sort((a, b) => compareBigIntStrings(a.raterId, b.raterId) || a.lang.localeCompare(b.lang))
    .map((cell) => {
      const auc = pairedAuc(cell.items, {
        seed: `${input.config.seed}|${cell.raterId}|${cell.lang}`,
      });
      return {
        raterId: cell.raterId,
        lang: cell.lang,
        auc,
        eligible:
          auc.n >= MIN_CELL_ITEMS &&
          auc.positives >= MIN_CELL_CLASS &&
          auc.negatives >= MIN_CELL_CLASS,
      };
    });
  const eligible = cells.filter((cell) => cell.eligible);
  // The macro no-drop rule uses the gate's aggregation: context cells, hierarchical macro and the
  // paired story-group bootstrap (report/ranking.ts), so a replay and the gate agree.
  const contextCells = buildCells(rated, 'context');
  const scoreFrom =
    (index: typeof base): ScoreFn =>
    (item) =>
      index.scores.get(item.key) ?? null;
  const macroBase = macroAuc(contextCells, scoreFrom(base));
  const macroReplay = macroAuc(contextCells, scoreFrom(replay));
  const delta = pairedMacroDelta(contextCells, scoreFrom(replay), scoreFrom(base), {
    seed: `${input.config.seed}|macro`,
  });
  const macro = {
    base: macroBase.value,
    replay: macroReplay.value,
    delta: delta.estimate,
    ci: delta.lo === null || delta.hi === null ? null : ([delta.lo, delta.hi] as [number, number]),
    participants: macroReplay.participants,
  };

  // Mean |Δp| per question key.
  const sums = new Map<string, { sum: number; n: number }>();
  const add = (key: string, delta: number) => {
    const entry = sums.get(key) ?? { sum: 0, n: 0 };
    entry.sum += Math.abs(delta);
    entry.n += 1;
    sums.set(key, entry);
  };
  for (const [key, answer] of base.enrich) {
    const other = replay.enrich.get(key);
    if (other === undefined) continue;
    const a = comparable(answer, answer);
    const b = comparable(other, answer);
    if (a !== null && b !== null) add(key.slice(key.indexOf('|') + 1), b - a);
  }
  for (const [at, map] of base.cards) {
    const other = replay.cards.get(at);
    for (const [cardId, answer] of map) {
      const p = other?.get(cardId)?.p;
      if (p !== undefined) add('card', p - answer.p);
    }
  }
  const deltaP = [...sums]
    .map(([key, { sum, n }]) => ({ key, meanAbs: n === 0 ? 0 : sum / n, n }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const reasons: string[] = [];
  let verdict: ReplayDiff['verdict'] = 'pass';
  if (input.replayStatus !== 'complete') {
    verdict = 'inconclusive';
    reasons.push(`the replay is ${input.replayStatus}, not complete`);
  }
  if (baseValid < expected) {
    verdict = 'inconclusive';
    reasons.push(`base output coverage ${baseValid}/${expected} is incomplete`);
  }
  if (replayValid < expected) {
    verdict = 'inconclusive';
    reasons.push(`replay output coverage ${replayValid}/${expected} is incomplete`);
  }
  if (eligible.length === 0) {
    verdict = 'inconclusive';
    reasons.push('no rater/language cell has enough support (≥ 20 items, ≥ 5 of each class)');
  }
  // Every evaluated cell (one with an item both sides scored) needs support: an unsupported one
  // has no regression check, so the replay cannot pass (spec 10 §6, D-113 addendum).
  const unsupported = eligible.length === 0 ? [] : cells.filter((cell) => !cell.eligible);
  if (verdict !== 'inconclusive') {
    for (const cell of eligible) {
      if (cell.auc.delta !== null && cell.auc.delta < -MAX_CELL_AUC_DROP) {
        verdict = 'fail';
        reasons.push(
          `rater ${cell.raterId} ${cell.lang}: AUC drops by ${(-cell.auc.delta).toFixed(3)}`,
        );
      }
    }
    if (macro.delta !== null && macro.delta < 0) {
      verdict = 'fail';
      reasons.push(`macro AUC drops by ${(-macro.delta).toFixed(3)}`);
    }
  }
  if (verdict !== 'inconclusive' && input.keywordBaseline !== true) {
    const fnRate = (p: typeof policy.base) =>
      p.liked === 0 ? 0 : p.hardHideFalseNegatives / p.liked;
    if (fnRate(policy.replay) > fnRate(policy.base)) {
      verdict = 'fail';
      reasons.push('the hard-hide false-negative rate increases');
    }
    const precision = (p: typeof policy.base) => (p.forYou === 0 ? null : p.forYouLiked / p.forYou);
    const pb = precision(policy.base);
    const pr = precision(policy.replay);
    if (pb !== null && pr === null) {
      // The replay eliminates the lane the baseline filled: a fall to no precision at all.
      verdict = 'fail';
      reasons.push(`the For You lane is emptied (precision ${pb.toFixed(3)} → none)`);
    } else if (pb !== null && pr !== null && pb - pr > MAX_FOR_YOU_PRECISION_DROP) {
      verdict = 'fail';
      reasons.push(`For You precision falls by ${(pb - pr).toFixed(3)}`);
    } else if (pb === null && pr === null && verdict === 'pass') {
      verdict = 'inconclusive';
      reasons.push('For You precision is unsupported: the lane is empty on both sides');
    }
  }
  if (verdict === 'pass' && unsupported.length > 0) {
    // A measured regression still fails; otherwise the unsupported cells make it inconclusive.
    verdict = 'inconclusive';
    reasons.push(
      `unsupported rater/language cell(s) (< ${MIN_CELL_ITEMS} items or < ${MIN_CELL_CLASS} of a class): ` +
        unsupported
          .map(
            (cell) =>
              `rater ${cell.raterId} ${cell.lang} (${cell.auc.n} items, ${cell.auc.positives}/${cell.auc.negatives})`,
          )
          .join(', '),
    );
  }
  return {
    cells,
    macro,
    deltaP,
    laneChange: { changed: laneChanged, total: laneTotal },
    policy,
    coverage: { base: baseValid, replay: replayValid, expected },
    verdict,
    reasons,
  };
}

// ── The markdown report ─────────────────────────────────────────────────────────────────────────

const fmt = (value: number | null, digits = 3) => (value === null ? '—' : value.toFixed(digits));
const share = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)} %`);

export function renderReplayReport(input: {
  baseRunId: string;
  baseExperiment: string;
  replayRunId: string;
  config: RunConfig;
  change: RunConfig['replay'] | null;
  engine: RunEngine;
  run: RunExperimentResult;
  diff: ReplayDiff;
}): string {
  const { config, diff } = input;
  const lines: string[] = [];
  lines.push(`# Replay ${input.replayRunId} vs run ${input.baseRunId} (${input.baseExperiment})`);
  lines.push('');
  lines.push(
    `- Dataset: \`${config.datasetVersion}\` (snapshot \`${config.snapshotSha ?? '—'}\`, split \`${config.splitSha ?? '—'}\`)`,
  );
  lines.push(`- Compared run config: \`${config.configSha}\``);
  const thresholds = input.change?.thresholds ?? null;
  lines.push(
    `- Change: engine \`${input.engine.provider}\`, model \`${input.engine.model}\`, ` +
      `question set \`${input.change?.questionSet ?? ENRICH_V1.version}\`, thresholds ` +
      (thresholds === null ? 'unchanged' : `\`${JSON.stringify(thresholds)}\` (replay side only)`),
  );
  if (input.change?.baseline === 'keyword') {
    lines.push(
      `- Baseline: the ${input.baseExperiment} keyword baseline of a first LLM fallback enablement ` +
        '(spec 10 §6); the replay side is the fallback classifier on E1’s variant. Only the AUC ' +
        'rules apply: the keyword baseline has no card answers, so its lane rows are informational.',
    );
  }
  if (input.change?.baseRanker !== undefined) {
    const source =
      input.change.baseRankerSource === 'settings'
        ? 'the stored `ranker.thresholds` at replay time (the base run predates recorded thresholds)'
        : 'the base run';
    lines.push(
      `- Baseline ranker (from ${source}): lanes \`${JSON.stringify(input.change.baseRanker['lanes'] ?? null)}\`; ` +
        `replay ranker lanes \`${JSON.stringify(input.change.replayRanker?.['lanes'] ?? null)}\``,
    );
  }
  lines.push(`- Replay status: **${input.run.status}**`);
  const cost = input.run.results?.cost;
  if (cost !== undefined) {
    lines.push(
      `- Cost: estimated $${cost.estimatedUsd.toFixed(4)}, billed $${cost.billedUsd.toFixed(4)}, ` +
        `${cost.cacheHits} cache hit(s), savings $${cost.cacheSavingsUsd.toFixed(4)}`,
    );
  }
  lines.push(
    `- Output coverage: base ${diff.coverage.base}/${diff.coverage.expected}, replay ${diff.coverage.replay}/${diff.coverage.expected}`,
  );
  lines.push('');
  lines.push(`## Verdict: ${diff.verdict.toUpperCase()}`);
  lines.push('');
  if (diff.reasons.length === 0) lines.push('No eligible cell regresses (spec 10 §6 pass rule).');
  for (const reason of diff.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push(
    'Replays of a repeatedly viewed test set are regression checks, not new independent quality proof.',
  );
  lines.push('');
  lines.push('## ΔAUC per rater and language');
  lines.push('');
  lines.push(
    '| Rater | Lang | n | likes | dislikes | AUC base | AUC replay | ΔAUC | 95 % CI (paired story-group bootstrap) | Eligible |',
  );
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const cell of diff.cells) {
    const ci = cell.auc.ci === null ? '—' : `[${fmt(cell.auc.ci[0])}, ${fmt(cell.auc.ci[1])}]`;
    lines.push(
      `| ${cell.raterId} | ${cell.lang} | ${cell.auc.n} | ${cell.auc.positives} | ${cell.auc.negatives} | ${fmt(cell.auc.base)} | ${fmt(cell.auc.replay)} | ${fmt(cell.auc.delta)} | ${ci} | ${cell.eligible ? 'yes' : 'no (unsupported)'} |`,
    );
  }
  lines.push('');
  lines.push(
    `Macro AUC (hierarchical, as the gate: supported contexts within ${diff.macro.participants} participant(s), then participants): ` +
      `base ${fmt(diff.macro.base)}, replay ${fmt(diff.macro.replay)}, Δ ${fmt(diff.macro.delta)}` +
      (diff.macro.ci === null
        ? '.'
        : `, 95 % CI [${fmt(diff.macro.ci[0])}, ${fmt(diff.macro.ci[1])}] (paired story-group bootstrap).`),
  );
  lines.push('');
  lines.push('## Mean |Δp| per question key');
  lines.push('');
  lines.push('| Key | n | mean abs Δ |');
  lines.push('|---|---:|---:|');
  for (const row of diff.deltaP)
    lines.push(`| \`${row.key}\` | ${row.n} | ${fmt(row.meanAbs, 4)} |`);
  lines.push('');
  lines.push('Noul: |Δp|; Score: |Δscore|; Choice: |Δ probability of the base choice|.');
  lines.push('');
  lines.push('## Lanes and policy');
  lines.push('');
  lines.push(
    `- Items changing lane: ${diff.laneChange.changed}/${diff.laneChange.total} (${share(diff.laneChange.changed, diff.laneChange.total)})`,
  );
  for (const side of ['base', 'replay'] as const) {
    const p = diff.policy[side];
    lines.push(
      `- ${side}: hard-hide false negatives ${p.hardHideFalseNegatives}/${p.liked} (${share(p.hardHideFalseNegatives, p.liked)}), ` +
        `For You precision ${p.forYouLiked}/${p.forYou} (${share(p.forYouLiked, p.forYou)}), ` +
        `Maybe share ${p.maybe}/${p.items} (${share(p.maybe, p.items)}; liked ${p.maybeLiked})`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
