import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';

import { createDatabase, type Database } from '../../src/client.js';
import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '../../src/migrate/migrate.js';

/**
 * One migrated database per test file: the template for the current migrations (created once per
 * journal hash, spec 02 §1.1) cloned for this run, with a pool per real role login.
 */
export interface DbTestContext {
  testDb: TestDatabase;
  /** bantoozi_owner: fixtures and assertions that must see everything. */
  owner: pg.Pool;
  /** bantoozi_app: the API role (RLS enforced). */
  appPool: pg.Pool;
  /** bantoozi_worker: BYPASSRLS worker role. */
  workerPool: pg.Pool;
  /** Superuser connection to this database (catalog inspection only). */
  adminPool: pg.Pool;
  app: Database;
  worker: Database;
  close(): Promise<void>;
}

export const migrateForTests = async (ownerUrl: string): Promise<void> => {
  await runMigrations({ databaseUrl: ownerUrl });
};

export async function setupDbTest(): Promise<DbTestContext> {
  const testDb = await setupTestDatabase({
    pkg: 'db',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: migrateForTests,
  });
  const pool = (connectionString: string) => new pg.Pool({ connectionString, max: 6 });
  const owner = pool(testDb.urls.owner);
  const appPool = pool(testDb.urls.app);
  const workerPool = pool(testDb.urls.worker);
  const adminPool = pool(testDb.urls.admin);
  return {
    testDb,
    owner,
    appPool,
    workerPool,
    adminPool,
    app: createDatabase(appPool),
    worker: createDatabase(workerPool),
    async close() {
      await Promise.all([owner.end(), appPool.end(), workerPool.end(), adminPool.end()]);
      await dropCreatedTestDatabases();
    },
  };
}

/** Run `fn` on one dedicated connection of `pool` (for explicit transactions and session state). */
export async function withConnection<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** `fn` inside BEGIN … COMMIT on one app connection with `app.user_id` set (raw-SQL tenant tx). */
export async function asTenant<T>(
  pool: pg.Pool,
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      if (userId !== null)
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** The SQLSTATE a promise rejects with (fails the test when it resolves). */
export async function sqlStateOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('expected a database error');
}
