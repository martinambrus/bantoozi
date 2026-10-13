import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { STARTER_BUNDLES } from '@bantoozi/shared';
import { Command } from 'commander';

import { registerBackupCommands } from './backup-commands.js';
import {
  checkBundlesLive,
  flattenBundles,
  renderMarkdown,
  validateBundles,
} from './bundles-check.js';
import { initEnv } from './env-init.js';
import { registerLoadCommands } from './load/commands.js';
import { registerRestoreCommands } from './restore-commands.js';

/** `pnpm --filter @bantoozi/ops cli <command>`: operations tools of spec 11 (M8). */
export const program = new Command('bantoozi-ops').description('Bantoozi operations tools');

program
  .command('bundles:check')
  .description('Validate the starter bundles; with --live fetch every feed (spec 11 §9)')
  .option('--live', 'fetch and parse every feed through the SSRF-safe client')
  .option('--out <file>', 'write <file>.json and <file>.md reports (live only)')
  .option('--user-agent <ua>', 'fetch user agent', 'BantooziBot/1.0 (+https://localhost/bot)')
  .action(async (options: { live?: boolean; out?: string; userAgent: string }) => {
    const problems = validateBundles(STARTER_BUNDLES);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exitCode = 1;
    const feeds = flattenBundles(STARTER_BUNDLES);
    if (options.live !== true) {
      console.log(`${feeds.length} feeds in ${STARTER_BUNDLES.length} bundles validated`);
      return;
    }
    const report = await checkBundlesLive(feeds, { userAgent: options.userAgent });
    const markdown = renderMarkdown(report);
    if (options.out === undefined) {
      console.log(markdown);
    } else {
      const base = options.out.replace(/\.(json|md)$/u, '');
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(`${base}.md`, markdown);
      console.log(`${base}.json, ${base}.md: ${JSON.stringify(report.summary)}`);
    }
    if (report.summary.failed > 0 || report.summary.langMismatch > 0 || problems.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command('env:init')
  .description('Fill missing host secrets into the env file (M8b-T8)')
  .option('--file <file>', 'env file to fill (default: .env in the repo root)')
  .option(
    '--template <file>',
    'template copied when the env file is missing (default: .env.example)',
  )
  .option(
    '--production',
    'also fill empty database role passwords; never generate the ledger identity',
  )
  .option('--add-provider-key', 'add a new provider wrapping key and make it active')
  .action(
    async (options: {
      file?: string;
      template?: string;
      production?: boolean;
      addProviderKey?: boolean;
    }) => {
      const root = process.env.INIT_CWD ?? process.cwd();
      try {
        const result = await initEnv({
          envFile: options.file ?? join(root, '.env'),
          template: options.template ?? join(root, '.env.example'),
          production: options.production === true,
          addProviderKey: options.addProviderKey === true,
        });
        for (const note of result.notes) console.log(note);
      } catch (error) {
        console.error(`env:init: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    },
  );

registerBackupCommands(program);
registerRestoreCommands(program);
registerLoadCommands(program);

if (import.meta.url === `file://${process.argv[1]}`) {
  await program.parseAsync(process.argv);
}
