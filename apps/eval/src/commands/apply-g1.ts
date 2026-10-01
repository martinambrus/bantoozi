import { readFile } from 'node:fs/promises';

import {
  applyG1Settings,
  currentDatabaseName,
  findGateLocks,
  getDataset,
  getRun,
} from '@bantoozi/db';
import { LanguageModesSchema, type SettingEnvDefaults } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { g1ConfigSha, G1Schema, type G1File } from '../report/g1-schema.js';
import { resolveRepoPath } from '../report/paths.js';
import { EvalCommandError, type EvalRuntime } from '../runtime.js';

/**
 * `eval apply-g1 <g1.json> [--report <path>]` (spec 10 §1, M3a-T7): applies a passed G1 decision
 * file to the settings of the database it connects to — exactly the keys of the mapping table,
 * in one transaction, with the side-effect intents of the normal settings flow. It refuses a gate
 * other than `pass`, missing or incomplete runs, dataset/config/report hash mismatches, a decision
 * the database's gate lock does not record, and a dry-run artifact outside the dry-run database. A
 * passed `owner_pilot` artifact is accepted like a `multi_person_beta` one; its one-person scope is
 * printed and stays in the report.
 */
export const DRYRUN_DATABASE = 'bantoozi_eval_dryrun';

const OptionsSchema = z.object({ report: z.string().min(1).optional() });

/** Env fallbacks for keys whose row is missing (spec 02 §2), read like the worker reads them. */
export function settingEnvDefaults(env: NodeJS.ProcessEnv = process.env): SettingEnvDefaults {
  const budget = Number(env['DAILY_BUDGET_USD'] ?? '2');
  let modes: SettingEnvDefaults['languageModes'] = { en: 'native', sk: 'native', cs: 'native' };
  try {
    if (env['LANGUAGE_MODES'] !== undefined) {
      modes = LanguageModesSchema.parse(JSON.parse(env['LANGUAGE_MODES']));
    }
  } catch {
    // An invalid env value is the worker's concern; the seeded row normally exists anyway.
  }
  return {
    dailyBudgetUsd: Number.isFinite(budget) ? budget : 2,
    languageModes: modes,
    signupMode: 'invite',
  };
}

/** Every check before any write; returns the reasons for refusal (empty = applicable). */
export async function checkG1(
  rt: Pick<EvalRuntime, 'db'>,
  g1: G1File,
  options: { reportText?: string | undefined } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const database = await currentDatabaseName(rt.db);
  if (g1.dryRun === true && database !== DRYRUN_DATABASE) {
    problems.push(`a dry-run artifact cannot be applied to database ${database}`);
  }
  if (g1.gate.status !== 'pass') problems.push(`gate status is ${g1.gate.status}, not pass`);
  const configSha = g1ConfigSha({ ...g1, profile: g1.gate.profile });
  if (configSha !== g1.selection.configSha)
    problems.push('config hash mismatch: g1.json was edited');
  if (options.reportText !== undefined && sha256Hex(options.reportText) !== g1.gate.reportSha) {
    problems.push('report hash mismatch');
  }
  const dataset = await getDataset(rt.db, g1.dataset.version);
  if (dataset === null) {
    problems.push(`dataset ${g1.dataset.version} does not exist`);
  } else if (
    dataset.frozenAt === null ||
    dataset.snapshotSha !== g1.dataset.snapshotSha ||
    dataset.splitSha !== g1.dataset.splitSha
  ) {
    problems.push(`dataset ${g1.dataset.version} hash mismatch`);
  }
  const runIds = new Set([...Object.values(g1.runs), ...g1.selection.developmentRunIds]);
  const experimentOf = new Map(Object.entries(g1.runs).map(([e, id]) => [id, e]));
  for (const id of runIds) {
    const run = await getRun(rt.db, id);
    if (run === null) {
      problems.push(`run ${id} does not exist`);
      continue;
    }
    const expected = experimentOf.get(id);
    if (expected !== undefined && run.experiment !== expected) {
      problems.push(`run ${id} is ${run.experiment}, not ${expected}`);
    }
    const status = (run.results as { status?: unknown } | null)?.status;
    if (run.finishedAt === null || status !== 'complete') problems.push(`run ${id} is incomplete`);
    const config = run.config as { snapshotSha?: unknown; splitSha?: unknown };
    if (
      run.datasetVersion !== g1.dataset.version ||
      config.snapshotSha !== g1.dataset.snapshotSha ||
      config.splitSha !== g1.dataset.splitSha
    ) {
      problems.push(`run ${id} hash mismatch`);
    }
  }
  const locks = await findGateLocks(rt.db, g1.dataset.version);
  const lock = locks.find(
    (l) => (l.config as { configSha?: unknown }).configSha === g1.selection.configSha,
  );
  const lockResults = (lock?.results ?? null) as {
    status?: unknown;
    reportSha?: unknown;
    participants?: unknown;
  } | null;
  if (lock === undefined) {
    problems.push('no gate lock records this selection');
  } else if (
    (lock.config as { profile?: unknown }).profile !== g1.gate.profile ||
    lockResults?.status !== g1.gate.status ||
    lockResults?.reportSha !== g1.gate.reportSha
  ) {
    problems.push('the gate lock records a different profile, status or report');
  }
  // The participant count is outside the config hash: the lock records it (D-108).
  if (lock !== undefined && lockResults?.participants !== g1.gate.participants) {
    problems.push(
      `participant count mismatch: g1.json claims ${g1.gate.participants}, the gate lock records ${String(lockResults?.participants ?? 'none')}`,
    );
  }
  return problems;
}

export function registerApplyG1(program: Command, ctx: CliContext): void {
  program
    .command('apply-g1')
    .description(describeCommand('apply-g1'))
    .argument('<g1>', 'the G1 decision file, relative to the repository root')
    .option('--report <path>', 'also verify the G1 report against its hash')
    .action(async (file: string, raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(await readFile(resolveRepoPath(file), 'utf8'));
      } catch (error) {
        throw new EvalCommandError(`cannot read ${file}: ${(error as Error).message}`);
      }
      const g1 = G1Schema.safeParse(json);
      if (!g1.success) {
        throw new EvalCommandError(`invalid g1.json: ${z.prettifyError(g1.error)}`);
      }
      const reportText =
        parsed.data.report === undefined
          ? undefined
          : await readFile(resolveRepoPath(parsed.data.report), 'utf8');
      await withRuntime(ctx, async (rt) => {
        const problems = await checkG1(rt, g1.data, { reportText });
        if (problems.length > 0) {
          throw new EvalCommandError(`apply-g1 refused:\n- ${problems.join('\n- ')}`);
        }
        const g = g1.data;
        const result = await rt.db.transaction((tx) =>
          applyG1Settings(
            tx,
            {
              languageModes: g.language_modes,
              cardTextMode: g.card_text_mode,
              rankerThresholds: g.ranker_thresholds,
              dailyBudgetUsd: g.recommended_daily_budget_usd,
              tier2DailyCap: g.translate_tier2_daily_cap,
            },
            { env: settingEnvDefaults(), now: rt.now() },
          ),
        );
        const intents = Object.entries(result.intents)
          .map(([queue, n]) => `${queue} ×${n}`)
          .join(', ');
        rt.out(
          [
            `applied G1 (${g.gate.profile}, ${g.gate.participants} participant(s)${
              g.gate.profile === 'owner_pilot'
                ? ': one-person evidence, not multi-person validation'
                : ''
            })`,
            `changed: ${result.changed.join(', ') || 'nothing (values already current)'}`,
            `ranker.settings_version: ${result.settingsVersion}`,
            `intents: ${intents || 'none'}`,
            '',
          ].join('\n'),
        );
      });
    });
}
