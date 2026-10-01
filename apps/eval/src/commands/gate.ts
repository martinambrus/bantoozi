import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createGateLock,
  currentDatabaseName,
  findGateLocks,
  isDryRunDatabaseName,
  lockGateManifest,
  recordGateOutcome,
  type RunRow,
} from '@bantoozi/db';
import { sha256Hex } from '@bantoozi/shared/server';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import type { Profile } from '../report/decision.js';
import {
  assessGateRuns,
  buildG1,
  confirmOnTest,
  developmentInput,
  gateReadiness,
  GATE_EXPERIMENTS,
  selectOnDevelopment,
  type GateSelection,
  type TestConfirmation,
} from '../report/gate.js';
import { renderGateReport } from '../report/gate-report.js';
import { G1Schema, type G1File } from '../report/g1-schema.js';
import { loadDataset, loadReportModel } from '../report/load.js';
import { buildReportModel, latestRuns, pickReference } from '../report/model.js';
import { DEFAULT_G1_PATH, defaultGateReportPath, resolveRepoPath } from '../report/paths.js';
import type { RunData } from '../report/run-data.js';
import { EvalCommandError, type EvalRuntime } from '../runtime.js';

/**
 * `eval gate --profile owner_pilot|multi_person_beta` (spec 10 §3, §5; M3a-T7). In order:
 *
 * 1. validate the frozen dataset and the chosen runs (dataset/split hashes, cohort, ground truth,
 *    completeness, pinned engine, ≥95 % coverage);
 * 2. profile readiness from label counts — not met: an honest incomplete report, no g1.json, and the
 *    test split is never revealed;
 * 3. select on development only and lock the profile and the selection's config hash in an
 *    `eval.runs` lock row (D-106) — a rerun with another profile or another selection on the same
 *    manifest is refused;
 * 4. only then confirm on test, write `apps/eval/reports/G1-<date>.md` and `apps/eval/config/g1.json`.
 *
 * `--profile` is mandatory. A gate on the dry-run database marks its artifact `dryRun`.
 */
const OptionsSchema = z.object({
  profile: z.enum(['owner_pilot', 'multi_person_beta']),
  dataset: z.string().min(1).optional(),
  runs: z.string().optional(),
  g1: z.string().min(1).optional(),
  report: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  resamples: z.coerce.number().int().min(1).max(100_000).default(1000),
  dailyRevisions: z.coerce.number().int().min(1).max(10_000_000).default(1000),
  notes: z.string().max(10_000).default(''),
});
export type GateOptions = z.output<typeof OptionsSchema>;

export interface GateRunResult {
  status: 'pass' | 'fail' | 'needs_more_data';
  reportPath: string;
  g1Path: string | null;
  g1: G1File | null;
  selection: GateSelection | null;
  confirmation: TestConfirmation | null;
  /** The printable decision table. */
  summary: string;
}

/** `--runs B1=12,E1=13`: explicit run ids per experiment. */
export function parseRunOverrides(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined || value.trim() === '') return result;
  for (const part of value.split(',')) {
    const match = /^\s*([A-Za-z0-9-]+)\s*=\s*([1-9]\d{0,18})\s*$/.exec(part);
    if (match === null || !(GATE_EXPERIMENTS as readonly string[]).includes(match[1] ?? '')) {
      throw new EvalCommandError(`invalid --runs entry "${part}" (expected <experiment>=<run id>)`);
    }
    result.set(match[1] as string, match[2] as string);
  }
  return result;
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function decisionTable(g1: G1File | null, status: string, selection: GateSelection | null): string {
  const lines = [`G1 ${status.toUpperCase()}`];
  if (selection !== null) {
    lines.push(`  baseline           ${selection.baseline ?? '—'}`);
    lines.push(`  E*                 ${selection.core ?? '—'}`);
    lines.push(
      `  composition        ${Object.entries(selection.composition)
        .map(([l, e]) => `${l}=${e}`)
        .join(' ')}`,
    );
  }
  if (g1 !== null) {
    lines.push(`  card_text_mode     ${g1.card_text_mode}`);
    lines.push(`  language_modes     ${JSON.stringify(g1.language_modes)}`);
    lines.push(`  ranker_thresholds  ${JSON.stringify(g1.ranker_thresholds)}`);
    lines.push(`  daily budget       $${g1.recommended_daily_budget_usd.toFixed(2)}`);
    lines.push(`  tier-2 cap         ${g1.translate_tier2_daily_cap}`);
    lines.push(`  Laya track         ${g1.laya_track_recommended ? 'recommended' : 'no'}`);
    lines.push(`  profile            ${g1.gate.profile} (${g1.gate.participants} participant(s))`);
  }
  return `${lines.join('\n')}\n`;
}

/** The whole gate over a runtime; `eval dry-run` calls it on its own database. */
export async function runGate(
  rt: Pick<EvalRuntime, 'db' | 'now'>,
  options: GateOptions,
  overrides: { dryRun?: boolean } = {},
): Promise<GateRunResult> {
  const profile: Profile = options.profile;
  const loaded = await loadDataset(rt.db, options.dataset);
  const base = await loadReportModel(rt.db, loaded);
  const chosen = latestRuns(loaded.runs);
  for (const [experiment, id] of parseRunOverrides(options.runs)) {
    const run = loaded.runs.find((r) => r.id === id);
    if (run === undefined || run.experiment !== experiment) {
      throw new EvalCommandError(
        `run ${id} is not a ${experiment} run of ${loaded.dataset.version}`,
      );
    }
    chosen.set(experiment, run);
  }
  const reference: RunData | null = chosen.get('E1') ?? pickReference([...chosen.values()]);
  const model = buildReportModel({
    datasetVersion: loaded.dataset.version,
    runs: loaded.runs,
    sample: loaded.sample,
    reference,
    assignmentCounts: base.assignmentCounts,
  });
  const dataset = {
    version: loaded.dataset.version,
    snapshotSha: loaded.dataset.snapshotSha,
    splitSha: loaded.dataset.splitSha,
  };
  const dryRun =
    overrides.dryRun === true || isDryRunDatabaseName(await currentDatabaseName(rt.db));
  const assessments = assessGateRuns(model, chosen, dataset);
  const readiness = gateReadiness(model, profile);
  const settings = { seed: options.seed ?? loaded.dataset.seed, resamples: options.resamples };
  const now = rt.now();
  const reportPath =
    options.report === undefined ? defaultGateReportPath(now) : resolveRepoPath(options.report);

  let selection: GateSelection | null = null;
  let confirmation: TestConfirmation | null = null;
  let lock: RunRow | null = null;
  let status: GateRunResult['status'] = 'needs_more_data';
  if (readiness.ready) {
    selection = selectOnDevelopment(
      developmentInput(model, assessments, profile, dataset, options.dailyRevisions),
    );
    if (selection.status === 'selected') {
      const cohortSha = reference?.config.cohort.sha ?? '';
      const sel = selection;
      lock = await rt.db.transaction(async (tx) => {
        await lockGateManifest(tx, dataset.version);
        // One lock fences the holdout for every cohort: `eval report` reveals the version's whole
        // test split once any lock exists, so a selection under another manifest (another cohort)
        // would be made after its test metrics could be read (D-106).
        const locks = await findGateLocks(tx, dataset.version);
        const sameManifest = (l: RunRow) => {
          const c = l.config as { cohortSha?: unknown; snapshotSha?: unknown; splitSha?: unknown };
          return (
            c.cohortSha === cohortSha &&
            c.snapshotSha === dataset.snapshotSha &&
            c.splitSha === dataset.splitSha
          );
        };
        const foreign = locks.find((l) => !sameManifest(l));
        if (foreign !== undefined) {
          throw new EvalCommandError(
            `${dataset.version} is already locked for another cohort or split (lock run ${foreign.id}) and its test split is revealed; a selection for a different cohort needs a new held-out dataset version`,
          );
        }
        const existing = locks;
        for (const l of existing) {
          const c = l.config as { profile?: unknown; configSha?: unknown };
          if (c.profile !== profile) {
            throw new EvalCommandError(
              `this manifest was locked as ${String(c.profile)} (lock run ${l.id}); a profile switch after the test reveal needs a new held-out dataset version`,
            );
          }
          if (c.configSha !== sel.configSha) {
            throw new EvalCommandError(
              `the development selection differs from the one locked in run ${l.id}; changing the selection after the test reveal needs a new held-out dataset version`,
            );
          }
        }
        return (
          existing[0] ??
          createGateLock(tx, {
            gitSha: gitSha(),
            config: {
              profile,
              datasetVersion: dataset.version,
              snapshotSha: dataset.snapshotSha,
              splitSha: dataset.splitSha,
              cohortSha,
              configSha: sel.configSha,
              developmentRunIds: sel.developmentRunIds,
              dryRun,
            },
          })
        );
      });
      confirmation = confirmOnTest(model, assessments, selection, settings);
      status = confirmation.decision.status;
    }
  }

  const markdown = renderGateReport({
    model,
    readiness,
    runs: assessments,
    selection,
    confirmation,
    status,
    lockedAt: lock?.startedAt ?? null,
    generatedAt: now,
    settings,
    dryRun,
  });
  const reportSha = sha256Hex(markdown);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdown, 'utf8');

  let g1: G1File | null = null;
  let g1Path: string | null = null;
  if (selection !== null) {
    g1 = G1Schema.parse(
      buildG1({
        selection,
        status,
        participants: readiness.participants,
        lockedAt: lock?.startedAt ?? now,
        reportSha,
        notes: [
          options.notes,
          readiness.profile === 'owner_pilot'
            ? 'owner_pilot: one actual participant; one-person evidence, not multi-person validation.'
            : '',
          readiness.unmeasuredLangs.length > 0
            ? `Unmeasured languages (defaults kept, unvalidated): ${readiness.unmeasuredLangs.join(', ')}.`
            : '',
          ...(confirmation?.decision.reasons ?? selection.reasons),
        ]
          .filter((n) => n !== '')
          .join(' '),
        dryRun,
      }),
    );
    g1Path = resolveRepoPath(options.g1 ?? DEFAULT_G1_PATH);
    await mkdir(path.dirname(g1Path), { recursive: true });
    await writeFile(g1Path, `${JSON.stringify(g1, null, 2)}\n`, 'utf8');
    if (lock !== null) {
      await recordGateOutcome(rt.db, lock.id, {
        status,
        reportSha,
        // The participant count g1.json claims, authenticated here for `apply-g1` (D-108).
        participants: readiness.participants,
        macroAuc: confirmation?.macro ?? null,
        baselineMacroAuc: confirmation?.baselineMacro ?? null,
      });
    }
  }
  return {
    status,
    reportPath,
    g1Path,
    g1,
    selection,
    confirmation,
    summary: decisionTable(g1, status, selection),
  };
}

export function registerGate(program: Command, ctx: CliContext): void {
  program
    .command('gate')
    .description(describeCommand('gate'))
    .requiredOption('--profile <profile>', 'owner_pilot | multi_person_beta (mandatory)')
    .option('--dataset <version>', 'dataset version (default: the newest frozen one)')
    .option(
      '--runs <list>',
      'explicit runs, e.g. B1=12,E1=13 (default: the latest complete run of each)',
    )
    .option('--g1 <path>', `decision file (default ${DEFAULT_G1_PATH})`)
    .option('--report <path>', 'report file (default apps/eval/reports/G1-<date>.md)')
    .option('--seed <seed>', 'bootstrap seed (default: the dataset seed)')
    .option('--resamples <n>', 'bootstrap resamples', '1000')
    .option('--daily-revisions <n>', 'expected daily authorized article revisions (budget)', '1000')
    .option('--notes <text>', 'notes recorded in g1.json', '')
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      await withRuntime(ctx, async (rt) => {
        const result = await runGate(rt, parsed.data);
        rt.out(result.summary);
        rt.out(`report: ${result.reportPath}\n`);
        rt.out(
          result.g1Path === null
            ? 'g1.json: not written (readiness not met)\n'
            : `g1.json: ${result.g1Path}\n`,
        );
      });
    });
}
