import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

/**
 * `pnpm evaluate <command>` (spec 10): the evaluation CLI. M0 provides the command surface only;
 * each command is implemented by the milestone named in its description and, until then, exits
 * with status 2 without touching any database or provider.
 */
export const EVAL_COMMANDS = [
  ['ingest-sample', 'Ingest the golden feeds into eval.sample (M3a)'],
  ['sample', 'Draw and freeze a golden dataset version (M3a)'],
  ['status', 'Show dataset, rating and labelling progress (M3a)'],
  ['rater', 'Create, list or revoke rater tokens (M3a)'],
  ['serve-rating', 'Serve the rating and facet-labelling pages (M3a)'],
  ['run', 'Run an experiment against a dataset version (M3a)'],
  ['report', 'Write the markdown/HTML report of runs (M3a)'],
  ['apply-g1', 'Apply the G1 decision file to settings (M3b)'],
  ['dry-run', 'Run the whole pipeline on synthetic data in a separate database (M3a)'],
  ['replay', 'Replay a frozen dataset against a candidate change (M3b)'],
  ['learning-curve', 'Offline learning-curve check (M7)'],
] as const;

export class NotImplementedError extends Error {
  constructor(command: string) {
    super(`eval ${command} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export function buildCli(): Command {
  const program = new Command('bantoozi-eval')
    .description('Bantoozi evaluation tooling (spec 10)')
    .showHelpAfterError();
  for (const [name, description] of EVAL_COMMANDS) {
    program
      .command(name)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        throw new NotImplementedError(name);
      });
  }
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
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv);
}
