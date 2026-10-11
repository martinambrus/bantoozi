import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import { parseLoadProfile } from './profile.js';
import { runLoad } from './run.js';

/** `load:run` (spec 11 §9, M8-T8). */
export function registerLoadCommands(program: Command): void {
  program
    .command('load:run')
    .description('Run the load sanity test on the local project bantoozi-load (spec 11 §9)')
    .requiredOption('--duration <minutes>', 'total minutes, shared by the four phases (at least 2)')
    .requiredOption('--out <dir>', 'directory for report.json and report.md')
    .option(
      '--profile <name>',
      'realistic (default, gated) or stress (1 list/s and 1 action/s, not gated)',
    )
    .option('--keep', 'leave the bantoozi-load stack running afterwards')
    .action(
      async (options: { duration: string; out: string; keep?: boolean; profile?: string }) => {
        const profile = parseLoadProfile(options.profile);
        const durationMin = Number(options.duration);
        if (!Number.isFinite(durationMin) || durationMin < 2) {
          throw new Error('--duration takes a number of minutes, at least 2');
        }
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
        const report = await runLoad({
          profile,
          durationMin,
          outDir: path.resolve(options.out),
          keep: options.keep === true,
          repoRoot,
        });
        const ok =
          report.criteria.p95Ok &&
          report.criteria.backlogOk &&
          report.criteria.allOffZeroInference &&
          report.criteria.degradedReadingOk;
        const verdict = ok ? 'criteria met' : 'CRITERIA NOT MET';
        console.log(
          `load:run (${profile}): ${report.criteria.gated ? verdict : `${verdict}, not gated`} (see ${path.resolve(options.out)}/report.md)`,
        );
        if (report.criteria.gated && !ok) process.exitCode = 1;
      },
    );
}
