import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval status` (M3a-T2). Placeholder registration until the task implements it. */
export function registerStatus(program: Command, _ctx: CliContext): void {
  program
    .command('status')
    .description(describeCommand('status'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('status');
    });
}
