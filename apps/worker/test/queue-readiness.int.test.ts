import {
  MIGRATIONS_FOLDER,
  PG_BOSS_CRON_QUEUE,
  PG_BOSS_VERSION,
  createDatabase,
  runMigrations,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createBoss, startWorkerSchedules } from '../src/boss.js';
import { startHeartbeat } from '../src/eval-mode.js';
import {
  QUEUES_MISSING_KEY,
  missingRegistryQueues,
  startQueueReadiness,
} from '../src/readiness.js';

/** Queue readiness (FNF-VL-3 item 2): the worker names registry queues missing from pg-boss. */
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: ReturnType<typeof createDatabase>;

function recording() {
  const logs: { level: 'info' | 'warn' | 'error'; obj: object; msg: string }[] = [];
  const logger = {
    info: (obj: object, msg: string) => logs.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg: string) => logs.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg: string) => logs.push({ level: 'error', obj, msg }),
  };
  return { logs, logger };
}

const count = (logs: { level: string }[], level: string) =>
  logs.filter((l) => l.level === level).length;

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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
  db = createDatabase(workerPool);
});

afterEach(async () => {
  await runMigrations({ databaseUrl: testDb.urls.owner });
});

afterAll(async () => {
  await owner.end();
  await workerPool.end();
  await dropCreatedTestDatabases();
});

async function dropQueue(name: string) {
  await owner.query('DELETE FROM pgboss.job WHERE name = $1', [name]);
  await owner.query('SELECT pgboss.delete_queue($1)', [name]);
}

describe('missingRegistryQueues', () => {
  it('lists exactly the deleted queue and nothing after the migrate job ran', async () => {
    expect(await missingRegistryQueues(db)).toEqual([]);
    await dropQueue('user.estimate');
    expect(await missingRegistryQueues(db)).toEqual(['user.estimate']);
    await runMigrations({ databaseUrl: testDb.urls.owner });
    expect(await missingRegistryQueues(db)).toEqual([]);
  });
});

describe("pg-boss's internal cron queue", () => {
  it('is required too: without it boss.schedule succeeds and no cron ever fires', async () => {
    expect(await missingRegistryQueues(db)).toEqual([]);
    await dropQueue(PG_BOSS_CRON_QUEUE);
    try {
      expect(await missingRegistryQueues(db)).toEqual([PG_BOSS_CRON_QUEUE]);
      const { logs, logger } = recording();
      const readiness = await startQueueReadiness({ db, logger, intervalMs: 3_600_000 });
      try {
        expect(count(logs, 'error')).toBe(1);
        expect(readiness.problems()[0]?.message).toContain(PG_BOSS_CRON_QUEUE);
      } finally {
        readiness.stop();
      }
    } finally {
      // Restore directly for isolation; the migrate job also repairs this queue on every run.
      await owner.query(
        `SELECT pgboss.create_queue('${PG_BOSS_CRON_QUEUE}', '{"policy":"standard"}'::json)`,
      );
    }
    expect(await missingRegistryQueues(db)).toEqual([]);
  });
});

describe('startQueueReadiness', () => {
  it('logs one error, reports a problem and clears it once the queue is back', async () => {
    await dropQueue('user.estimate');
    const { logs, logger } = recording();
    const readiness = await startQueueReadiness({ db, logger, intervalMs: 3_600_000 });
    try {
      expect(count(logs, 'error')).toBe(1);
      expect(JSON.stringify(logs[0])).toContain('user.estimate');
      expect(readiness.missing()).toEqual(['user.estimate']);
      const [problem, ...rest] = readiness.problems();
      expect(rest).toEqual([]);
      expect(problem?.key).toBe(QUEUES_MISSING_KEY);
      expect(problem?.message).toContain('user.estimate');

      await readiness.refresh();
      expect(count(logs, 'error')).toBe(1);

      await runMigrations({ databaseUrl: testDb.urls.owner });
      await readiness.refresh();
      expect(readiness.problems()).toEqual([]);
      expect(count(logs, 'info')).toBe(1);
      await readiness.refresh();
      expect(logs).toHaveLength(2);
    } finally {
      readiness.stop();
    }
  });

  it('logs nothing with every queue present', async () => {
    const { logs, logger } = recording();
    const readiness = await startQueueReadiness({ db, logger });
    readiness.stop();
    expect(logs).toEqual([]);
    expect(readiness.problems()).toEqual([]);
  });

  it('warns once and neither throws nor reports a problem when pgboss.queue is unreadable', async () => {
    const { logs, logger } = recording();
    const stub = {
      execute: () => Promise.reject(new Error('permission denied')),
    } as unknown as typeof db;
    const readiness = await startQueueReadiness({ db: stub, logger });
    readiness.stop();
    expect(count(logs, 'warn')).toBe(1);
    expect(readiness.problems()).toEqual([]);
  });

  it('reaches the stored heartbeat runtime problems', async () => {
    await dropQueue('user.estimate');
    const { logger } = recording();
    const readiness = await startQueueReadiness({ db, logger, intervalMs: 3_600_000 });
    const heartbeat = await startHeartbeat({
      db,
      processId: 'qr:1',
      queues: [],
      evalIngestOnly: false,
      envCredentials: [],
      logger: { warn: () => {}, error: () => {} },
      onGoldenDatabase: () => {},
      intervalMs: 3_600_000,
      runtime: () => ({ problems: readiness.problems() }),
    });
    try {
      await heartbeat.beat();
      const result = await owner.query<{ problems: { key: string }[] }>(
        `SELECT value -> 'qr:1' -> 'runtime' -> 'problems' AS problems FROM settings WHERE key = 'worker.heartbeat'`,
      );
      expect(result.rows[0]?.problems.map((p) => p.key)).toContain(QUEUES_MISSING_KEY);
    } finally {
      await heartbeat.stop();
      readiness.stop();
    }
  });
});

it('pins the real pg-boss missing schedule destination error and keeps scheduling alive', async () => {
  await dropQueue('house.alerts');
  const boss = createBoss(testDb.urls.worker);
  await boss.start();
  let schedules: Awaited<ReturnType<typeof startWorkerSchedules>> | undefined;
  try {
    await expect(boss.schedule('house.alerts', '*/5 * * * *', {}, { tz: 'UTC' })).rejects.toThrow(
      /^Queue house\.alerts not found$/,
    );
    const missing: string[] = [];
    schedules = await startWorkerSchedules(
      boss,
      ['house.alerts'],
      (queue) => missing.push(queue),
      recording().logger,
    );
    expect(missing).toEqual(['house.alerts']);
  } finally {
    schedules?.stop();
    await boss.stop({ graceful: true, timeout: 1_000 });
  }
});
