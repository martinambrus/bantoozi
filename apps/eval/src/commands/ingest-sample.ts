import type { Command } from 'commander';

import { describeCommand, NotImplementedError, type CliContext } from '../cli.js';

/** `eval ingest-sample` (M3a-T2). Placeholder registration until the task implements it. */
export function registerIngestSample(program: Command, _ctx: CliContext): void {
  program
    .command('ingest-sample')
    .description(describeCommand('ingest-sample'))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new NotImplementedError('ingest-sample');
    });
}
