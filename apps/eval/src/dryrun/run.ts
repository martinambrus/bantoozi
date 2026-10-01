import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dropDryRunDatabase, getRun, loadRunAnswers, type Executor } from '@bantoozi/db';
import {
  startFakeLibreTranslate,
  startFakeOllama,
  startFakeTypeSafe,
  type FakeLibreTranslate,
  type FakeOllamaServer,
  type FakeTypeSafeServer,
} from '@bantoozi/testing';

import { runGate, type GateRunResult } from '../commands/gate.js';
import { EXPERIMENT_IDS, type ExperimentId } from '../experiments/definitions.js';
import { rocAuc } from '../experiments/paired-auc.js';
import { parseRunConfig } from '../experiments/run-config.js';
import { runExperiment } from '../experiments/runner.js';
import { REPOSITORY_ROOT } from '../experiments/util.js';
import { loadDataset, loadReportModel } from '../report/load.js';
import { isoDate, REPORTS_DIR } from '../report/paths.js';
import { renderEvaluationReport } from '../report/render.js';
import { createEvalRuntime, type EvalIo, type EvalRuntime } from '../runtime.js';
import { createDryRunDatabase, DEFAULT_DRYRUN_DATABASE, type DryRunDatabase } from './database.js';
import { populate, type PopulateResult } from './populate.js';
import { cardTranslations, generateCorpus } from './synthetic.js';

/**
 * `eval dry-run` (spec 10 §3 "Other commands", M3a-T8): the whole evaluation pipeline on synthetic
 * data, in its own database, against the in-process fake TypeSafe, LibreTranslate and Ollama.
 *
 * 1. (Re)create `bantoozi_eval_dryrun` from the migrated template and seed it (`database.ts`).
 * 2. Generate the synthetic corpus and raters, then collect, sample, assign, rate and label them
 *    (`synthetic.ts`, `populate.ts`).
 * 3. Run every experiment of spec 10 §3 through `runExperiment` (E5 records `skipped`).
 * 4. Run the gate (`runGate(..., { dryRun: true })`) and the evaluation report.
 * 5. Write `apps/eval/reports/DRYRUN-<date>.md` (the gate report), `DRYRUN-<date>.g1.json` (when
 *    the profile is ready; marked `dryRun`) and `DRYRUN-<date>.report.md` (the §4 report), and
 *    print the decision table.
 *
 * It never connects to `DATABASE_URL_WORKER` or any other database than the dry-run one.
 */

export interface DryRunOptions {
  /** Default `bantoozi_eval_dryrun`; tests use a suffixed name. */
  database?: string;
  seed?: string;
  /** Synthetic articles generated per language. */
  articlesPerLang?: number;
  feedsPerLang?: number;
  /** Articles `eval sample` draws per language. */
  samplePerLang?: number;
  assignmentsPerRater?: number;
  facetsPerLang?: number;
  facetOverlap?: number;
  profile?: 'owner_pilot' | 'multi_person_beta';
  resamples?: number;
  maxUsd?: number;
  /** Output directory (default `apps/eval/reports`). */
  outDir?: string;
  /** Drop the database at the end (tests). */
  dropAfter?: boolean;
  /** The process environment (admin URL, role passwords, `EVAL_CACHE_DIR`, `LOG_LEVEL`). */
  env: NodeJS.ProcessEnv;
  io: EvalIo;
  now?: () => Date;
}

export interface DryRunResult {
  database: string;
  version: string;
  runs: Partial<Record<ExperimentId, { runId: string | null; status: string }>>;
  /** Macro ROC AUC over raters (every rated pair of the run), per experiment. */
  auc: Partial<Record<ExperimentId, number | null>>;
  gate: GateRunResult;
  reportPath: string;
  g1Path: string | null;
  evalReportPath: string;
  raters: Array<{
    raterId: string;
    name: string;
    assigned: number;
    likes: number;
    dislikes: number;
  }>;
}

export const DRYRUN_DEFAULTS = {
  seed: 'dryrun-v1',
  articlesPerLang: 320,
  feedsPerLang: 12,
  samplePerLang: 300,
  assignmentsPerRater: 300,
  facetsPerLang: 40,
  facetOverlap: 30,
  profile: 'multi_person_beta',
  resamples: 1000,
  maxUsd: 5,
} as const;

const FAKE_TYPESAFE_KEY = 'dry-run-typesafe-key';
const FAKE_OLLAMA_KEY = 'dry-run-ollama-key';

/** Macro AUC over raters of one run's `score.r<rater>` rows against its frozen ratings. */
export async function runMacroAuc(db: Executor, runId: string): Promise<number | null> {
  const run = await getRun(db, runId);
  if (run === null) return null;
  const config = parseRunConfig(run.config);
  const scores = new Map<string, number>();
  for (const row of await loadRunAnswers(db, runId, { keyPrefix: 'score.r' })) {
    const score = (row.answer as { score?: unknown }).score;
    if (typeof score === 'number') {
      scores.set(`${row.questionKey.slice('score.r'.length)}|${row.articleId}`, score);
    }
  }
  const byRater = new Map<string, { scores: number[]; labels: (0 | 1)[] }>();
  for (const rating of config.ratings) {
    const score = scores.get(`${rating.raterId}|${rating.articleId}`);
    if (score === undefined) continue;
    const cell = byRater.get(rating.raterId) ?? { scores: [], labels: [] };
    cell.scores.push(score);
    cell.labels.push(rating.rating === 1 ? 1 : 0);
    byRater.set(rating.raterId, cell);
  }
  const aucs = [...byRater.values()]
    .map((cell) => rocAuc(cell.scores, cell.labels))
    .filter((v): v is number => v !== null);
  return aucs.length === 0 ? null : aucs.reduce((s, v) => s + v, 0) / aucs.length;
}

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const settings = { ...DRYRUN_DEFAULTS, ...definedOnly(options) };
  const now = options.now ?? (() => new Date());
  const name = options.database ?? DEFAULT_DRYRUN_DATABASE;
  const say = (text: string) => options.io.out(text);

  say(`dry-run: creating database ${name} from the migrated template and seeding it\n`);
  const database = await createDryRunDatabase({ name, env: options.env });
  const corpus = generateCorpus({
    seed: settings.seed,
    perLang: settings.articlesPerLang,
    feedsPerLang: settings.feedsPerLang,
    now: now(),
    days: 30,
  });

  let typesafe: FakeTypeSafeServer | undefined;
  let libretranslate: FakeLibreTranslate | undefined;
  let ollama: FakeOllamaServer | undefined;
  let rt: EvalRuntime | undefined;
  try {
    [typesafe, libretranslate, ollama] = await Promise.all([
      startFakeTypeSafe({ apiKey: FAKE_TYPESAFE_KEY, recordRequests: false }),
      startFakeLibreTranslate({
        translations: { ...corpus.translations, ...cardTranslations() },
      }),
      startFakeOllama({ apiKey: FAKE_OLLAMA_KEY, recordRequests: false }),
    ]);
    rt = dryRunRuntime(database, options, { typesafe, libretranslate, ollama }, now);

    say(
      `dry-run: ${corpus.articles.length} synthetic articles in ${corpus.feeds.length} feeds; ` +
        'sampling, assigning, rating and labelling\n',
    );
    const populated = await populate(rt.db, corpus, {
      seed: settings.seed,
      samplePerLang: settings.samplePerLang,
      assignmentsPerRater: settings.assignmentsPerRater,
      facetsPerLang: settings.facetsPerLang,
      facetOverlap: settings.facetOverlap,
      now: now(),
    });
    for (const r of populated.raters) {
      say(
        `  rater ${r.raterId} ${r.persona.name} (${r.persona.langs.join(',')}): ` +
          `${r.assigned} rated, ${r.likes} likes, ${r.dislikes} dislikes\n`,
      );
    }

    const runs: DryRunResult['runs'] = {};
    const auc: DryRunResult['auc'] = {};
    for (const experiment of EXPERIMENT_IDS) {
      const result = await runExperiment(rt, {
        experiment,
        datasetVersion: populated.version,
        yes: true,
        maxUsd: settings.maxUsd,
        gitSha: 'dry-run',
      });
      runs[experiment] = { runId: result.runId, status: result.status };
      if (result.runId !== null && result.status !== 'skipped') {
        auc[experiment] = await runMacroAuc(rt.db, result.runId);
      }
    }

    const outDir = path.resolve(REPOSITORY_ROOT, settings.outDir ?? REPORTS_DIR);
    const date = isoDate(now());
    const reportPath = path.join(outDir, `DRYRUN-${date}.md`);
    const g1Target = path.join(outDir, `DRYRUN-${date}.g1.json`);
    const gate = await runGate(
      rt,
      {
        profile: settings.profile,
        dataset: populated.version,
        report: reportPath,
        g1: g1Target,
        resamples: settings.resamples,
        dailyRevisions: 1000,
        notes: 'Dry run on synthetic data (M3a-T8): not evidence about real readers.',
      },
      { dryRun: true },
    );

    const evalReportPath = path.join(outDir, `DRYRUN-${date}.report.md`);
    const loaded = await loadDataset(rt.db, populated.version);
    const model = await loadReportModel(rt.db, loaded);
    const markdown = renderEvaluationReport(model, {
      title: `Dry-run evaluation report — ${loaded.dataset.version} (synthetic data)`,
      splits: ['dev', 'test'],
      settings: { seed: loaded.dataset.seed, resamples: settings.resamples },
      baselineExperiment: 'B1',
      generatedAt: now(),
    });
    await mkdir(outDir, { recursive: true });
    await writeFile(evalReportPath, markdown, 'utf8');

    say('\n');
    say(gate.summary);
    say('\nmacro AUC over raters (all rated pairs, synthetic data):\n');
    for (const experiment of EXPERIMENT_IDS) {
      const run = runs[experiment];
      if (run === undefined) continue;
      const value = auc[experiment];
      say(
        `  ${experiment.padEnd(5)} ${run.status.padEnd(9)} ` +
          `${value === undefined || value === null ? '—' : value.toFixed(3)}\n`,
      );
    }
    say(`\nreport: ${gate.reportPath}\n`);
    say(`g1.json: ${gate.g1Path ?? 'not written (readiness not met)'}\n`);
    say(`evaluation report: ${evalReportPath}\n`);
    return {
      database: name,
      version: populated.version,
      runs,
      auc,
      gate,
      reportPath: gate.reportPath,
      g1Path: gate.g1Path,
      evalReportPath,
      raters: raterSummary(populated),
    };
  } finally {
    await rt?.close();
    await Promise.all([typesafe?.close(), libretranslate?.close(), ollama?.close()]);
    if (options.dropAfter === true) {
      await dropDryRunDatabase({ adminUrl: database.adminUrl, name: database.name });
    }
  }
}

function raterSummary(populated: PopulateResult): DryRunResult['raters'] {
  return populated.raters.map((r) => ({
    raterId: r.raterId,
    name: r.persona.name,
    assigned: r.assigned,
    likes: r.likes,
    dislikes: r.dislikes,
  }));
}

function definedOnly(options: DryRunOptions) {
  const out: Partial<Omit<typeof DRYRUN_DEFAULTS, 'profile'>> & {
    profile?: 'owner_pilot' | 'multi_person_beta';
    outDir?: string;
  } = {};
  const keys = [
    'seed',
    'articlesPerLang',
    'feedsPerLang',
    'samplePerLang',
    'assignmentsPerRater',
    'facetsPerLang',
    'facetOverlap',
    'resamples',
    'maxUsd',
  ] as const;
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  if (options.profile !== undefined) out.profile = options.profile;
  if (options.outDir !== undefined) out.outDir = options.outDir;
  return out;
}

/** The eval runtime over the dry-run database, pointed at the in-process fakes. */
function dryRunRuntime(
  database: DryRunDatabase,
  options: DryRunOptions,
  fakes: {
    typesafe: FakeTypeSafeServer;
    libretranslate: FakeLibreTranslate;
    ollama: FakeOllamaServer;
  },
  now: () => Date,
): EvalRuntime {
  return createEvalRuntime({
    env: {
      ...options.env,
      DATABASE_URL_WORKER: database.workerUrl,
      TYPESAFE_BASE_URL: fakes.typesafe.url,
      TYPESAFE_MODEL: 'jev-fake',
      TYPESAFE_API_KEY: FAKE_TYPESAFE_KEY,
      LIBRETRANSLATE_URL: fakes.libretranslate.url,
      OLLAMA_BASE_URL: fakes.ollama.url,
      OLLAMA_API_KEY: FAKE_OLLAMA_KEY,
      LOG_LEVEL: options.env['LOG_LEVEL'] ?? 'warn',
    },
    io: options.io,
    now,
    poolMax: 6,
  });
}

export { DEFAULT_DRYRUN_DATABASE };
export type { DryRunDatabase };
