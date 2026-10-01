import { readFile } from 'node:fs/promises';

import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { replayRun } from '../experiments/replay.js';
import { formatUsd, resolveFromRepositoryRoot } from '../experiments/util.js';
import { EvalCommandError } from '../runtime.js';
import { terminalConfirm } from './run.js';

/**
 * `eval replay <runId> | --against <runId> [--model jev-x.y.z] [--engine llm [--llm-model m]]
 * [--question-set enrich-v1] [--thresholds file.json] [--max-usd n] [--yes] [--out report.md]`
 * (spec 10 §6, M3a-T6). Re-runs the stored run's frozen inputs with the proposed change through
 * the cache and writes the markdown diff report (default `apps/eval/reports/REPLAY-<run>-vs-<base>.md`;
 * paths are relative to the repository root). Exit status 4 when the pass rule fails.
 */

const id = z.string().regex(/^[1-9]\d{0,18}$/);

const OptionsSchema = z.object({
  against: id.optional(),
  engine: z.enum(['typesafe', 'llm']).optional(),
  model: z.string().min(1).optional(),
  llmModel: z.string().min(1).optional(),
  questionSet: z.string().min(1).optional(),
  thresholds: z.string().min(1).optional(),
  maxUsd: z.coerce.number().finite().nonnegative().optional(),
  yes: z.boolean().optional(),
  out: z.string().min(1).optional(),
});

export function registerReplay(program: Command, ctx: CliContext): void {
  program
    .command('replay')
    .description(describeCommand('replay'))
    .argument('[runId]', 'the stored run to compare against')
    .option('--against <runId>', 'the stored run (alias of the argument)')
    .option('--engine <engine>', 'typesafe (default) or llm: replay the fallback classifier')
    .option('--model <model>', 'the proposed TYPESAFE_MODEL')
    .option('--llm-model <model>', 'the LLM model of --engine llm (default OLLAMA_MODEL_FAST)')
    .option('--question-set <version>', 'the proposed enrich question set')
    .option('--thresholds <file>', 'proposed ranker.thresholds (JSON deep partial)')
    .option('--max-usd <usd>', 'invocation spend cap in USD (default 10)')
    .option('--yes', 'do not ask for confirmation above $1')
    .option('--out <file>', 'report path (default apps/eval/reports/REPLAY-<run>-vs-<base>.md)')
    .action(async (argument: string | undefined, raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const options = parsed.data;
      const against = argument ?? options.against;
      if (against === undefined || !id.safeParse(against).success) {
        throw new EvalCommandError('name the run to replay: eval replay <runId>');
      }
      let thresholds: unknown;
      if (options.thresholds !== undefined) {
        try {
          thresholds = JSON.parse(
            await readFile(resolveFromRepositoryRoot(options.thresholds), 'utf8'),
          ) as unknown;
        } catch {
          throw new EvalCommandError(`cannot read thresholds JSON ${options.thresholds}`);
        }
      }
      await withRuntime(ctx, async (rt) => {
        const result = await replayRun(rt, {
          againstRunId: against,
          ...(options.engine === undefined ? {} : { engine: options.engine }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.llmModel === undefined ? {} : { llmModel: options.llmModel }),
          ...(options.questionSet === undefined ? {} : { questionSet: options.questionSet }),
          ...(thresholds === undefined ? {} : { thresholds }),
          ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.out === undefined
            ? {}
            : { reportPath: resolveFromRepositoryRoot(options.out) }),
          confirm: terminalConfirm,
        });
        if (result.run.status === 'declined') {
          throw new EvalCommandError(
            `the estimate ${formatUsd(result.run.estimate.estimatedUsd)} is above $1; pass --yes to replay`,
          );
        }
        rt.out(
          `replay ${result.run.runId ?? '?'} vs ${result.baseRunId}: ${result.verdict ?? 'n/a'}` +
            (result.reportPath === null ? '\n' : `; report ${result.reportPath}\n`),
        );
        if (result.verdict === 'fail') {
          throw new EvalCommandError('the replay fails the spec 10 §6 pass rule', 4);
        }
      });
    });
}
