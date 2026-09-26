import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { QUEUE_NAMES, QUEUES } from '@bantoozi/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrationStatus, readMigrationJournal } from '../src/readiness.js';
import {
  MIGRATIONS_FOLDER,
  PG_BOSS_SCHEMA,
  PG_BOSS_SCHEMA_VERSION,
  PG_BOSS_VERSION,
  runMigrations,
} from '../src/migrate/migrate.js';
import { setupDbTest, sqlStateOf, withConnection, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

describe('migrate job', () => {
  it('pins the installed pg-boss release', () => {
    const require = createRequire(import.meta.url);
    const pkg = require('pg-boss/package.json') as { version: string };
    expect(pkg.version).toBe(PG_BOSS_VERSION);
  });

  it('is idempotent: a re-run applies nothing and keeps every queue', async () => {
    const result = await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
    expect(result).toEqual({ pgBoss: 'current', migrationsApplied: 0, queues: QUEUE_NAMES.length });
  });

  it('records every bundled migration, so readiness is green', async () => {
    const journal = readMigrationJournal(MIGRATIONS_FOLDER);
    const applied = await ctx.owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(applied.rows[0]?.n).toBe(journal.count);
    // The API role reads readiness through its explicit grant (spec 02 §1.2).
    await expect(migrationStatus(ctx.app, journal)).resolves.toEqual({
      ready: true,
      expectedLatest: journal.latestWhen,
      appliedLatest: journal.latestWhen,
    });
  });

  it('creates the pinned pg-boss schema owned by bantoozi_owner', async () => {
    const version = await ctx.owner.query<{ version: number }>(
      'SELECT version FROM pgboss.version',
    );
    expect(version.rows[0]?.version).toBe(PG_BOSS_SCHEMA_VERSION);
    const owners = await ctx.owner.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss'`,
    );
    expect(owners.rows.map((r) => r.owner)).toEqual(['bantoozi_owner']);
  });

  it('creates every jobs.ts queue with its options and an owner-created partition', async () => {
    const queues = await ctx.owner.query<{
      name: string;
      policy: string;
      retry_limit: number | null;
      retry_delay: number | null;
      retry_backoff: boolean | null;
      expire_seconds: number | null;
      partition_owner: string;
      worker_dml: boolean;
    }>(
      `SELECT q.name, q.policy, q.retry_limit, q.retry_delay, q.retry_backoff, q.expire_seconds,
              pg_get_userbyid(c.relowner) AS partition_owner,
              has_table_privilege('bantoozi_worker', c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS worker_dml
         FROM pgboss.queue q JOIN pg_class c ON c.relname = q.partition_name
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'pgboss'
        ORDER BY q.name`,
    );
    expect(queues.rows.map((q) => q.name)).toEqual([...QUEUE_NAMES].sort());
    for (const row of queues.rows) {
      const options = QUEUES[row.name as keyof typeof QUEUES].options;
      expect(row).toMatchObject({
        policy: options.policy,
        retry_limit: options.retryLimit,
        retry_delay: options.retryDelay ?? null,
        retry_backoff: options.retryBackoff ?? null,
        expire_seconds: options.expireInSeconds ?? null,
        partition_owner: 'bantoozi_owner',
        worker_dml: true,
      });
    }
  });

  it('keeps pg-boss away from the API role, which sees aggregate counts only', async () => {
    expect(await sqlStateOf(ctx.appPool.query('SELECT count(*) FROM pgboss.job'))).toBe('42501');
    const counts = await ctx.appPool.query('SELECT * FROM queue_state_counts()');
    expect(counts.fields.map((f) => f.name)).toEqual([
      'queue',
      'created',
      'retry',
      'active',
      'completed',
      'cancelled',
      'failed',
    ]);
    expect(counts.rows).toHaveLength(QUEUE_NAMES.length);
  });

  it('lets the worker use pg-boss without owning it', async () => {
    const privileges = await ctx.workerPool.query<{ usage: boolean; create: boolean }>(
      `SELECT has_schema_privilege('pgboss', 'USAGE') AS usage,
              has_schema_privilege('pgboss', 'CREATE') AS create`,
    );
    expect(privileges.rows[0]).toEqual({ usage: true, create: false });
  });

  it('fails with a lock timeout instead of waiting for a held migrate lock', async () => {
    await withConnection(ctx.owner, async (holder) => {
      await holder.query("SELECT pg_advisory_lock(hashtext('bantoozi_migrate'))");
      try {
        const run = runMigrations({ databaseUrl: ctx.testDb.urls.owner, lockTimeoutMs: 300 });
        expect(await sqlStateOf(run)).toBe('55P03');
      } finally {
        await holder.query("SELECT pg_advisory_unlock(hashtext('bantoozi_migrate'))");
      }
    });
  });

  it('fails with a statement timeout and applies nothing when a migration hangs', async () => {
    const journal = readMigrationJournal(MIGRATIONS_FOLDER);
    const folder = await mkdtemp(path.join(tmpdir(), 'bantoozi-migrate-'));
    try {
      const tag = '9999_hanging';
      await mkdir(path.join(folder, 'meta'));
      await writeFile(path.join(folder, `${tag}.sql`), 'SELECT pg_sleep(30);');
      await writeFile(
        path.join(folder, 'meta', '_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [{ idx: 0, version: '7', when: journal.latestWhen + 1, tag, breakpoints: true }],
        }),
      );
      const run = runMigrations({
        databaseUrl: ctx.testDb.urls.owner,
        migrationsFolder: folder,
        statementTimeoutMs: 500,
      });
      expect(await sqlStateOf(run)).toBe('57014');
      const applied = await ctx.owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
      );
      expect(applied.rows[0]?.n).toBe(journal.count);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('reports a timeout inside a pg-boss plan, not the aborted transaction it leaves', async () => {
    // pg-boss runs each plan in its own BEGIN … COMMIT under this transaction advisory lock, so
    // holding the lock stops the 23 → 24 upgrade plan at a statement timeout inside that BEGIN.
    const bossLockKey = `('x' || encode(sha224((current_database() || '.pgboss.${PG_BOSS_SCHEMA}')::bytea), 'hex'))::bit(64)::bigint`;
    const setVersion = `UPDATE ${PG_BOSS_SCHEMA}.version SET version = $1`;
    await withConnection(ctx.owner, async (holder) => {
      await holder.query(setVersion, [PG_BOSS_SCHEMA_VERSION - 1]);
      await holder.query(`SELECT pg_advisory_lock(${bossLockKey})`);
      try {
        const run = runMigrations({ databaseUrl: ctx.testDb.urls.owner, statementTimeoutMs: 500 });
        expect(await sqlStateOf(run)).toBe('57014');
      } finally {
        await holder.query(`SELECT pg_advisory_unlock(${bossLockKey})`);
        await holder.query(setVersion, [PG_BOSS_SCHEMA_VERSION]);
      }
    });
    // Nothing stayed locked or half-applied: the next run finds everything current.
    await expect(runMigrations({ databaseUrl: ctx.testDb.urls.owner })).resolves.toEqual({
      pgBoss: 'current',
      migrationsApplied: 0,
      queues: QUEUE_NAMES.length,
    });
  });
});
