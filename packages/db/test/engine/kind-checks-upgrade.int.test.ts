import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CALL_KINDS } from '@bantoozi/shared';
import { setupTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '../../src/migrate/migrate.js';

let folder: string;
let remainingMigrationCount: number;
beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'bantoozi-kind-upgrade-'));
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const kept = journal.entries.filter((entry) => entry.idx <= 37);
  remainingMigrationCount = journal.entries.length - kept.length;
  await mkdir(path.join(folder, 'meta'));
  for (const entry of kept) {
    await cp(
      path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function with0037Database(run: (pool: pg.Pool, ownerUrl: string) => Promise<void>) {
  const old = await setupTestDatabase({
    pkg: 'kindup',
    migrationsDir: folder,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (databaseUrl) => {
      await runMigrations({ databaseUrl, migrationsFolder: folder });
    },
  });
  const pool = new pg.Pool({ connectionString: old.urls.owner });
  try {
    await run(pool, old.urls.owner);
  } finally {
    await pool.end();
    await old.drop();
  }
}

async function seedCurrentKinds(pool: pg.Pool) {
  for (const kind of CALL_KINDS) {
    await pool.query(
      `INSERT INTO engine_reservations
      (id, day, engine, kind, reserved_usd, status, expires_at)
      VALUES (gen_random_uuid(), '2035-01-01', 'llm', $1, 0.1, 'uncertain', now())`,
      [kind],
    );
    await pool.query(
      `INSERT INTO usage_daily (day, user_id, engine, kind, cost_usd)
      VALUES ('2035-01-01', '00000000-0000-0000-0000-000000000000', 'llm', $1, 0.1)`,
      [kind],
    );
  }
}

it('upgrades 0037 with every current kind without changing history', async () => {
  await with0037Database(async (pool, ownerUrl) => {
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows,
    ).toEqual([{ n: 38 }]);
    await seedCurrentKinds(pool);
    const rows = async (table: string) =>
      (await pool.query(`SELECT * FROM ${table} ORDER BY kind`)).rows;
    const reservations = await rows('engine_reservations');
    const usage = await rows('usage_daily');
    console.info('0037 seeded ledger sizes', {
      engine_reservations: reservations.length,
      usage_daily: usage.length,
    });
    expect((await runMigrations({ databaseUrl: ownerUrl })).migrationsApplied).toBe(
      remainingMigrationCount,
    );
    expect(await rows('engine_reservations')).toEqual(reservations);
    expect(await rows('usage_daily')).toEqual(usage);
    const checks = await pool.query<{ conname: string; convalidated: boolean }>(`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('engine_reservations_kind_check', 'usage_daily_kind_check') ORDER BY conname`);
    expect(checks.rows).toEqual([
      { conname: 'engine_reservations_kind_check', convalidated: true },
      { conname: 'usage_daily_kind_check', convalidated: true },
    ]);
    await expect(
      pool.query(`INSERT INTO engine_reservations
        (id, day, engine, kind, reserved_usd, status, expires_at)
        VALUES (gen_random_uuid(), '2035-01-02', 'llm', 'unknown_kind', 0, 'reserved', now())`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'engine_reservations_kind_check' });
    await expect(
      pool.query(`INSERT INTO usage_daily (day, user_id, engine, kind)
        VALUES ('2035-01-02', '00000000-0000-0000-0000-000000000000', 'llm', 'unknown_kind')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'usage_daily_kind_check' });
    expect((await runMigrations({ databaseUrl: ownerUrl })).migrationsApplied).toBe(0);
  });
});

it.each(['engine_reservations', 'usage_daily'])(
  'rejects an unknown historical kind in %s during migration and rolls back 0038',
  async (table) => {
    await with0037Database(async (pool, ownerUrl) => {
      await seedCurrentKinds(pool);
      if (table === 'engine_reservations') {
        await pool.query(`INSERT INTO engine_reservations
          (id, day, engine, kind, reserved_usd, status, expires_at)
          VALUES (gen_random_uuid(), '2035-01-01', 'llm', 'unknown_kind', 0, 'uncertain', now())`);
      } else {
        await pool.query(`INSERT INTO usage_daily (day, user_id, engine, kind)
          VALUES ('2035-01-01', '00000000-0000-0000-0000-000000000000', 'llm', 'unknown_kind')`);
      }
      await expect(runMigrations({ databaseUrl: ownerUrl })).rejects.toMatchObject({
        cause: {
          code: '23514',
          constraint: `${table}_kind_check`,
          message: `check constraint "${table}_kind_check" of relation "${table}" is violated by some row`,
        },
      });
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows,
      ).toEqual([{ n: 38 }]);
      expect(
        (
          await pool.query(`SELECT conname FROM pg_constraint
        WHERE conname IN ('engine_reservations_kind_check', 'usage_daily_kind_check')`)
        ).rows,
      ).toEqual([]);
      expect(
        (await pool.query(`SELECT to_regprocedure('admin_committed_spend(date,text[])') AS fn`))
          .rows,
      ).toEqual([{ fn: null }]);
      expect(
        (await pool.query(`SELECT kind FROM ${table} WHERE kind = 'unknown_kind'`)).rows,
      ).toEqual([{ kind: 'unknown_kind' }]);
      await pool.query(`DELETE FROM ${table} WHERE kind = 'unknown_kind'`);
      expect((await runMigrations({ databaseUrl: ownerUrl })).migrationsApplied).toBe(
        remainingMigrationCount,
      );
      expect((await runMigrations({ databaseUrl: ownerUrl })).migrationsApplied).toBe(0);
    });
  },
);
