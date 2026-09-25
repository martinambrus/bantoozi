import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  createPool,
  runMigrations,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

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
  server = await buildServer({ db: createDatabase(appPool) });
});

afterAll(async () => {
  await server.close();
  await appPool.end();
  await ownerPool.end();
  await dropCreatedTestDatabases();
});

describe('health (spec 08 §10)', () => {
  it('GET /api/v1/healthz is 200 while the process runs', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/readyz is 200 when the newest applied migration is the newest bundled one', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
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
        checks: { database: 'ok', migrations: 'pending' },
      });
    } finally {
      await ownerPool.query(
        'INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)',
        [row.id, row.hash, row.created_at],
      );
    }
  });

  it('is 503 without leaking details when the database is unreachable', async () => {
    const url = new URL(testDb.urls.app);
    url.port = '1';
    const deadPool = createPool({ connectionString: url.toString(), max: 1 });
    const offline = await buildServer({ db: createDatabase(deadPool) });
    try {
      const res = await offline.inject({ method: 'GET', url: '/api/v1/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'unreachable', migrations: 'pending' },
      });
      expect(res.body).not.toContain('bantoozi_app');
    } finally {
      await offline.close();
      await deadPool.end();
    }
  });
});
