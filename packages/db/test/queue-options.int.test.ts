import { QUEUES, type QueueCreateOptions } from '@bantoozi/shared';
import type * as Shared from '@bantoozi/shared';
import { createTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PG_BOSS_CRON_QUEUE, runMigrations } from '../src/migrate/migrate.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

// A test registry: changing it must reach the real migrate job without changing production options.
vi.mock('@bantoozi/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return {
    ...actual,
    QUEUES: Object.fromEntries(
      Object.entries(actual.QUEUES).map(([name, spec]) => [
        name,
        { ...spec, options: { ...spec.options } },
      ]),
    ),
  };
});

let ctx: DbTestContext;
const name = 'feed.schedule';
const originalOptions = QUEUES[name].options;
const managedColumns = 'policy, retry_limit, retry_delay, retry_backoff, expire_seconds';

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

describe('queue option convergence', () => {
  it.each(['retryDelay', 'retryBackoff', 'expireInSeconds', 'all'] as const)(
    'matches a fresh database after removing %s from the registry',
    async (removed) => {
      const fresh = await createTestDatabase({
        pkg: 'db_queue_options',
        template: ctx.testDb.template,
      });
      const freshClient = new pg.Client({ connectionString: fresh.urls.owner });
      try {
        await freshClient.connect();
        const options: QueueCreateOptions = {
          policy: 'stately',
          retryLimit: 7,
          retryDelay: 19,
          retryBackoff: true,
          expireInSeconds: 90,
        };
        QUEUES[name].options = options;
        await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
        const configured = await ctx.owner.query(
          `SELECT ${managedColumns} FROM pgboss.queue WHERE name = $1`,
          [name],
        );
        expect(configured.rows).toEqual([
          {
            policy: 'stately',
            retry_limit: 7,
            retry_delay: 19,
            retry_backoff: true,
            expire_seconds: 90,
          },
        ]);

        if (removed === 'all') {
          delete options.retryDelay;
          delete options.retryBackoff;
          delete options.expireInSeconds;
        } else {
          delete options[removed];
        }
        // Ensure the comparison queue is newly created by pg-boss, even if the template is reused.
        await freshClient.query('SELECT pgboss.delete_queue($1)', [name]);
        await runMigrations({ databaseUrl: fresh.urls.owner });
        await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
        const existing = await ctx.owner.query(
          `SELECT ${managedColumns} FROM pgboss.queue WHERE name = $1`,
          [name],
        );
        const created = await freshClient.query(
          `SELECT ${managedColumns} FROM pgboss.queue WHERE name = $1`,
          [name],
        );
        expect(existing.rows).toEqual(created.rows);
      } finally {
        QUEUES[name].options = originalOptions;
        await freshClient.end();
        await fresh.drop();
        await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
      }
    },
  );

  it('preserves explicit zero and false options', async () => {
    try {
      QUEUES[name].options = { ...originalOptions, retryDelay: 0, retryBackoff: false };
      await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
      const result = await ctx.owner.query(
        'SELECT retry_delay, retry_backoff FROM pgboss.queue WHERE name = $1',
        [name],
      );
      expect(result.rows).toEqual([{ retry_delay: 0, retry_backoff: false }]);
    } finally {
      QUEUES[name].options = originalOptions;
      await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
    }
  });

  it('rolls back queue changes when a later registry entry is invalid', async () => {
    const lastName = 'house.rematch';
    const lastOptions = QUEUES[lastName].options;
    const before = await ctx.owner.query('SELECT * FROM pgboss.queue WHERE name = $1', [name]);
    try {
      QUEUES[name].options = { ...originalOptions, retryDelay: 11 };
      QUEUES[lastName].options = { ...lastOptions, retryDelay: -1 };
      await expect(runMigrations({ databaseUrl: ctx.testDb.urls.owner })).rejects.toThrow();
      const after = await ctx.owner.query('SELECT * FROM pgboss.queue WHERE name = $1', [name]);
      expect(after.rows).toEqual(before.rows);
    } finally {
      QUEUES[name].options = originalOptions;
      QUEUES[lastName].options = lastOptions;
      await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
    }
  });

  it('leaves unregistered queues and unmanaged columns unchanged', async () => {
    const boss = new PgBoss({
      db: { executeSql: (text, values) => ctx.owner.query(text, values) },
    });
    const unmanagedName = 'test.unmanaged';
    await boss.createQueue(unmanagedName, {
      name: unmanagedName,
      retryDelay: 17,
      retryBackoff: true,
    });
    await ctx.owner.query('UPDATE pgboss.queue SET retry_delay = 23 WHERE name = $1', [
      PG_BOSS_CRON_QUEUE,
    ]);
    await ctx.owner.query(
      'UPDATE pgboss.queue SET retention_minutes = 141, dead_letter = $2 WHERE name = $1',
      [name, unmanagedName],
    );
    const readUnmanaged = () =>
      ctx.owner.query('SELECT * FROM pgboss.queue WHERE name = ANY($1) ORDER BY name', [
        [unmanagedName, PG_BOSS_CRON_QUEUE],
      ]);
    const before = await readUnmanaged();
    await runMigrations({ databaseUrl: ctx.testDb.urls.owner });
    expect((await readUnmanaged()).rows).toEqual(before.rows);
    const result = await ctx.owner.query(
      'SELECT retention_minutes, dead_letter FROM pgboss.queue WHERE name = $1',
      [name],
    );
    expect(result.rows).toEqual([{ retention_minutes: 141, dead_letter: unmanagedName }]);
  });
});
