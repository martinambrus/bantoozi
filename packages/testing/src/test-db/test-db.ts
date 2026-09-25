import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * Per-worktree, per-package integration test databases (spec 02 §1.1, spec 01 §6).
 *
 * 1. A template per schema version, `bantoozi_template_<h>`, created once under
 *    `pg_advisory_lock(hashtext('bantoozi_template'))` on a dedicated connection: extensions, the
 *    production schema ownership/ACL, then the full migrate job as `bantoozi_owner`. A ready marker
 *    is published only after a successful migration; an incomplete template is dropped and rebuilt.
 * 2. `bantoozi_test_<worktree-hash>_<package>_<run-id>`, cloned from the template for each run.
 *
 * The migrate job is injected (packages/db passes its own), so this package never imports
 * packages/db and the workspace dependency graph stays acyclic.
 */

export type MigrateFn = (ownerUrl: string) => Promise<void>;

export interface TestDbEnv {
  /** Superuser connection (`TEST_ADMIN_DATABASE_URL`). */
  adminUrl: string;
  passwords: { owner: string; app: string; worker: string };
}

const DEFAULT_PG_TEST_PORT = '5433';
const READY_MARKER = 'bantoozi-template-ready';
const TEMPLATE_LOCK = "hashtext('bantoozi_template')";
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Connection settings from the environment. Role passwords default to the test-only defaults of
 * `infra/compose.test.yml`; set BANTOOZI_*_PASSWORD when the test stack uses other values.
 */
export function testDbEnv(env: NodeJS.ProcessEnv = process.env): TestDbEnv {
  const port = env['PG_TEST_PORT']?.trim() || DEFAULT_PG_TEST_PORT;
  return {
    adminUrl:
      env['TEST_ADMIN_DATABASE_URL']?.trim() ||
      `postgres://postgres:postgres@localhost:${port}/postgres`,
    passwords: {
      owner: env['BANTOOZI_OWNER_PASSWORD'] || 'bantoozi_owner',
      app: env['BANTOOZI_APP_PASSWORD'] || 'bantoozi_app',
      worker: env['BANTOOZI_WORKER_PASSWORD'] || 'bantoozi_worker',
    },
  };
}

export type DbRole = 'bantoozi_owner' | 'bantoozi_app' | 'bantoozi_worker';

/** A URL for `role` on `database`, on the admin connection's host/port. */
export function roleUrl(env: TestDbEnv, role: DbRole | 'postgres', database: string): string {
  const url = new URL(env.adminUrl);
  if (role !== 'postgres') {
    url.username = role;
    url.password =
      role === 'bantoozi_owner'
        ? env.passwords.owner
        : role === 'bantoozi_app'
          ? env.passwords.app
          : env.passwords.worker;
  }
  url.pathname = `/${database}`;
  return url.toString();
}

/** Double-quoted SQL identifier. Names are sanitized first; this also escapes quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function assertIdentifier(name: string): void {
  if (!/^[a-z0-9_]+$/.test(name) || Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`invalid database name: ${name}`);
  }
}

export function templateDatabaseName(hash: string): string {
  if (!/^[0-9a-f]{12}$/.test(hash)) throw new Error('template hash must be 12 hex digits');
  return `bantoozi_template_${hash}`;
}

/** The repository (worktree) root that contains this package. */
export function defaultWorktreeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/** Short, stable hash of a worktree's absolute path: parallel worktrees never share databases. */
export function worktreeHash(worktreeRoot: string): string {
  let resolved = path.resolve(worktreeRoot);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A path that does not exist (tests) still hashes deterministically.
  }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 8);
}

function sanitize(part: string, max: number): string {
  const cleaned = part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : 'x';
}

export function newRunId(): string {
  return randomBytes(5).toString('hex');
}

/** `bantoozi_test_<worktree-hash>_<package>_<run-id>`, sanitized and ≤ 63 bytes. */
export function testDatabaseName(input: {
  worktreeRoot: string;
  pkg: string;
  runId: string;
}): string {
  const name = `bantoozi_test_${worktreeHash(input.worktreeRoot)}_${sanitize(input.pkg, 20)}_${sanitize(
    input.runId,
    16,
  )}`;
  assertIdentifier(name);
  return name;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'bantoozi-test-db' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function terminateConnections(admin: pg.Client, database: string): Promise<void> {
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [database],
  );
}

type TemplateState = 'missing' | 'incomplete' | 'ready';

async function templateState(admin: pg.Client, name: string): Promise<TemplateState> {
  const { rows } = await admin.query<{ marker: string | null }>(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
    [name],
  );
  if (rows.length === 0) return 'missing';
  return rows[0]?.marker === READY_MARKER ? 'ready' : 'incomplete';
}

/** Production database-level settings (spec 02 §1.1) for a database created by the helper. */
async function applyDatabaseAcl(admin: pg.Client, name: string): Promise<void> {
  await admin.query(`REVOKE ALL ON DATABASE ${quoteIdent(name)} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${quoteIdent(name)} TO bantoozi_app, bantoozi_worker`,
  );
}

async function withTemplateLock<T>(admin: pg.Client, fn: () => Promise<T>): Promise<T> {
  await admin.query(`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`);
  try {
    return await fn();
  } finally {
    await admin.query(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`);
  }
}

export interface EnsureTemplateOptions {
  hash: string;
  migrate: MigrateFn;
  env?: TestDbEnv;
}

/**
 * Create `bantoozi_template_<hash>` once (concurrent callers wait on the advisory lock and then
 * find it ready). Returns the template name.
 */
export async function ensureTemplate(options: EnsureTemplateOptions): Promise<string> {
  const env = options.env ?? testDbEnv();
  const name = templateDatabaseName(options.hash);
  return withClient(env.adminUrl, (admin) =>
    withTemplateLock(admin, async () => {
      const state = await templateState(admin, name);
      if (state === 'ready') return name;
      if (state === 'incomplete') {
        await terminateConnections(admin, name);
        await admin.query(`DROP DATABASE ${quoteIdent(name)}`);
      }
      await admin.query(`CREATE DATABASE ${quoteIdent(name)} OWNER bantoozi_owner`);
      try {
        await withClient(roleUrl(env, 'postgres', name), async (db) => {
          await db.query('CREATE EXTENSION IF NOT EXISTS citext');
          await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
          await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
          await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
          await db.query('ALTER SCHEMA public OWNER TO bantoozi_owner');
        });
        await applyDatabaseAcl(admin, name);
        await options.migrate(roleUrl(env, 'bantoozi_owner', name));
        // Disconnect every template connection before it is cloned.
        await terminateConnections(admin, name);
        await admin.query(`COMMENT ON DATABASE ${quoteIdent(name)} IS '${READY_MARKER}'`);
        return name;
      } catch (error) {
        await terminateConnections(admin, name);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
        throw error;
      }
    }),
  );
}

export interface TestDatabase {
  name: string;
  template: string;
  urls: { admin: string; owner: string; app: string; worker: string };
  drop(): Promise<void>;
}

/** Databases created by this process (cleanup drops only these). */
const created = new Set<string>();

export interface CreateTestDatabaseOptions {
  /** Package name, e.g. `db` or `api`. */
  pkg: string;
  template: string;
  worktreeRoot?: string;
  runId?: string;
  env?: TestDbEnv;
}

/** Clone the template into this worktree/package/run's database (dropped and recreated per run). */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions,
): Promise<TestDatabase> {
  const env = options.env ?? testDbEnv();
  const name = testDatabaseName({
    worktreeRoot: options.worktreeRoot ?? defaultWorktreeRoot(),
    pkg: options.pkg,
    runId: options.runId ?? newRunId(),
  });
  assertIdentifier(options.template);
  await withClient(env.adminUrl, (admin) =>
    withTemplateLock(admin, async () => {
      if ((await templateState(admin, options.template)) !== 'ready') {
        throw new Error(`template ${options.template} is not ready`);
      }
      await terminateConnections(admin, name);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
      await admin.query(
        `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(options.template)} OWNER bantoozi_owner`,
      );
      await applyDatabaseAcl(admin, name);
    }),
  );
  created.add(name);
  return {
    name,
    template: options.template,
    urls: {
      admin: roleUrl(env, 'postgres', name),
      owner: roleUrl(env, 'bantoozi_owner', name),
      app: roleUrl(env, 'bantoozi_app', name),
      worker: roleUrl(env, 'bantoozi_worker', name),
    },
    drop: () => dropTestDatabase(name, env),
  };
}

export async function dropTestDatabase(name: string, env: TestDbEnv = testDbEnv()): Promise<void> {
  if (!created.has(name)) throw new Error(`refusing to drop ${name}: not created by this run`);
  await withClient(env.adminUrl, async (admin) => {
    await terminateConnections(admin, name);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  });
  created.delete(name);
}

/** Drop every database this process created (test teardown). */
export async function dropCreatedTestDatabases(env: TestDbEnv = testDbEnv()): Promise<void> {
  for (const name of [...created]) await dropTestDatabase(name, env);
}
