import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval apply-g1` (M3a-T7). Placeholder registration until the task implements it. */
export function registerApplyG1(program: Command, _ctx: CliContext): void {
  program
    .command('apply-g1')
    .description(describeCommand('apply-g1'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('apply-g1');
    });
}
