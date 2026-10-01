import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval gate` (M3a-T7). Placeholder registration until the task implements it. */
export function registerGate(program: Command, _ctx: CliContext): void {
  program
    .command('gate')
    .description(describeCommand('gate'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('gate');
    });
}
