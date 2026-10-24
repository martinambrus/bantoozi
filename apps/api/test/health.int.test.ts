import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  PG_BOSS_CRON_QUEUE,
  createDatabase,
  createPool,
  runMigrations,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { testConfig } from './support/harness.js';

let testDb: TestDatabase;
let appPool: ReturnType<typeof createPool>;
let ownerPool: ReturnType<typeof createPool>;
let server: FastifyInstance;

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'api',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  appPool = createPool({ connectionString: testDb.urls.app, max: 2 });
  ownerPool = createPool({ connectionString: testDb.urls.owner, max: 1 });
});

beforeEach(async () => {
  await server?.close();
  server = await buildServer({
    db: createDatabase(appPool),
    config: testConfig({}, testDb.urls.app),
    libreTranslate: null,
  });
});

afterAll(async () => {
  await server.close();
  await appPool.end();
  await ownerPool.end();
  await dropCreatedTestDatabases();
});

describe('health (spec 08 §10)', () => {
  it.each(['user.estimate', PG_BOSS_CRON_QUEUE])(
    'is 503 naming missing queue %s with current migrations, then recovers after migrate',
    async (queue) => {
      await expect(appPool.query('SELECT name FROM pgboss.queue')).rejects.toThrow(
        /permission denied/u,
      );
      await ownerPool.query('DELETE FROM pgboss.job WHERE name = $1', [queue]);
      await ownerPool.query('SELECT pgboss.delete_queue($1)', [queue]);
      try {
        const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({
          status: 'not_ready',
          checks: { database: 'ok', migrations: 'ok', queues: 'pending' },
          missingQueues: [queue],
        });
        expect(res.headers['cache-control']).toBe('no-store');
      } finally {
        await runMigrations({ databaseUrl: testDb.urls.owner });
      }
      const healed = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(healed.statusCode).toBe(200);
      expect(healed.json()).toMatchObject({ checks: { queues: 'ok' }, missingQueues: [] });
    },
  );

  it('fails closed without leaking errors when the queue catalog cannot be read', async () => {
    await ownerPool.query('REVOKE EXECUTE ON FUNCTION queue_state_counts() FROM bantoozi_app');
    try {
      const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        checks: { database: 'ok', migrations: 'ok', queues: 'unreachable' },
        missingQueues: [],
      });
      expect(res.body).not.toContain('permission denied');
    } finally {
      await ownerPool.query('GRANT EXECUTE ON FUNCTION queue_state_counts() TO bantoozi_app');
    }
  });

  it('GET /api/v1/healthz is 200 while the process runs', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/readyz is 200 when the newest applied migration is the newest bundled one', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', migrations: 'ok', queues: 'ok' },
      missingQueues: [],
    });
  });

  it('is 503 while a bundled migration is not applied', async () => {
    const newest = await ownerPool.query<{ id: number; hash: string; created_at: string }>(
      'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
    );
    const row = newest.rows[0];
    if (row === undefined) throw new Error('no applied migrations');
    await ownerPool.query('DELETE FROM drizzle.__drizzle_migrations WHERE id = $1', [row.id]);
    try {
      const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'ok', migrations: 'pending', queues: 'ok' },
        missingQueues: [],
      });
    } finally {
      await ownerPool.query(
        'INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)',
        [row.id, row.hash, row.created_at],
      );
    }
  });

  it('is 200 when the database is ahead of the release (rollback over an expanded schema)', async () => {
    const newest = await ownerPool.query<{ created_at: string }>(
      'SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations',
    );
    const inserted = await ownerPool.query<{ id: number }>(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('synthetic-newer', $1) RETURNING id",
      [Number(newest.rows[0]?.created_at) + 1000],
    );
    try {
      const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', migrations: 'ok', queues: 'ok' },
        missingQueues: [],
      });
    } finally {
      await ownerPool.query('DELETE FROM drizzle.__drizzle_migrations WHERE id = $1', [
        inserted.rows[0]?.id,
      ]);
    }
  });

  it('is 503 without leaking details when the database is unreachable, with limits on', async () => {
    const url = new URL(testDb.urls.app);
    url.port = '1';
    const deadPool = createPool({ connectionString: url.toString(), max: 1 });
    const offline = await buildServer({
      db: createDatabase(deadPool),
      // Rate limits on: the DB-backed limiter must not turn the probes into a 500.
      config: testConfig({ RATE_LIMITS_ENABLED: 'true' }, url.toString()),
      libreTranslate: null,
    });
    try {
      const live = await offline.inject({ method: 'GET', url: '/api/v1/healthz' });
      expect(live.statusCode).toBe(200);
      const res = await offline.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'unreachable', migrations: 'pending', queues: 'pending' },
        missingQueues: [],
      });
      expect(res.body).not.toContain('bantoozi_app');
    } finally {
      await offline.close();
      await deadPool.end();
    }
  });
});
