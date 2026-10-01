import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval serve-rating` (M3a-T3). Placeholder registration until the task implements it. */
export function registerServeRating(program: Command, _ctx: CliContext): void {
  program
    .command('serve-rating')
    .description(describeCommand('serve-rating'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('serve-rating');
    });
}
