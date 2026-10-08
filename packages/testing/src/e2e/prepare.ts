import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { computeTemplateHash } from '../test-db/template-hash.js';
import { defaultWorktreeRoot, ensureTemplate, roleUrl, testDbEnv } from '../test-db/test-db.js';
import { createE2eDatabase, dropE2eDatabase, sweepStaleE2eDatabases } from './database.js';
import { e2eDatabaseName, requireRunId } from './env.js';

/**
 * `pnpm --filter @bantoozi/testing e2e:prepare` (first `webServer` entry of spec 09 §9): makes sure
 * the template for the current migrations exists, copies it to `bantoozi_e2e_<E2E_RUN_ID>`, seeds
 * that copy exactly like `pnpm db:seed`, and sweeps databases that earlier killed runs leaked.
 * `fixtures:serve` drops the copy when the run ends.
 *
 * The template is built with the same inputs as the integration tests' (`@bantoozi/testing` must
 * not import `@bantoozi/db`, so the migrate job runs as a child process), which makes `h` equal.
 */

const run = promisify(execFile);

function log(message: string): void {
  process.stdout.write(`[e2e:prepare] ${message}\n`);
}

async function pnpm(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await run('pnpm', ['--silent', ...args], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown };
    const detail = `${String(output.stdout ?? '')}${String(output.stderr ?? '')}`.trim();
    throw new Error(`pnpm ${args.join(' ')} failed:\n${detail.slice(-2000)}`, { cause: error });
  }
}

/** The exact pg-boss release in `packages/db/package.json`, part of the template hash (spec 02 §1.1). */
async function pinnedPgBossVersion(root: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'packages/db/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.['pg-boss'];
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`packages/db must pin pg-boss to an exact version (found "${version}")`);
  }
  return version;
}

async function main(): Promise<void> {
  const name = e2eDatabaseName(requireRunId());
  const env = testDbEnv();
  const root = defaultWorktreeRoot();

  const hash = await computeTemplateHash({
    migrationsDir: path.join(root, 'packages/db/drizzle'),
    pgBossVersion: await pinnedPgBossVersion(root),
  });
  const template = await ensureTemplate({
    hash,
    env,
    migrate: (ownerUrl) =>
      pnpm(root, ['--filter', '@bantoozi/db', 'migrate'], { DATABASE_URL_MIGRATE: ownerUrl }),
  });

  await createE2eDatabase({ env, name, template });
  try {
    await pnpm(root, ['--filter', '@bantoozi/worker', 'seed'], {
      DATABASE_URL_WORKER: roleUrl(env, 'bantoozi_worker', name),
    });
  } catch (error) {
    await dropE2eDatabase(env, name);
    throw error;
  }
  log(`database ${name} created from ${template} and seeded`);

  const swept = await sweepStaleE2eDatabases({ env, keep: name }).catch((error: unknown) => ({
    dropped: [] as string[],
    failed: [{ name: '(sweep)', error: String(error) }],
  }));
  for (const dropped of swept.dropped) log(`dropped stale database ${dropped}`);
  for (const failure of swept.failed) log(`could not drop ${failure.name}: ${failure.error}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[e2e:prepare] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
