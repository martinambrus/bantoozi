import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { registerApplyG1 } from './commands/apply-g1.js';
import { registerDryRun } from './commands/dry-run.js';
import { registerGate } from './commands/gate.js';
import { registerIngestSample } from './commands/ingest-sample.js';
import { registerLearningCurve } from './commands/learning-curve.js';
import { registerRater } from './commands/rater.js';
import { registerReplay } from './commands/replay.js';
import { registerReport } from './commands/report.js';
import { registerRun } from './commands/run.js';
import { registerSample } from './commands/sample.js';
import { registerServeRating } from './commands/serve-rating.js';
import { registerStatus } from './commands/status.js';
import {
  createEvalRuntime,
  EvalCommandError,
  processIo,
  type EvalIo,
  type EvalRuntime,
} from './runtime.js';

/**
 * `pnpm evaluate <command>` (spec 10): the evaluation CLI. Each command lives in
 * `commands/<name>.ts` and registers itself on the program; `learning-curve` (M7) reads stored
 * ratings and run answers only.
 */
export const EVAL_COMMANDS = [
  ['ingest-sample', 'Subscribe the golden feeds and collect candidate articles (spec 10 §2.1)'],
  ['sample', 'Draw and freeze-ready a golden dataset version in eval.sample (spec 10 §2.1)'],
  ['status', 'Show dataset, rating and labelling progress (spec 10 §2.1)'],
  ['rater', 'Add raters, reissue or revoke their tokens (spec 10 §2.2, §2.4)'],
  ['serve-rating', 'Serve the rating and facet-labelling pages (spec 10 §2.4)'],
  ['run', 'Run an experiment against a dataset version (spec 10 §3)'],
  ['replay', 'Replay a stored run with a proposed change (spec 10 §6)'],
  ['report', 'Write the evaluation report of stored runs (spec 10 §4)'],
  ['gate', 'Select on development, confirm on test and write g1.json (spec 10 §5)'],
  ['apply-g1', 'Apply the G1 decision file to settings (spec 10 §1)'],
  ['dry-run', 'Run the whole pipeline on synthetic data in a separate database (spec 10 §3)'],
  ['learning-curve', 'Offline learning-curve check (M7)'],
] as const;

export type EvalCommandName = (typeof EVAL_COMMANDS)[number][0];

export class NotImplementedError extends Error {
  constructor(command: string) {
    super(`eval ${command} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** What a command registration receives. */
export interface CliContext {
  io: EvalIo;
  /** Opens the runtime (config, database pool) for one command; {@link withRuntime} closes it. */
  openRuntime: () => EvalRuntime;
}

export type RegisterCommand = (program: Command, ctx: CliContext) => void;

/** Run `fn` with a fresh runtime and always close its pool. */
export async function withRuntime<T>(
  ctx: CliContext,
  fn: (runtime: EvalRuntime) => Promise<T>,
): Promise<T> {
  const runtime = ctx.openRuntime();
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

export function describeCommand(name: EvalCommandName): string {
  const entry = EVAL_COMMANDS.find(([n]) => n === name);
  if (entry === undefined) throw new RangeError(`unknown eval command ${name}`);
  return entry[1];
}

const REGISTRATIONS: readonly RegisterCommand[] = [
  registerIngestSample,
  registerSample,
  registerStatus,
  registerRater,
  registerServeRating,
  registerRun,
  registerReplay,
  registerReport,
  registerGate,
  registerApplyG1,
  registerDryRun,
  registerLearningCurve,
];

export interface BuildCliOptions {
  io?: EvalIo;
  openRuntime?: () => EvalRuntime;
}

export function buildCli(options: BuildCliOptions = {}): Command {
  const io = options.io ?? processIo;
  const ctx: CliContext = {
    io,
    openRuntime: options.openRuntime ?? (() => createEvalRuntime({ io })),
  };
  const program = new Command('bantoozi-eval')
    .description('Bantoozi evaluation tooling (spec 10)')
    .showHelpAfterError();
  for (const register of REGISTRATIONS) register(program, ctx);
  return program;
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    await buildCli().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof NotImplementedError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof EvalCommandError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv);
}
