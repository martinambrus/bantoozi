import pg from 'pg';

import { quoteIdent, type TestDbEnv } from '../test-db/test-db.js';
import { assertE2eDatabaseName, E2E_DATABASE_NAME } from './env.js';

/**
 * The run's own database `bantoozi_e2e_<runId>` (spec 09 §9): cloned from the migrated template of
 * the current migrations exactly like the eval dry-run database (`packages/db/src/eval/dryrun.ts`),
 * dropped when the run ends, and swept when a killed run leaked it. Only names that pass
 * {@link assertE2eDatabaseName} are ever created or dropped.
 */

/** The template lock and ready marker of `./test-db/test-db.ts`. */
const TEMPLATE_LOCK = "hashtext('bantoozi_template')";
const READY_MARKER = 'bantoozi-template-ready';
const TEMPLATE_NAME = /^bantoozi_template_[0-9a-f]{12}$/;

const CREATED_PREFIX = 'bantoozi-e2e created ';
/** A database older than this, with no connection, is a leak of a run that was killed. */
export const E2E_STALE_AFTER_MS = 6 * 3_600_000;

async function withAdmin<T>(env: TestDbEnv, fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: env.adminUrl,
    application_name: 'bantoozi-e2e',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function createdComment(at: Date): string {
  return `${CREATED_PREFIX}${at.toISOString()}`;
}

/** The creation time stored by {@link createE2eDatabase}, or undefined for any other comment. */
export function parseCreatedComment(comment: string | null): Date | undefined {
  if (comment === null || !comment.startsWith(CREATED_PREFIX)) return undefined;
  const at = new Date(comment.slice(CREATED_PREFIX.length));
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Copies the ready `template` into `name` (owner `bantoozi_owner`, CONNECT for the app and worker
 * roles only) under the template lock, so a template rebuild never races the copy, and records the
 * creation time as the database comment. Fails when `name` exists: a run never touches a database
 * it did not create.
 */
export async function createE2eDatabase(input: {
  env: TestDbEnv;
  name: string;
  template: string;
  now?: Date;
}): Promise<void> {
  assertE2eDatabaseName(input.name);
  if (!TEMPLATE_NAME.test(input.template)) throw new Error(`invalid template ${input.template}`);
  const comment = createdComment(input.now ?? new Date());
  await withAdmin(input.env, async (admin) => {
    await admin.query(`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`);
    try {
      const marker = await admin.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
        [input.template],
      );
      if (marker.rows[0]?.marker !== READY_MARKER) {
        throw new Error(`template ${input.template} is not ready`);
      }
      const name = quoteIdent(input.name);
      await admin.query(
        `CREATE DATABASE ${name} TEMPLATE ${quoteIdent(input.template)} OWNER bantoozi_owner`,
      );
      await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${name} TO bantoozi_app, bantoozi_worker`);
      // The comment is an ISO timestamp with a fixed prefix: nothing to escape.
      await admin.query(`COMMENT ON DATABASE ${name} IS '${comment}'`);
    } finally {
      await admin.query(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`);
    }
  });
}

/** Drops the run's database even if some process is still connected to it. */
export async function dropE2eDatabase(env: TestDbEnv, name: string): Promise<void> {
  assertE2eDatabaseName(name);
  await withAdmin(env, (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
  );
}

export interface SweepResult {
  dropped: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * Drops `bantoozi_e2e_*` databases that were created more than `maxAgeMs` ago and have no
 * connection. A database without a creation comment, the one named `keep` and any that is in use
 * are left alone.
 */
export async function sweepStaleE2eDatabases(input: {
  env: TestDbEnv;
  keep: string;
  now?: Date;
  maxAgeMs?: number;
}): Promise<SweepResult> {
  const now = (input.now ?? new Date()).getTime();
  const maxAgeMs = input.maxAgeMs ?? E2E_STALE_AFTER_MS;
  const result: SweepResult = { dropped: [], failed: [] };
  await withAdmin(input.env, async (admin) => {
    const { rows } = await admin.query<{
      name: string;
      comment: string | null;
      connected: boolean;
    }>(
      `SELECT d.datname AS name, shobj_description(d.oid, 'pg_database') AS comment,
              EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname) AS connected
         FROM pg_database d
        WHERE d.datname ~ $1`,
      [E2E_DATABASE_NAME.source],
    );
    for (const row of rows) {
      if (row.name === input.keep || row.connected) continue;
      const createdAt = parseCreatedComment(row.comment);
      if (createdAt === undefined || now - createdAt.getTime() < maxAgeMs) continue;
      try {
        assertE2eDatabaseName(row.name);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(row.name)}`);
        result.dropped.push(row.name);
      } catch (error) {
        result.failed.push({ name: row.name, error: String(error) });
      }
    }
  });
  return result;
}
