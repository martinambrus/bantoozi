import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { EXPERIMENT_IDS, isExperimentId } from '../experiments/definitions.js';
import { runExperiment, type CostEstimate } from '../experiments/runner.js';
import { formatUsd } from '../experiments/util.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval run <experiment> [--dataset v] [--langs en,sk] [--raters 1,2] [--yes] [--max-usd n]
 * [--card-mode as_written|english] [--base-run id] [--resume runId] [--seed s]` (spec 10 §3,
 * M3a-T6). Prints the cost estimate before any call; above $1 it asks for confirmation on a
 * terminal and otherwise needs `--yes` (unattended goals always pass `--yes --max-usd <n>`).
 * `--experiment <id>` is accepted as an alias of the positional argument. Exit status 3 when the
 * invocation cap stopped the run (`aborted`, answers kept; resume with `--resume`).
 */

const list = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

const OptionsSchema = z.object({
  experiment: z.string().optional(),
  dataset: z.string().min(1).optional(),
  langs: z.string().optional(),
  raters: z.string().optional(),
  yes: z.boolean().optional(),
  maxUsd: z.coerce.number().finite().nonnegative().optional(),
  seed: z.string().min(1).optional(),
  cardMode: z.enum(['as_written', 'english']).optional(),
  baseRun: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .optional(),
  resume: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .optional(),
});

/** Ask on an interactive terminal; never on a pipe (the run is then declined without `--yes`). */
export async function terminalConfirm(estimate: CostEstimate): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `The estimate ${formatUsd(estimate.estimatedUsd)} is above $1. Continue? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description(describeCommand('run'))
    .argument('[experiment]', `one of ${EXPERIMENT_IDS.join(', ')}`)
    .option('--experiment <id>', 'the experiment (alias of the argument)')
    .option('--dataset <version>', 'dataset version (default: the head version)')
    .option('--langs <list>', 'comma-separated languages (default: all of the version)')
    .option('--raters <ids>', 'comma-separated rater ids (default: all)')
    .option('--yes', 'do not ask for confirmation above $1')
    .option('--max-usd <usd>', 'invocation spend cap in USD (default 10)')
    .option('--seed <seed>', 'run seed (default: the dataset seed)')
    .option('--card-mode <mode>', 'E4 card text mode selected on development')
    .option('--base-run <runId>', 'E6/E7: the E1 run (default: the newest finished one)')
    .option('--resume <runId>', 'continue an unfinished or partial run')
    .action(async (argument: string | undefined, raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const options = parsed.data;
      const experiment = argument ?? options.experiment;
      if (experiment === undefined || !isExperimentId(experiment)) {
        throw new EvalCommandError(
          `name an experiment: one of ${EXPERIMENT_IDS.join(', ')} (got ${experiment ?? 'none'})`,
        );
      }
      const langs = list(options.langs);
      const raterIds = list(options.raters);
      await withRuntime(ctx, async (rt) => {
        const result = await runExperiment(rt, {
          experiment,
          ...(options.dataset === undefined ? {} : { datasetVersion: options.dataset }),
          ...(langs === undefined ? {} : { langs }),
          ...(raterIds === undefined ? {} : { raterIds }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.cardMode === undefined ? {} : { cardTextMode: options.cardMode }),
          ...(options.baseRun === undefined ? {} : { baseRunId: options.baseRun }),
          ...(options.resume === undefined ? {} : { resumeRunId: options.resume }),
          confirm: terminalConfirm,
        });
        if (result.status === 'declined') {
          throw new EvalCommandError(
            `the estimate ${formatUsd(result.estimate.estimatedUsd)} is above $1; ` +
              'pass --yes (and --max-usd) to run it',
          );
        }
        if (result.status === 'aborted') {
          throw new EvalCommandError(
            `run ${result.runId ?? '?'} stopped at the invocation cap (${result.results?.reason ?? 'aborted'}); ` +
              `answers are kept: resume with --resume ${result.runId ?? '?'} --max-usd <remaining>`,
            3,
          );
        }
      });
    });
}
