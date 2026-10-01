import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, type CliContext } from '../cli.js';
import { DEFAULT_DRYRUN_DATABASE, DRYRUN_DEFAULTS, runDryRun } from '../dryrun/run.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval dry-run [--db bantoozi_eval_dryrun] [--seed s] [--articles n] [--per-lang n] [--assignments n]
 * [--facets n] [--profile p] [--resamples n] [--max-usd n] [--out-dir dir]` (spec 10 §3, M3a-T8):
 * the whole pipeline on synthetic data in a separate, freshly created database against in-process
 * fakes. It never opens the normal eval runtime (`DATABASE_URL_WORKER`): only the dry-run database
 * is created (through `TEST_ADMIN_DATABASE_URL`), seeded and used.
 */
const count = (max: number) => z.coerce.number().int().min(1).max(max);

const OptionsSchema = z.object({
  db: z.string().min(1).default(DEFAULT_DRYRUN_DATABASE),
  seed: z.string().min(1).optional(),
  articles: count(20_000).optional(),
  perLang: count(10_000).optional(),
  assignments: count(10_000).optional(),
  facets: count(10_000).optional(),
  profile: z.enum(['owner_pilot', 'multi_person_beta']).optional(),
  resamples: count(100_000).optional(),
  maxUsd: z.coerce.number().finite().nonnegative().optional(),
  outDir: z.string().min(1).optional(),
});

export function registerDryRun(program: Command, ctx: CliContext): void {
  program
    .command('dry-run')
    .description(describeCommand('dry-run'))
    .option('--db <name>', `dry-run database (default ${DEFAULT_DRYRUN_DATABASE})`)
    .option('--seed <seed>', `synthetic data seed (default ${DRYRUN_DEFAULTS.seed})`)
    .option(
      '--articles <n>',
      `synthetic articles per language (default ${DRYRUN_DEFAULTS.articlesPerLang})`,
    )
    .option(
      '--per-lang <n>',
      `articles sampled per language (default ${DRYRUN_DEFAULTS.samplePerLang})`,
    )
    .option(
      '--assignments <n>',
      `assignments per rater (default ${DRYRUN_DEFAULTS.assignmentsPerRater})`,
    )
    .option(
      '--facets <n>',
      `facet-labelled articles per language (default ${DRYRUN_DEFAULTS.facetsPerLang})`,
    )
    .option('--profile <profile>', `gate profile (default ${DRYRUN_DEFAULTS.profile})`)
    .option('--resamples <n>', `bootstrap resamples (default ${DRYRUN_DEFAULTS.resamples})`)
    .option('--max-usd <usd>', `invocation cap per experiment (default ${DRYRUN_DEFAULTS.maxUsd})`)
    .option(
      '--out-dir <dir>',
      'output directory relative to the repository root (default apps/eval/reports)',
    )
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const o = parsed.data;
      await runDryRun({
        database: o.db,
        ...(o.seed === undefined ? {} : { seed: o.seed }),
        ...(o.articles === undefined ? {} : { articlesPerLang: o.articles }),
        ...(o.perLang === undefined ? {} : { samplePerLang: o.perLang }),
        ...(o.assignments === undefined ? {} : { assignmentsPerRater: o.assignments }),
        ...(o.facets === undefined ? {} : { facetsPerLang: o.facets }),
        ...(o.profile === undefined ? {} : { profile: o.profile }),
        ...(o.resamples === undefined ? {} : { resamples: o.resamples }),
        ...(o.maxUsd === undefined ? {} : { maxUsd: o.maxUsd }),
        ...(o.outDir === undefined ? {} : { outDir: o.outDir }),
        env: process.env,
        io: ctx.io,
      });
    });
}
