import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  claimOutboxIntents,
  completeOutboxIntent,
  createDatabase,
  runMigrations,
  workerOutbox,
  type Database,
} from '@bantoozi/db';
import { buildJobIntent, type JobPayloadInput, type QueueName } from '@bantoozi/shared';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgBossBroker, registerHandlers } from '../src/boss.js';
import { HANDLERS, type HandlerMap } from '../src/handlers/index.js';
import { relayOnce, startOutboxRelay, type JobBroker } from '../src/outbox-relay.js';

/**
 * The worker's durable relay against real pg-boss (PLAN M0-T7): crash-after-send replay, guarded
 * lease completion and unavailable-stage retention.
 */

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
let boss: PgBoss;
let broker: JobBroker;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A map where the given stages are implemented (no-op handlers). */
function implementing(...queues: QueueName[]): HandlerMap {
  const map: Record<string, unknown> = { ...HANDLERS };
  for (const queue of queues) map[queue] = { status: 'implemented', handle: async () => {} };
  return map as unknown as HandlerMap;
}

async function enqueue<Q extends QueueName>(
  queue: Q,
  payload: JobPayloadInput<Q>,
  revision?: string,
) {
  await db.transaction(async (tx) => {
    await workerOutbox(tx).enqueue(
      buildJobIntent(queue, payload, revision === undefined ? {} : { revision }),
    );
  });
}

async function outbox() {
  const result = await owner.query<{
    queue: string;
    delivered: boolean;
    attempts: number;
    last_error: string | null;
    leased: boolean;
  }>(
    `SELECT queue, delivered_at IS NOT NULL AS delivered, attempts, last_error, lease_token IS NOT NULL AS leased
       FROM job_outbox ORDER BY id`,
  );
  return result.rows;
}

async function jobs(queue: string) {
  const result = await owner.query<{ data: unknown; state: string }>(
    'SELECT data, state::text AS state FROM pgboss.job WHERE name = $1 ORDER BY created_on',
    [queue],
  );
  return result.rows;
}

/** Make every pending intent due and release expired-looking leases (a crashed relay's). */
async function expireLeasesAndMakeDue(): Promise<void> {
  await owner.query(
    `UPDATE job_outbox SET available_at = now(),
            lease_until = CASE WHEN lease_token IS NULL THEN NULL ELSE now() - interval '1 second' END
      WHERE delivered_at IS NULL`,
  );
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

describe('outbox relay', () => {
  it('keeps intents of unavailable stages (stage_unavailable) and delivers them once implemented', async () => {
    await enqueue('article.extract', { articleId: '1' }, '1');
    const report = await relayOnce(db, broker, { handlers: HANDLERS, logger: silent });
    expect(report).toMatchObject({ claimed: 1, delivered: 0, retained: 1 });
    expect(await outbox()).toEqual([
      {
        queue: 'article.extract',
        delivered: false,
        attempts: 1,
        last_error: 'stage_unavailable',
        leased: false,
      },
    ]);
    expect(await jobs('article.extract')).toEqual([]);
    // Not due again until the retry time; then an implemented stage receives it.
    expect((await relayOnce(db, broker, { handlers: HANDLERS })).claimed).toBe(0);
    await expireLeasesAndMakeDue();
    const delivered = await relayOnce(db, broker, { handlers: implementing('article.extract') });
    expect(delivered).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await jobs('article.extract')).toEqual([{ data: { articleId: '1' }, state: 'created' }]);
  });

  it('replays an intent after a crash between send and completion, without losing or duplicating singleton work', async () => {
    const handlers = implementing('article.enrich', 'house.reconcile');
    await enqueue('article.enrich', { articleId: '7' }, '2');
    await enqueue('house.reconcile', {});
    // A relay claims and sends, then dies before marking anything delivered.
    const crashed = await claimOutboxIntents(db, { limit: 10, leaseSeconds: 60 });
    await boss.send('article.enrich', { articleId: '7' }, { singletonKey: 'enrich:7' });
    await boss.send('house.reconcile', {});
    expect((await outbox()).every((r) => !r.delivered && r.leased)).toBe(true);
    // Live leases block other relays; after expiry the intents are replayed.
    expect((await relayOnce(db, broker, { handlers })).claimed).toBe(0);
    await expireLeasesAndMakeDue();
    const replay = await relayOnce(db, broker, { handlers, logger: silent });
    expect(replay).toMatchObject({ claimed: 2, delivered: 2 });
    // The keyed job was already pending (null send, proven equivalent): still exactly one job.
    expect(await jobs('article.enrich')).toHaveLength(1);
    // An unkeyed job is delivered twice: duplicate delivery, consumers are idempotent.
    expect(await jobs('house.reconcile')).toHaveLength(2);
    // The crashed relay's late completion cannot touch the replayed rows.
    for (const intent of crashed) expect(await completeOutboxIntent(db, intent)).toBe(false);
    expect((await outbox()).map((r) => [r.queue, r.delivered, r.attempts])).toEqual([
      ['article.enrich', true, 2],
      ['house.reconcile', true, 2],
    ]);
  });

  it('retains the intent when a singleton conflict does not prove equivalent work', async () => {
    const handlers = implementing('article.enrich');
    // A pending job under the key carries a different payload (a stronger request is not proven).
    await boss.send('article.enrich', { articleId: '8' }, { singletonKey: 'enrich:8' });
    await enqueue('article.enrich', { articleId: '8', priority: 'interactive' }, '1');
    const report = await relayOnce(db, broker, { handlers, logger: silent });
    expect(report).toMatchObject({ delivered: 0, retained: 1 });
    expect(await outbox()).toEqual([
      {
        queue: 'article.enrich',
        delivered: false,
        attempts: 1,
        last_error: 'singleton_conflict',
        leased: false,
      },
    ]);
  });

  it('guards completion by lease: a relay whose lease expired cannot complete or fail the intent', async () => {
    const handlers = implementing('article.cluster');
    await enqueue('article.cluster', { articleId: '3' }, '1');
    const [slow] = await claimOutboxIntents(db, { limit: 1, leaseSeconds: 60 });
    if (slow === undefined) throw new Error('expected a claim');
    await expireLeasesAndMakeDue();
    expect(await relayOnce(db, broker, { handlers })).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await completeOutboxIntent(db, slow)).toBe(false);
    expect(await jobs('article.cluster')).toHaveLength(1);
  });

  it('keeps an intent after a failed send, with a redacted error and a retry time', async () => {
    const handlers = implementing('article.match');
    await enqueue('article.match', { articleId: '4' }, '1');
    const failing: JobBroker = {
      send: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED postgres://secret@host'), {
          code: 'ECONNREFUSED',
        });
      },
      sendDebounced: async () => null,
    };
    expect(await relayOnce(db, failing, { handlers, logger: silent })).toMatchObject({ failed: 1 });
    const [row] = await outbox();
    expect(row).toMatchObject({
      delivered: false,
      last_error: 'Error:ECONNREFUSED',
      leased: false,
    });
    expect(row?.last_error).not.toContain('secret');
  });

  it('keeps an invalid intent for an operator instead of sending or deleting it', async () => {
    await owner.query(
      `INSERT INTO job_outbox (queue, payload) VALUES ('article.match', '{"articleId": 12}'), ('no.such.queue', '{}')`,
    );
    const report = await relayOnce(db, broker, {
      handlers: implementing('article.match'),
      logger: silent,
    });
    expect(report).toMatchObject({ claimed: 2, failed: 2 });
    expect((await outbox()).map((r) => r.last_error)).toEqual(['invalid_payload', 'unknown_queue']);
    expect(await jobs('article.match')).toEqual([]);
  });

  it('sends debounced intents with the jobs.ts key (user.rank incremental)', async () => {
    const userId = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f60';
    await enqueue('user.rank', { userId, reason: 'match' });
    await relayOnce(db, broker, { handlers: implementing('user.rank') });
    const rows = await owner.query<{ singleton_key: string | null }>(
      "SELECT singleton_key FROM pgboss.job WHERE name = 'user.rank'",
    );
    expect(rows.rows).toEqual([{ singleton_key: `rank:${userId}` }]);
  });

  it('runs as a loop that delivers within a second and stops cleanly', async () => {
    const loop = startOutboxRelay(db, broker, {
      handlers: implementing('article.cluster'),
      intervalMs: 50,
    });
    try {
      await enqueue('article.cluster', { articleId: '99' }, '5');
      await expect
        .poll(async () => (await outbox()).map((r) => r.delivered), {
          timeout: 2_000,
          interval: 50,
        })
        .toEqual([true]);
    } finally {
      await loop.stop();
    }
  });
});

describe('consumer registration', () => {
  it('consumes implemented stages only; stub queues keep their jobs pending', async () => {
    const handled: unknown[] = [];
    const handlers: HandlerMap = {
      ...HANDLERS,
      'user.learn': {
        status: 'implemented',
        handle: async (payload) => {
          handled.push(payload);
        },
      },
    };
    const consumer = new PgBoss({
      connectionString: testDb.urls.worker,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await consumer.start();
    try {
      const registration = await registerHandlers(
        consumer,
        handlers,
        ['user.learn', 'feed.fetch'],
        silent,
      );
      expect(registration).toEqual({ consuming: ['user.learn'], unavailable: ['feed.fetch'] });
      const userId = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f60';
      await consumer.send('user.learn', { userId });
      await consumer.send('user.learn', { userId: 'not-a-uuid' });
      await consumer.send('feed.fetch', { feedId: '1' }, { singletonKey: 'feed:1' });
      await expect.poll(() => handled, { timeout: 10_000, interval: 100 }).toEqual([{ userId }]);
      await expect
        .poll(async () => (await jobs('user.learn')).map((j) => j.state), {
          timeout: 10_000,
          interval: 100,
        })
        .toEqual(['completed', 'completed']);
      // The stub stage was never dispatched: its job is still waiting for a real handler.
      expect(await jobs('feed.fetch')).toEqual([{ data: { feedId: '1' }, state: 'created' }]);
    } finally {
      await consumer.stop({ graceful: false, wait: true });
    }
  });
});
