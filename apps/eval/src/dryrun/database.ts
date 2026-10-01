import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DRYRUN_DATABASE_PREFIX,
  isDryRunDatabaseName,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  recreateDryRunDatabase,
  runMigrations,
} from '@bantoozi/db';
import { computeTemplateHash, ensureTemplate, roleUrl, testDbEnv } from '@bantoozi/testing';

import { REPOSITORY_ROOT } from '../experiments/util.js';
import { EvalCommandError } from '../runtime.js';

/**
 * The dry-run database (spec 10 §3): `bantoozi_eval_dryrun` (or a suffixed name for tests), copied
 * fresh from the migrated template of the current migrations (the `@bantoozi/testing` template
 * machinery, created on first use) and then seeded exactly like `pnpm db:seed`, by running the
 * worker's seed script against it. The admin connection (`TEST_ADMIN_DATABASE_URL`) is used only to
 * create the database; everything else runs as the normal roles.
 */

export const DEFAULT_DRYRUN_DATABASE = DRYRUN_DATABASE_PREFIX;

export interface DryRunDatabase {
  name: string;
  adminUrl: string;
  ownerUrl: string;
  workerUrl: string;
}

const run = promisify(execFile);

export async function createDryRunDatabase(input: {
  name: string;
  env: NodeJS.ProcessEnv;
  /** Run `pnpm db:seed` against it (default true). */
  seed?: boolean;
}): Promise<DryRunDatabase> {
  if (!isDryRunDatabaseName(input.name)) {
    throw new EvalCommandError(
      `--db must be ${DRYRUN_DATABASE_PREFIX} or ${DRYRUN_DATABASE_PREFIX}_<suffix> (got ${input.name})`,
    );
  }
  const env = testDbEnv(input.env);
  const hash = await computeTemplateHash({
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
  });
  const template = await ensureTemplate({
    hash,
    env,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  await recreateDryRunDatabase({ adminUrl: env.adminUrl, name: input.name, template });
  const db: DryRunDatabase = {
    name: input.name,
    adminUrl: env.adminUrl,
    ownerUrl: roleUrl(env, 'bantoozi_owner', input.name),
    workerUrl: roleUrl(env, 'bantoozi_worker', input.name),
  };
  if (input.seed !== false) await seedDryRunDatabase(db, input.env);
  return db;
}

/** `pnpm db:seed` (the worker's seed script) with the dry-run database as its only database. */
export async function seedDryRunDatabase(
  db: DryRunDatabase,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await run('pnpm', ['--silent', '--filter', '@bantoozi/worker', 'seed'], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...env,
        DATABASE_URL_WORKER: db.workerUrl,
        LOG_LEVEL: 'warn',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    throw new EvalCommandError(`seeding ${db.name} failed: ${detail.trim().slice(0, 2000)}`);
  }
}
