import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  recordRankIntents,
  runMigrations,
  tenantOutbox,
  withTenant,
  type Database,
} from '@bantoozi/db';
import { enqueueAnalysis, type QueueName } from '@bantoozi/shared';
import {
  createUser,
  dropCreatedTestDatabases,
  setupTestDatabase,
  type TestDatabase,
} from '@bantoozi/testing';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgBossBroker } from '../src/boss.js';
import { HANDLERS, type HandlerMap } from '../src/handlers/index.js';
import { relayOnce, type JobBroker } from '../src/outbox-relay.js';

/**
 * M4-T11 enqueue suite, relay half (spec 08 §12 "Enqueue", spec 02 §3.2): intents written exactly
 * as the API writes them — as `bantoozi_app`, in a tenant transaction, through `tenantOutbox` and
 * the jobs.ts helpers — roll back with a failed transaction, persist with a committed one, are
 * delivered to pg-boss by the worker relay, and survive a relay crash between send and completion
 * (duplicate delivery is tolerated: keyed work stays one job, the intent is delivered exactly once).
 * The API half (a real endpoint's intent rolling back/committing across a server restart) is
 * `apps/api/test/api-outbox.int.test.ts`; the admin bootstrap row of the request-code table with an
 * empty `invites` table is `apps/api/test/auth.int.test.ts` ("admin bootstrap: …").
 */

let testDb: TestDatabase;
let owner: pg.Pool;
let appPool: pg.Pool;
let workerPool: pg.Pool;
let appDb: Database;
let workerDb: Database;
let boss: PgBoss;
let broker: JobBroker;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function implementing(...queues: QueueName[]): HandlerMap {
  const map: Record<string, unknown> = { ...HANDLERS };
  for (const queue of queues) map[queue] = { status: 'implemented', handle: async () => {} };
  return map as unknown as HandlerMap;
}

async function outbox(userId: string) {
  const result = await owner.query<{
    queue: string;
    payload: Record<string, unknown>;
    delivered: boolean;
    attempts: number;
  }>(
    `SELECT queue, payload, delivered_at IS NOT NULL AS delivered, attempts
       FROM job_outbox WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return result.rows;
}

async function jobs(queue: string) {
  const result = await owner.query<{ data: Record<string, unknown>; state: string }>(
    'SELECT data, state::text AS state FROM pgboss.job WHERE name = $1 ORDER BY created_on',
    [queue],
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
  appPool = new pg.Pool({ connectionString: testDb.urls.app, max: 2 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  appDb = createDatabase(appPool);
  workerDb = createDatabase(workerPool);
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
  await appPool.end();
  await workerPool.end();
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await owner.query('TRUNCATE job_outbox');
  await owner.query('DELETE FROM pgboss.job');
});

describe('API-role intents through the outbox relay (spec 08 §12 "Enqueue")', () => {
  it('writes as bantoozi_app, which cannot read the outbox back', async () => {
    const role = await appPool.query<{ user: string }>('SELECT current_user AS user');
    expect(role.rows[0]!.user).toBe('bantoozi_app');
    await expect(appPool.query('SELECT 1 FROM job_outbox LIMIT 1')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('rolls an intent back with its failed transaction and keeps it with a committed one', async () => {
    const user = await createUser(owner);
    await expect(
      withTenant(appDb, user.id, async (tx) => {
        await recordRankIntents(tx, tenantOutbox(tx), [user.id], { reason: 'rules', full: true });
        throw new Error('the state change failed after the intent was written');
      }),
    ).rejects.toThrow('the state change failed');
    expect(await outbox(user.id)).toEqual([]);
    const revision = await owner.query<{ r: string }>(
      'SELECT rank_revision::text AS r FROM users WHERE id = $1',
      [user.id],
    );
    expect(revision.rows[0]!.r).toBe('0');

    await withTenant(appDb, user.id, async (tx) => {
      await recordRankIntents(tx, tenantOutbox(tx), [user.id], { reason: 'rules', full: true });
    });
    expect(await outbox(user.id)).toEqual([
      {
        queue: 'user.rank',
        payload: expect.objectContaining({ userId: user.id, full: true }),
        delivered: false,
        attempts: 0,
      },
    ]);
  });

  it('delivers committed API intents to pg-boss', async () => {
    const user = await createUser(owner);
    await withTenant(appDb, user.id, async (tx) => {
      await recordRankIntents(tx, tenantOutbox(tx), [user.id], { reason: 'rules', full: true });
    });
    const report = await relayOnce(workerDb, broker, {
      handlers: implementing('user.rank'),
      logger: silent,
    });
    expect(report).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(await jobs('user.rank')).toEqual([
      { data: expect.objectContaining({ userId: user.id, full: true }), state: 'created' },
    ]);
    expect((await outbox(user.id)).map((row) => row.delivered)).toEqual([true]);
  });

  it('tolerates duplicate delivery after a relay crash between send and completion', async () => {
    const user = await createUser(owner);
    const requestId = '0190f000-0000-7000-8000-000000000001';
    await withTenant(appDb, user.id, async (tx) => {
      await recordRankIntents(tx, tenantOutbox(tx), [user.id], { reason: 'rules', full: true });
      await enqueueAnalysis(tenantOutbox(tx), { analysisRequestId: requestId });
    });
    const handlers = implementing('user.rank', 'analysis.process');
    // A relay claims and sends both intents, then dies before marking them delivered.
    const crashed = await claimOutboxIntents(workerDb, { limit: 10, leaseSeconds: 60 });
    expect(crashed).toHaveLength(2);
    for (const intent of crashed) {
      const sent = await relayOnce(workerDb, broker, { handlers, logger: silent });
      expect(sent.claimed).toBe(0); // live leases block other relays
      await boss.send(intent.queue, intent.payload as object, {
        singletonKey:
          intent.queue === 'user.rank' ? `rank-full:${user.id}` : `analysis:${requestId}`,
      });
    }
    // The lease expires; another relay replays both intents.
    await owner.query(
      `UPDATE job_outbox SET lease_until = now() - interval '1 second' WHERE user_id = $1`,
      [user.id],
    );
    const replay = await relayOnce(workerDb, broker, { handlers, logger: silent });
    expect(replay).toMatchObject({ claimed: 2, delivered: 2, failed: 0, lost: 0 });
    // The duplicate send is proven equivalent to the pending keyed job: still one job each.
    expect(await jobs('user.rank')).toHaveLength(1);
    expect(await jobs('analysis.process')).toEqual([
      { data: { analysisRequestId: requestId }, state: 'created' },
    ]);
    // The crashed relay's late completion cannot touch the replayed rows.
    for (const intent of crashed) expect(await completeOutboxIntent(workerDb, intent)).toBe(false);
    expect((await outbox(user.id)).map((row) => [row.queue, row.delivered, row.attempts])).toEqual([
      ['user.rank', true, 2],
      ['analysis.process', true, 2],
    ]);
    // A further pass has nothing left to deliver.
    expect((await relayOnce(workerDb, broker, { handlers, logger: silent })).claimed).toBe(0);
  });
});
