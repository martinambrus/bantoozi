import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  runMigrations,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { buildJobIntent, type JobPayloadInput } from '@bantoozi/shared';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgBossBroker } from '../src/boss.js';
import { HANDLERS, type HandlerMap } from '../src/handlers/index.js';
import { relayOnce, type JobBroker } from '../src/outbox-relay.js';

/**
 * S19 outbox starvation (S18 findings Q3): a full-rank intent whose singleton key is held by a
 * pending full-rank job of the same user must be delivered as soon as the job is proven to cover
 * it, whatever reason either carries. Before the fix the relay demanded an identical payload for a
 * non-debounced key, so an intent with reason 'list' behind a job with reason 'feedback:rating'
 * stayed `singleton_conflict`, was retried every 5 s with a growing attempts count, and sat at the
 * head of the outbox forever. Over-coalescing guard: a continuation (cursor) has a key of its own
 * and is never swallowed by a pending full job.
 */

const USER = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f60';
const OTHER = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f61';

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let boss: PgBoss;
let broker: JobBroker;

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const handlers = {
  ...HANDLERS,
  'user.rank': { status: 'implemented', handle: async () => {} },
} as unknown as HandlerMap;

async function enqueueRank(payload: JobPayloadInput<'user.rank'>) {
  await db.transaction(async (tx) => {
    await workerOutbox(tx).enqueue(buildJobIntent('user.rank', payload));
  });
}

/** A full-rank job exactly as the relay sends one (key `rank-full:<user>`). */
async function sendFullJob(userId: string, reason: string) {
  return broker.send('user.rank', { userId, reason, full: true }, `rank-full:${userId}`);
}

async function outbox() {
  const result = await owner.query<{
    delivered: boolean;
    attempts: number;
    last_error: string | null;
    leased: boolean;
    payload: Record<string, unknown>;
  }>(
    `SELECT delivered_at IS NOT NULL AS delivered, attempts, last_error,
            lease_token IS NOT NULL AS leased, payload
       FROM job_outbox ORDER BY id`,
  );
  return result.rows;
}

async function pendingJobs(singletonKeyPrefix: string) {
  const result = await owner.query<{ singleton_key: string; data: Record<string, unknown> }>(
    `SELECT singleton_key, data FROM pgboss.job
      WHERE name = 'user.rank' AND state IN ('created', 'retry') AND singleton_key LIKE $1
      ORDER BY created_on`,
    [`${singletonKeyPrefix}%`],
  );
  return result.rows;
}

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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  db = createDatabase(workerPool);
  boss = new PgBoss({
    connectionString: testDb.urls.worker,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  broker = pgBossBroker(boss);
});

afterAll(async () => {
  await boss.stop({ graceful: false, wait: true });
  await owner.end();
  await workerPool.end();
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await owner.query('TRUNCATE job_outbox');
  await owner.query('DELETE FROM pgboss.job');
});

describe('full-rank intents behind a pending full-rank job', () => {
  it('delivers a list catch-up intent covered by a pending feedback:rating full job', async () => {
    expect(await sendFullJob(USER, 'feedback:rating')).not.toBeNull();
    await enqueueRank({ userId: USER, reason: 'list', full: true });

    const report = await relayOnce(db, broker, { handlers, logger: silent });

    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0, failed: 0 });
    expect(await outbox()).toEqual([
      expect.objectContaining({ delivered: true, attempts: 1, last_error: null, leased: false }),
    ]);
    // Still exactly one pending full-rank job for the user: the intent was absorbed, not doubled.
    const jobs = await pendingJobs(`rank-full:${USER}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ userId: USER, full: true });
    // Nothing left to retry: later passes claim nothing and attempts do not grow.
    expect((await relayOnce(db, broker, { handlers, logger: silent })).claimed).toBe(0);
    expect((await outbox())[0]?.attempts).toBe(1);
  });

  it('delivers the other direction too (a feedback:rating intent behind a list full job)', async () => {
    expect(await sendFullJob(USER, 'list')).not.toBeNull();
    await enqueueRank({ userId: USER, reason: 'feedback:rating', full: true });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-full:${USER}`)).toHaveLength(1);
  });

  it('still sends the full job when none is pending', async () => {
    await enqueueRank({ userId: USER, reason: 'list', full: true });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-full:${USER}`)).toHaveLength(1);
  });

  it("does not let another user's pending full job cover the intent", async () => {
    expect(await sendFullJob(OTHER, 'feedback:rating')).not.toBeNull();
    await enqueueRank({ userId: USER, reason: 'list', full: true });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-full:${USER}`)).toHaveLength(1);
    expect(await pendingJobs(`rank-full:${OTHER}`)).toHaveLength(1);
  });
});

describe('over-coalescing guards', () => {
  const cursorA = { arrival: '2026-10-01T10:00:00.000Z', articleId: '41' };
  const cursorB = { arrival: '2026-10-01T09:00:00.000Z', articleId: '17' };
  const snapshotAt = '2026-10-01T11:00:00.000Z';

  it('a cursor-bearing continuation is not swallowed by a pending full job', async () => {
    expect(await sendFullJob(USER, 'feedback:rating')).not.toBeNull();
    await enqueueRank({
      userId: USER,
      reason: 'rank-continuation',
      full: true,
      snapshotAt,
      cursor: cursorA,
    });

    const report = await relayOnce(db, broker, { handlers, logger: silent });

    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    const full = await pendingJobs(`rank-full:${USER}`);
    const continuations = await pendingJobs(`rank-cont:${USER}`);
    expect(full).toHaveLength(1);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.data).toMatchObject({ cursor: cursorA, snapshotAt });
  });

  it('continuations at different positions are separate jobs', async () => {
    await enqueueRank({
      userId: USER,
      reason: 'rank-continuation',
      full: true,
      snapshotAt,
      cursor: cursorA,
    });
    await enqueueRank({
      userId: USER,
      reason: 'rank-continuation',
      full: true,
      snapshotAt,
      cursor: cursorB,
    });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 2, delivered: 2, retained: 0 });
    expect(await pendingJobs(`rank-cont:${USER}`)).toHaveLength(2);
  });

  it('a pending continuation does not cover a full-rank intent', async () => {
    await enqueueRank({
      userId: USER,
      reason: 'rank-continuation',
      full: true,
      snapshotAt,
      cursor: cursorA,
    });
    await relayOnce(db, broker, { handlers, logger: silent });
    await enqueueRank({ userId: USER, reason: 'list', full: true });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    expect(await pendingJobs(`rank-full:${USER}`)).toHaveLength(1);
    expect(await pendingJobs(`rank-cont:${USER}`)).toHaveLength(1);
  });

  it('a pending full job does not cover an incremental (debounced) rank intent', async () => {
    expect(await sendFullJob(USER, 'feedback:rating')).not.toBeNull();
    await enqueueRank({ userId: USER, reason: 'match' });
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retained: 0 });
    const incremental = await owner.query(
      `SELECT 1 FROM pgboss.job WHERE name = 'user.rank' AND singleton_key = $1`,
      [`rank:${USER}`],
    );
    expect(incremental.rowCount).toBeGreaterThan(0);
  });
});
