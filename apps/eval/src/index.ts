/** Public entry point of @bantoozi/eval (the CLI lives in `cli.ts`). */
export const PACKAGE_NAME = '@bantoozi/eval';

export { buildCli, EVAL_COMMANDS, NotImplementedError, withRuntime } from './cli.js';
export type { CliContext, EvalCommandName, RegisterCommand } from './cli.js';
export { createEvalRuntime, EvalCommandError } from './runtime.js';
export type { EvalIo, EvalRuntime, EvalRuntimeOptions } from './runtime.js';
export { replayRun } from './experiments/replay.js';
export { runExperiment } from './experiments/runner.js';
export type { RunExperimentOptions, RunExperimentResult } from './experiments/runner.js';
export { DRYRUN_DEFAULTS, runDryRun } from './dryrun/run.js';
export type { DryRunOptions, DryRunResult } from './dryrun/run.js';
