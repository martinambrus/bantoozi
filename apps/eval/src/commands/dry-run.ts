import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval dry-run` (M3a-T8). Placeholder registration until the task implements it. */
export function registerDryRun(program: Command, _ctx: CliContext): void {
  program
    .command('dry-run')
    .description(describeCommand('dry-run'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('dry-run');
    });
}
