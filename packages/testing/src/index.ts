/**
 * `@bantoozi/testing` — test-only helpers (spec 01 §2): per-worktree test databases, the fixture
 * HTTP server and (from M0-T5) data factories. Never imported by production code.
 */
import { computeTemplateHash } from './test-db/template-hash.js';
import {
  createTestDatabase,
  ensureTemplate,
  type MigrateFn,
  type TestDatabase,
  type TestDbEnv,
} from './test-db/test-db.js';

export const PACKAGE_NAME = '@bantoozi/testing';

export * from './fixture-server.js';
export * from './test-db/template-hash.js';
export * from './test-db/test-db.js';

export interface SetupTestDatabaseOptions {
  /** Package name, e.g. `db`. */
  pkg: string;
  migrationsDir: string;
  pgBossVersion: string;
  migrate: MigrateFn;
  env?: TestDbEnv;
  worktreeRoot?: string;
}

/** Template for the current migrations (created once), then this run's clone for `pkg`. */
export async function setupTestDatabase(options: SetupTestDatabaseOptions): Promise<TestDatabase> {
  const hash = await computeTemplateHash({
    migrationsDir: options.migrationsDir,
    pgBossVersion: options.pgBossVersion,
  });
  const template = await ensureTemplate({
    hash,
    migrate: options.migrate,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return createTestDatabase({
    pkg: options.pkg,
    template,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
  });
}
