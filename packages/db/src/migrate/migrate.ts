import { fileURLToPath } from 'node:url';

import { QUEUE_NAMES, QUEUES } from '@bantoozi/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * The migrate job (spec 02 §1.2, spec 01 §4): runs as `bantoozi_owner` before api and worker start.
 *
 * 1. pg-boss schema: the construction plans of the pinned pg-boss version on a fresh database, or its
 *    migration plans for an older installed schema. No running process ever creates it.
 * 2. Drizzle migrations (`drizzle/`), in one transaction: tables, grants, RLS, functions, triggers and
 *    the pg-boss grants.
 * 3. Every queue of `packages/shared` jobs.ts via pg-boss `createQueue(name, options)` (then
 *    `updateQueue`, so changed options converge), so the per-queue partitions are owner-created.
 *
 * Every step is idempotent and the whole job holds a session advisory lock, so concurrent or repeated
 * runs converge. Every wait is bounded (spec 11 §3): a held lock or a hung statement fails the job
 * with SQLSTATE 55P03 or 57014 instead of blocking the deploy. pg-boss is loaded lazily, so importing
 * `@bantoozi/db` never loads it (spec 01 §2).
 */

/** Pinned pg-boss release (docs/DEPENDENCIES.md); part of the test-template hash (spec 02 §1.1). */
export const PG_BOSS_VERSION = '10.4.2';
/** pg-boss schema version of that release (`pg-boss/version.json`). */
export const PG_BOSS_SCHEMA_VERSION = 24;
export const PG_BOSS_SCHEMA = 'pgboss';

/** The bundled Drizzle migrations (`packages/db/drizzle`), from both `src/` and `dist/`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle/', import.meta.url));

const MIGRATE_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('bantoozi_migrate'))";
const MIGRATE_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('bantoozi_migrate'))";

/** Longest wait for any lock, the migrate advisory lock included (pg-boss uses the same 30 s). */
export const MIGRATE_LOCK_TIMEOUT_MS = 30_000;
/** Longest single statement of a migration or pg-boss plan. */
export const MIGRATE_STATEMENT_TIMEOUT_MS = 300_000;

export interface MigrateLogger {
  info(obj: object, msg: string): void;
}

export interface MigrateOptions {
  /** A `bantoozi_owner` connection string (`DATABASE_URL_MIGRATE`). */
  databaseUrl: string;
  migrationsFolder?: string;
  logger?: MigrateLogger;
  /** Session `lock_timeout` in ms (default `MIGRATE_LOCK_TIMEOUT_MS`). */
  lockTimeoutMs?: number;
  /** Session `statement_timeout` in ms (default `MIGRATE_STATEMENT_TIMEOUT_MS`). */
  statementTimeoutMs?: number;
}

export interface MigrateResult {
  pgBoss: 'created' | 'migrated' | 'current';
  migrationsApplied: number;
  queues: number;
}

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  // Startup parameters, so both bounds are in force before the advisory lock is requested.
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: 'bantoozi-migrate',
    lock_timeout: options.lockTimeoutMs ?? MIGRATE_LOCK_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMs ?? MIGRATE_STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query(MIGRATE_LOCK_SQL);
    let result: MigrateResult;
    try {
      result = await migrateLocked(client, options);
    } catch (error) {
      // A failed pg-boss plan leaves its own BEGIN aborted, so any further statement fails with
      // 25P02: roll back and unlock best-effort, and report the original error (e.g. a timeout).
      // Closing the connection releases the session lock in any case.
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(MIGRATE_UNLOCK_SQL).catch(() => undefined);
      throw error;
    }
    await client.query(MIGRATE_UNLOCK_SQL);
    return result;
  } finally {
    await client.end();
  }
}

async function migrateLocked(client: pg.Client, options: MigrateOptions): Promise<MigrateResult> {
  const pgBoss = await installPgBoss(client);
  options.logger?.info({ pgBoss }, 'pg-boss schema ready');

  const before = await appliedMigrationCount(client);
  await drizzleMigrate(drizzle({ client }), {
    migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
  });
  const migrationsApplied = (await appliedMigrationCount(client)) - before;
  options.logger?.info({ migrationsApplied }, 'migrations applied');

  const queues = await createQueues(client);
  options.logger?.info({ queues }, 'queues ready');
  return { pgBoss, migrationsApplied, queues };
}

async function loadPgBoss() {
  const module = await import('pg-boss');
  return module.default;
}

async function installPgBoss(client: pg.Client): Promise<MigrateResult['pgBoss']> {
  const PgBoss = await loadPgBoss();
  const installed = await client.query<{ present: boolean }>(
    `SELECT to_regclass('${PG_BOSS_SCHEMA}.version') IS NOT NULL AS present`,
  );
  if (installed.rows[0]?.present !== true) {
    // The plans carry their own BEGIN … COMMIT and advisory lock (simple query protocol).
    await client.query(PgBoss.getConstructionPlans(PG_BOSS_SCHEMA));
    return 'created';
  }
  const current = await client.query<{ version: number }>(
    `SELECT version FROM ${PG_BOSS_SCHEMA}.version`,
  );
  const version = current.rows[0]?.version;
  if (version === undefined) throw new Error('pg-boss version row is missing');
  if (version > PG_BOSS_SCHEMA_VERSION) {
    throw new Error(
      `pg-boss schema ${version} is newer than the pinned pg-boss ${PG_BOSS_VERSION} (${PG_BOSS_SCHEMA_VERSION})`,
    );
  }
  if (version === PG_BOSS_SCHEMA_VERSION) return 'current';
  await client.query(PgBoss.getMigrationPlans(PG_BOSS_SCHEMA, String(version)));
  return 'migrated';
}

async function appliedMigrationCount(client: pg.Client): Promise<number> {
  const table = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (table.rows[0]?.present !== true) return 0;
  const result = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
  );
  return result.rows[0]?.n ?? 0;
}

/** `createQueue` for every registry entry on this owner connection (pg-boss is never started). */
async function createQueues(client: pg.Client): Promise<number> {
  const PgBoss = await loadPgBoss();
  const boss = new PgBoss({
    schema: PG_BOSS_SCHEMA,
    db: {
      executeSql: async (text: string, values: unknown[]) => client.query(text, values),
    },
  });
  for (const name of QUEUE_NAMES) {
    const options = { ...QUEUES[name].options };
    await boss.createQueue(name, { name, ...options });
    await boss.updateQueue(name, { name, ...options });
  }
  return QUEUE_NAMES.length;
}
