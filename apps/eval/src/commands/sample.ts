import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval sample` (M3a-T2). Placeholder registration until the task implements it. */
export function registerSample(program: Command, _ctx: CliContext): void {
  program
    .command('sample')
    .description(describeCommand('sample'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('sample');
    });
}
