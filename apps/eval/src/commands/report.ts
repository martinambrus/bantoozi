import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { findGateLocks } from '@bantoozi/db';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { loadDataset, loadReportModel } from '../report/load.js';
import { defaultEvalReportPath, resolveRepoPath } from '../report/paths.js';
import { renderEvaluationReport } from '../report/render.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval report [--dataset <v>] [--out <path>] [--seed <s>] [--resamples <n>] [--baseline <exp>]`
 * (spec 10 §4, M3a-T7): every §4 table for the runs of one frozen dataset version, as markdown with
 * one reliability SVG per language. The test split stays sealed until `eval gate` has locked a
 * selection for the version (spec 10 §5: test labels cannot be read during selection); before that
 * only development tables are written.
 */
const OptionsSchema = z.object({
  dataset: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  seed: z.string().min(1).optional(),
  resamples: z.coerce.number().int().min(1).max(100_000).default(1000),
  baseline: z.string().min(1).default('B1'),
  stdout: z.boolean().optional(),
});

export function registerReport(program: Command, ctx: CliContext): void {
  program
    .command('report')
    .description(describeCommand('report'))
    .option('--dataset <version>', 'dataset version (default: the newest frozen one)')
    .option('--out <path>', 'output file, relative to the repository root')
    .option('--seed <seed>', 'bootstrap seed (default: the dataset seed)')
    .option('--resamples <n>', 'bootstrap resamples', '1000')
    .option('--baseline <experiment>', 'baseline experiment for ΔAUC', 'B1')
    .option('--stdout', 'print the report instead of writing a file')
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const options = parsed.data;
      await withRuntime(ctx, async (rt) => {
        const loaded = await loadDataset(rt.db, options.dataset);
        const model = await loadReportModel(rt.db, loaded);
        const sealed = (await findGateLocks(rt.db, loaded.dataset.version)).length === 0;
        const now = rt.now();
        const markdown = renderEvaluationReport(model, {
          title: `Evaluation report — ${loaded.dataset.version}`,
          splits: sealed ? ['dev'] : ['dev', 'test'],
          settings: { seed: options.seed ?? loaded.dataset.seed, resamples: options.resamples },
          sealedNote: sealed
            ? 'The test split is sealed until `eval gate` locks a selection for this dataset version.'
            : undefined,
          baselineExperiment: options.baseline,
          generatedAt: now,
        });
        const unreadable = loaded.unreadable
          .map((u) => `run ${u.id} (${u.experiment}) skipped: ${u.reason}\n`)
          .join('');
        if (unreadable !== '') rt.err(unreadable);
        if (options.stdout === true) {
          rt.out(markdown);
          return;
        }
        const target =
          options.out === undefined
            ? defaultEvalReportPath(loaded.dataset.version, now)
            : resolveRepoPath(options.out);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, markdown, 'utf8');
        rt.out(
          `report written to ${target} (${model.runs.length} runs, ${sealed ? 'development only: test sealed' : 'development and test'})\n`,
        );
      });
    });
}
