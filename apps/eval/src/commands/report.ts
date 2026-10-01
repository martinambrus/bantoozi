import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval report` (M3a-T7). Placeholder registration until the task implements it. */
export function registerReport(program: Command, _ctx: CliContext): void {
  program
    .command('report')
    .description(describeCommand('report'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('report');
    });
}
