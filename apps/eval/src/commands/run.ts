import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval run` (M3a-T6). Placeholder registration until the task implements it. */
export function registerRun(program: Command, _ctx: CliContext): void {
  program
    .command('run')
    .description(describeCommand('run'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('run');
    });
}
