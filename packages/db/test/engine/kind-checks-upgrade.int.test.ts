import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CALL_KINDS } from '@bantoozi/shared';
import { setupTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '../../src/migrate/migrate.js';

it('upgrades 0037 with current and legacy ledger rows without changing history', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'bantoozi-kind-upgrade-'));
  try {
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const kept = journal.entries.filter((entry) => entry.idx <= 37);
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
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows,
      ).toEqual([{ n: 38 }]);
      // D-63 moved credential validation from router.ask to credential_probe; no migration
      // renamed a historical kind. With no CHECK, arbitrary legacy strings remain possible.
      const historicalKinds = [...CALL_KINDS, 'backfill', 'legacy_probe', 'legacy_eval'];
      for (const kind of historicalKinds) {
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
      const rows = async (table: string) =>
        (await pool.query(`SELECT * FROM ${table} ORDER BY kind`)).rows;
      const reservations = await rows('engine_reservations');
      const usage = await rows('usage_daily');
      console.info('0037 seeded ledger sizes', {
        engine_reservations: reservations.length,
        usage_daily: usage.length,
      });
      expect((await runMigrations({ databaseUrl: old.urls.owner })).migrationsApplied).toBe(1);
      expect(await rows('engine_reservations')).toEqual(reservations);
      expect(await rows('usage_daily')).toEqual(usage);
      const checks = await pool.query<{ conname: string; convalidated: boolean }>(`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('engine_reservations_kind_check', 'usage_daily_kind_check') ORDER BY conname`);
      expect(checks.rows).toEqual([
        { conname: 'engine_reservations_kind_check', convalidated: false },
        { conname: 'usage_daily_kind_check', convalidated: false },
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
      expect((await runMigrations({ databaseUrl: old.urls.owner })).migrationsApplied).toBe(0);
    } finally {
      await pool.end();
      await old.drop();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
