import { MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import type PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBoss, registerHandlers } from '../src/boss.js';
import { isStageAvailable, type HandlerMap } from '../src/handlers/index.js';
import { StaleWorkerError } from '../src/stale-worker.js';

let testDb: TestDatabase;
let owner: pg.Pool;
let boss: PgBoss | undefined;

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let attempts = 0;

const handlers = {
  'article.enrich': {
    status: 'implemented',
    handle: async () => {
      attempts += 1;
      throw new StaleWorkerError('jev-1.13.0', 'jev-1.14.0');
    },
  },
} as unknown as HandlerMap;

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 2 });
  boss = createBoss(testDb.urls.worker);
  boss.on('error', () => {});
  await boss.start();
  expect(isStageAvailable(handlers, 'article.enrich')).toBe(true);
  await registerHandlers(boss, handlers, ['article.enrich'], silent);
});

afterAll(async () => {
  await boss?.stop({ graceful: false, timeout: 5_000, wait: true });
  await owner?.end();
  await dropCreatedTestDatabases();
});

describe('a guarded job that fails as stale', () => {
  it('waits the stale-worker delay before its retry instead of failing within seconds', async () => {
    const id = await boss!.send('article.enrich', { articleId: '1' });
    expect(id).toBeTruthy();
    const deadline = Date.now() + 15_000;
    let row:
      { state: string; retry_delay: number; retry_count: number; wait_s: number } | undefined;
    for (;;) {
      const found = await owner.query<NonNullable<typeof row>>(
        `SELECT state::text AS state, retry_delay, retry_count,
                extract(epoch FROM (start_after - now()))::float8 AS wait_s
           FROM pgboss.job WHERE id = $1`,
        [id],
      );
      row = found.rows[0];
      if (attempts > 0 && row !== undefined && row.state !== 'active' && row.state !== 'created') {
        break;
      }
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    expect(attempts).toBe(1);
    expect(row?.state).toBe('retry');
    expect(row?.retry_delay).toBe(30);
    expect(row?.wait_s).toBeGreaterThan(25);
    expect(row?.wait_s).toBeLessThanOrEqual(31);
    await sleep(2_500);
    expect(attempts).toBe(1);
  }, 30_000);
});
