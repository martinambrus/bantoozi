import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import {
  computeTemplateHash,
  createTestDatabase,
  dropCreatedTestDatabases,
  ensureTemplate,
  quoteIdent,
  roleUrl,
  templateDatabaseName,
  testDbEnv,
  type MigrateFn,
} from '../src/index.js';

// Real Postgres from infra/compose.test.yml (pnpm db:test:up). Synthetic templates use random
// hashes so they never collide with real schema templates; this file drops everything it creates.
const env = testDbEnv();
const syntheticTemplates = new Set<string>();

async function admin<T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(env, 'postgres', database) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return admin(
    async (c) =>
      (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1,
  );
}

/** A fake migrate job: creates a marker table as the owner, slowly enough to widen races. */
function markerMigrate(calls: string[], delayMs = 300): MigrateFn {
  return async (ownerUrl) => {
    calls.push(ownerUrl);
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      await client.query('CREATE TABLE migrated_marker (id int PRIMARY KEY)');
      await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      await client.end();
    }
  };
}

function syntheticHash(): string {
  const hash = randomBytes(6).toString('hex');
  syntheticTemplates.add(templateDatabaseName(hash));
  return hash;
}

afterAll(async () => {
  await dropCreatedTestDatabases(env);
  await admin(async (c) => {
    for (const name of syntheticTemplates) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
        name,
      ]);
      await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    }
  });
});

describe('per-worktree test databases (spec 02 §1.1)', () => {
  it('creates a template once when two requests race for it', async () => {
    const hash = syntheticHash();
    const calls: string[] = [];
    const migrate = markerMigrate(calls);
    const [a, b] = await Promise.all([
      ensureTemplate({ hash, migrate, env }),
      ensureTemplate({ hash, migrate, env }),
    ]);
    expect(a).toBe(templateDatabaseName(hash));
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('bantoozi_owner');
    // Ready marker, owner, extensions and the production database ACL.
    const info = await admin(
      async (c) =>
        (
          await c.query<{ marker: string; owner: string; acl: string }>(
            `SELECT shobj_description(oid, 'pg_database') AS marker, pg_get_userbyid(datdba) AS owner,
                  datacl::text AS acl FROM pg_database WHERE datname = $1`,
            [a],
          )
        ).rows[0],
    );
    expect(info).toMatchObject({ marker: 'bantoozi-template-ready', owner: 'bantoozi_owner' });
    expect(info?.acl).toContain('bantoozi_app=c/');
    expect(info?.acl).not.toMatch(/(^|[{,])=/); // no PUBLIC entry
    const extensions = await admin(
      async (c) =>
        (
          await c.query<{ extname: string }>('SELECT extname FROM pg_extension ORDER BY 1')
        ).rows.map((r) => r.extname),
      a,
    );
    expect(extensions).toEqual(['citext', 'pg_trgm', 'pgcrypto', 'plpgsql']);
    // A later request reuses the ready template without migrating again.
    await ensureTemplate({ hash, migrate, env });
    expect(calls).toHaveLength(1);
  });

  it('uses a new template when the journal content changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bantoozi-journal-'));
    try {
      await mkdir(path.join(dir, 'meta'));
      await writeFile(path.join(dir, '0000_init.sql'), 'SELECT 1;');
      await writeFile(path.join(dir, 'meta', '_journal.json'), '{"entries":[0]}');
      const first = await computeTemplateHash({ migrationsDir: dir, pgBossVersion: '10.4.2' });
      await writeFile(path.join(dir, 'meta', '_journal.json'), '{"entries":[0],"tag":"changed"}');
      const second = await computeTemplateHash({ migrationsDir: dir, pgBossVersion: '10.4.2' });
      expect(second).not.toBe(first);
      syntheticTemplates.add(templateDatabaseName(first));
      syntheticTemplates.add(templateDatabaseName(second));
      const calls: string[] = [];
      const t1 = await ensureTemplate({ hash: first, migrate: markerMigrate(calls, 0), env });
      const t2 = await ensureTemplate({ hash: second, migrate: markerMigrate(calls, 0), env });
      expect(t1).not.toBe(t2);
      expect(calls).toHaveLength(2);
      expect(await databaseExists(t1)).toBe(true);
      expect(await databaseExists(t2)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives two worktrees separate cloned databases', async () => {
    const hash = syntheticHash();
    const template = await ensureTemplate({ hash, migrate: markerMigrate([], 0), env });
    const a = await createTestDatabase({
      pkg: 'db',
      template,
      worktreeRoot: '/work/bantoozi',
      env,
    });
    const b = await createTestDatabase({
      pkg: 'db',
      template,
      worktreeRoot: '/work/bantoozi-m2',
      env,
    });
    expect(a.name).not.toBe(b.name);
    expect(a.name).toMatch(/^bantoozi_test_[0-9a-f]{8}_db_[0-9a-f]+$/);
    for (const db of [a, b]) {
      expect(await databaseExists(db.name)).toBe(true);
      // Cloned from the migrated template, and reachable with the role logins.
      const app = new pg.Client({ connectionString: db.urls.app });
      await app.connect();
      try {
        const { rows } = await app.query<{ user: string; marker: string | null }>(
          "SELECT current_user AS user, to_regclass('public.migrated_marker')::text AS marker",
        );
        expect(rows[0]).toEqual({ user: 'bantoozi_app', marker: 'migrated_marker' });
      } finally {
        await app.end();
      }
    }
    // Writes in one worktree's database are invisible in the other's.
    await admin((c) => c.query('INSERT INTO migrated_marker VALUES (1)'), a.name);
    const countB = await admin(
      async (c) => (await c.query('SELECT count(*)::int AS n FROM migrated_marker')).rows[0],
      b.name,
    );
    expect(countB).toEqual({ n: 0 });
    await a.drop();
    expect(await databaseExists(a.name)).toBe(false);
  });

  it('rebuilds an incomplete template and removes a template whose migration failed', async () => {
    const hash = syntheticHash();
    const name = templateDatabaseName(hash);
    await admin((c) => c.query(`CREATE DATABASE ${quoteIdent(name)} OWNER bantoozi_owner`)); // crashed run
    const calls: string[] = [];
    await ensureTemplate({ hash, migrate: markerMigrate(calls, 0), env });
    expect(calls).toHaveLength(1);

    const failing = syntheticHash();
    await expect(
      ensureTemplate({
        hash: failing,
        migrate: () => Promise.reject(new Error('migration failed')),
        env,
      }),
    ).rejects.toThrow('migration failed');
    expect(await databaseExists(templateDatabaseName(failing))).toBe(false);
  });
});
