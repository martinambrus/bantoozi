import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval rater` (M3a-T3). Placeholder registration until the task implements it. */
export function registerRater(program: Command, _ctx: CliContext): void {
  program
    .command('rater')
    .description(describeCommand('rater'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('rater');
    });
}
