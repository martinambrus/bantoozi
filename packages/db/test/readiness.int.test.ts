import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from '../src/migrate/migrate.js';
import { migrationStatus, readMigrationJournal } from '../src/readiness.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const journal = () => readMigrationJournal(MIGRATIONS_FOLDER);

describe('migrationStatus (spec 11 §3.6: a database ahead of the release is ready)', () => {
  it('equal: every bundled migration applied, nothing newer', async () => {
    const j = journal();
    await expect(migrationStatus(ctx.app, j)).resolves.toEqual({
      ready: true,
      expectedLatest: j.latestWhen,
      appliedLatest: j.latestWhen,
      newerApplied: 0,
    });
  });

  it('behind: the newest bundled migration is missing -> not ready', async () => {
    const j = journal();
    const newest = await ctx.owner.query<{ id: number; hash: string; created_at: string }>(
      'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
    );
    const row = newest.rows[0]!;
    await ctx.owner.query('DELETE FROM drizzle.__drizzle_migrations WHERE id = $1', [row.id]);
    try {
      const status = await migrationStatus(ctx.app, j);
      expect(status.ready).toBe(false);
      expect(status.expectedLatest).toBe(j.latestWhen);
      expect(status.appliedLatest).toBeLessThan(j.latestWhen);
    } finally {
      await ctx.owner.query(
        'INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)',
        [row.id, row.hash, row.created_at],
      );
    }
  });

  it('ahead by one synthetic newer row -> ready, reported as newerApplied', async () => {
    const j = journal();
    const inserted = await ctx.owner.query<{ id: number }>(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('synthetic-newer', $1) RETURNING id",
      [j.latestWhen + 1000],
    );
    try {
      await expect(migrationStatus(ctx.app, j)).resolves.toEqual({
        ready: true,
        expectedLatest: j.latestWhen,
        appliedLatest: j.latestWhen + 1000,
        newerApplied: 1,
      });
    } finally {
      await ctx.owner.query('DELETE FROM drizzle.__drizzle_migrations WHERE id = $1', [
        inserted.rows[0]!.id,
      ]);
    }
  });

  it('a missing middle migration is not ready even with the newest present and a newer row', async () => {
    const j = journal();
    expect(j.whens.length).toBeGreaterThan(2);
    const middle = [...j.whens].sort((a, b) => a - b)[1]!;
    const removed = await ctx.owner.query<{ id: number; hash: string; created_at: string }>(
      'DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1 RETURNING id, hash, created_at',
      [middle],
    );
    const row = removed.rows[0]!;
    const synthetic = await ctx.owner.query<{ id: number }>(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('synthetic-newer', $1) RETURNING id",
      [j.latestWhen + 1000],
    );
    try {
      const status = await migrationStatus(ctx.app, j);
      expect(status.ready).toBe(false);
      expect(status.newerApplied).toBe(1);
    } finally {
      await ctx.owner.query('DELETE FROM drizzle.__drizzle_migrations WHERE id = $1', [
        synthetic.rows[0]!.id,
      ]);
      await ctx.owner.query(
        'INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)',
        [row.id, row.hash, row.created_at],
      );
    }
  });
});
