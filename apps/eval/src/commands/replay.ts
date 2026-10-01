import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval replay` (M3a-T6). Placeholder registration until the task implements it. */
export function registerReplay(program: Command, _ctx: CliContext): void {
  program
    .command('replay')
    .description(describeCommand('replay'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('replay');
    });
}
