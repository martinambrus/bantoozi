import { buildJobIntent, parseJobPayload, sendSpecFor, type QueueName } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/client.js';
import {
  enqueueDelayedWorkerIntent,
  claimOutboxIntents,
  completeOutboxIntent,
  failOutboxIntent,
  hasPendingEquivalentJob,
  oldestPendingOutboxAgeSeconds,
  outboxRetryDelaySeconds,
  purgeDeliveredOutbox,
  tenantOutbox,
  workerOutbox,
} from '../src/outbox.js';
import { withTenant } from '../src/tenant.js';
import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from './support/test-db.js';

/**
 * Durable intents (spec 02 §3.2; PLAN M0-T5): the API role persists only authorized intents; the
 * relay primitives claim under a lease, deliver to pg-boss and complete only with their own token;
 * a committed intent survives a process restart and a rolled-back one never exists.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

interface OutboxRow {
  id: string;
  queue: string;
  payload: unknown;
  dedupe_key: string | null;
  user_id: string | null;
  delivered_at: Date | null;
  attempts: number;
  lease_token: string | null;
  last_error: string | null;
  available_at: Date;
}

async function outboxRows(queue?: string): Promise<OutboxRow[]> {
  const result = await ctx.owner.query<OutboxRow>(
    `SELECT id::text AS id, queue, payload, dedupe_key, user_id, delivered_at, attempts, lease_token,
            last_error, available_at
       FROM job_outbox WHERE $1::text IS NULL OR queue = $1 ORDER BY id`,
    [queue ?? null],
  );
  return result.rows;
}

/** Deliver everything the owner pool can see as pending by claiming it away (test isolation). */
async function drain(): Promise<void> {
  await ctx.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
}

describe('API role writes only authorized intents', () => {
  it('persists the tenant’s own intent through tenantOutbox, with the canonical dedupe key', async () => {
    await drain();
    const user = await createUser(ctx.owner);
    await withTenant(ctx.app, user.id, async (tx) => {
      await tenantOutbox(tx).enqueue(
        buildJobIntent('user.rank', { userId: user.id, reason: 'cards' }, { revision: '7' }),
      );
    });
    const rows = (await outboxRows('user.rank')).filter((r) => r.delivered_at === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payload: { userId: user.id, reason: 'cards' },
      dedupe_key: `{"payload":{"reason":"cards","userId":"${user.id}"},"revision":"7"}`,
      user_id: user.id,
    });
  });

  it('coalesces identical pending work only; another revision is new work', async () => {
    await drain();
    const user = await createUser(ctx.owner);
    const intent = (revision: string) =>
      buildJobIntent('user.learn', { userId: user.id }, { revision });
    await withTenant(ctx.app, user.id, async (tx) => {
      const outbox = tenantOutbox(tx);
      await outbox.enqueue(intent('1'));
      await outbox.enqueue(intent('1'));
      await outbox.enqueue(intent('2'));
    });
    const pending = (await outboxRows('user.learn')).filter((r) => r.delivered_at === null);
    expect(pending.map((r) => r.dedupe_key)).toEqual([
      `{"payload":{"userId":"${user.id}"},"revision":"1"}`,
      `{"payload":{"userId":"${user.id}"},"revision":"2"}`,
    ]);
  });

  it('rejects intents for another requester or without a tenant, and hides the outbox', async () => {
    const a = await createUser(ctx.owner);
    const b = await createUser(ctx.owner);
    const insert = (userId: string | null) => (client: pg.PoolClient) =>
      client.query(
        `INSERT INTO job_outbox (queue, payload, user_id) VALUES ('user.rank', '{}'::jsonb, $1)`,
        [userId],
      );
    expect(await sqlStateOf(asTenant(ctx.appPool, a.id, insert(b.id)))).toBe('42501');
    expect(await sqlStateOf(asTenant(ctx.appPool, a.id, insert(null)))).toBe('42501');
    expect(await sqlStateOf(asTenant(ctx.appPool, null, insert(a.id)))).toBe('42501');
    for (const statement of [
      'SELECT count(*) FROM job_outbox',
      'UPDATE job_outbox SET attempts = attempts',
      'DELETE FROM job_outbox',
    ]) {
      expect(await sqlStateOf(asTenant(ctx.appPool, a.id, (c) => c.query(statement)))).toBe(
        '42501',
      );
    }
  });

  it('removes the intent when the state transaction rolls back', async () => {
    await drain();
    const user = await createUser(ctx.owner);
    await expect(
      withTenant(ctx.app, user.id, async (tx) => {
        await tenantOutbox(tx).enqueue(buildJobIntent('user.suggest', { userId: user.id }));
        throw new Error('the state change failed');
      }),
    ).rejects.toThrow('the state change failed');
    expect(await outboxRows('user.suggest')).toEqual([]);
  });

  it('keeps a committed intent across a process restart (a new pool finds it)', async () => {
    await drain();
    const user = await createUser(ctx.owner);
    const firstProcess = new pg.Pool({ connectionString: ctx.testDb.urls.app, max: 1 });
    await withTenant(createDatabase(firstProcess), user.id, async (tx) => {
      await tenantOutbox(tx).enqueue(
        buildJobIntent('user.rank', { userId: user.id, reason: 'ingest', full: true }),
      );
    });
    await firstProcess.end();

    const nextProcess = new pg.Pool({ connectionString: ctx.testDb.urls.worker, max: 1 });
    try {
      const claimed = await claimOutboxIntents(createDatabase(nextProcess), {
        limit: 10,
        leaseSeconds: 30,
      });
      expect(claimed.map((c) => c.payload)).toEqual([
        { userId: user.id, reason: 'ingest', full: true },
      ]);
    } finally {
      await nextProcess.end();
    }
  });
});

describe('relay primitives (worker role)', () => {
  it('claims under a lease, delivers to pg-boss and completes only with its own token', async () => {
    await drain();
    const user = await createUser(ctx.owner);
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.extract', { articleId: '42' }, { revision: '3' }),
      );
      await workerOutbox(tx).enqueue(
        buildJobIntent('user.rank', { userId: user.id, reason: 'cards' }),
      );
    });

    const claimed = await claimOutboxIntents(ctx.worker, { limit: 10, leaseSeconds: 30 });
    expect(claimed.map((c) => c.queue)).toEqual(['article.extract', 'user.rank']);
    expect(claimed.every((c) => c.attempts === 1)).toBe(true);
    // Leased rows are not claimable again while the lease is live.
    expect(await claimOutboxIntents(ctx.worker, { limit: 10, leaseSeconds: 30 })).toEqual([]);

    const boss = new PgBoss({
      connectionString: ctx.testDb.urls.worker,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      for (const intent of claimed) {
        const queue = intent.queue as QueueName;
        const payload = parseJobPayload(queue, intent.payload);
        const spec = sendSpecFor(queue, payload);
        const jobId =
          spec.kind === 'debounced'
            ? await boss.sendDebounced(
                queue,
                payload,
                { singletonKey: spec.key },
                spec.seconds,
                spec.key,
              )
            : await boss.send(
                queue,
                payload,
                spec.singletonKey === undefined ? {} : { singletonKey: spec.singletonKey },
              );
        expect(jobId).toEqual(expect.any(String));
        // A stale token (another claimant) cannot complete it; the owner of the lease can.
        expect(
          await completeOutboxIntent(ctx.worker, {
            id: intent.id,
            leaseToken: crypto.randomUUID(),
          }),
        ).toBe(false);
        expect(await completeOutboxIntent(ctx.worker, intent)).toBe(true);
        expect(await completeOutboxIntent(ctx.worker, intent)).toBe(false);
      }
    } finally {
      await boss.stop({ graceful: false, wait: true });
    }
    const jobs = await ctx.owner.query<{
      name: string;
      data: unknown;
      singleton_key: string | null;
    }>(
      "SELECT name, data, singleton_key FROM pgboss.job WHERE name IN ('article.extract','user.rank') ORDER BY name",
    );
    expect(jobs.rows).toEqual([
      { name: 'article.extract', data: { articleId: '42' }, singleton_key: 'extract:42' },
      {
        name: 'user.rank',
        data: { userId: user.id, reason: 'cards' },
        singleton_key: `rank:${user.id}`,
      },
    ]);
    expect((await outboxRows()).filter((r) => r.delivered_at === null)).toEqual([]);
  });

  it('retains a failed send with backoff and lets an expired lease be reclaimed', async () => {
    await drain();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.cluster', { articleId: '7' }, { revision: '1' }),
      );
    });
    const [first] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    if (first === undefined) throw new Error('expected a claim');
    expect(
      await failOutboxIntent(ctx.worker, first, {
        error: 'broker unavailable',
        retryInSeconds: 60,
      }),
    ).toBe(true);
    const [failed] = await outboxRows('article.cluster');
    expect(failed).toMatchObject({
      delivered_at: null,
      lease_token: null,
      last_error: 'broker unavailable',
      attempts: 1,
    });
    expect(failed?.available_at.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not due yet; once due, a crashed claimant's expired lease is reclaimable by another relay.
    expect(await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 })).toEqual([]);
    await ctx.owner.query(
      "UPDATE job_outbox SET available_at = now() WHERE queue = 'article.cluster'",
    );
    const [second] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    if (second === undefined) throw new Error('expected a claim');
    await ctx.owner.query(
      "UPDATE job_outbox SET lease_until = now() - interval '1 second' WHERE queue = 'article.cluster'",
    );
    const [third] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    expect(third?.id).toBe(second.id);
    expect(third?.attempts).toBe(3);
    // The late holder of the expired lease can no longer complete or fail it.
    expect(await completeOutboxIntent(ctx.worker, second)).toBe(false);
    expect(await failOutboxIntent(ctx.worker, second, { error: 'late', retryInSeconds: 1 })).toBe(
      false,
    );
    expect(await completeOutboxIntent(ctx.worker, third!)).toBe(true);
  });

  it('treats a null send as delivered only when equivalent work is pending in pg-boss', async () => {
    const boss = new PgBoss({
      connectionString: ctx.testDb.urls.worker,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      const first = await boss.send(
        'article.enrich',
        { articleId: '5' },
        { singletonKey: 'enrich:5' },
      );
      expect(first).toEqual(expect.any(String));
      // The stately queue refuses a second queued job with the same key: send returns null.
      expect(
        await boss.send('article.enrich', { articleId: '5' }, { singletonKey: 'enrich:5' }),
      ).toBeNull();
      const pending = { queue: 'article.enrich', singletonKey: 'enrich:5', anyPayload: false };
      expect(
        await hasPendingEquivalentJob(ctx.worker, { ...pending, payload: { articleId: '5' } }),
      ).toBe(true);
      // A stronger payload under the same key is not proven pending: the intent must be retained.
      expect(
        await hasPendingEquivalentJob(ctx.worker, {
          ...pending,
          payload: { articleId: '5', priority: 'interactive' },
        }),
      ).toBe(false);
      expect(
        await hasPendingEquivalentJob(ctx.worker, {
          ...pending,
          singletonKey: 'enrich:6',
          payload: { articleId: '6' },
        }),
      ).toBe(false);
      // Debounced jobs re-read durable state, so any pending job under the key is equivalent.
      expect(
        await hasPendingEquivalentJob(ctx.worker, {
          ...pending,
          anyPayload: true,
          payload: { other: true },
        }),
      ).toBe(true);
    } finally {
      await boss.stop({ graceful: false, wait: true });
    }
  });

  it('reports the age of the oldest due undelivered intent', async () => {
    await drain();
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeNull();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.cluster', { articleId: '11' }, { revision: '2' }),
      );
    });
    await ctx.owner.query(
      `UPDATE job_outbox SET created_at = now() - interval '6 minutes',
                             available_at = now() - interval '6 minutes'
        WHERE delivered_at IS NULL`,
    );
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeGreaterThan(300);
  });

  it('leaves an intentional delay out of the backlog age until the intent is due', async () => {
    await drain();
    // Created an hour ago and deferred for two more hours (an origin cooldown): not backlog.
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx, { availableAt: new Date(Date.now() + 2 * 3_600_000) }).enqueue(
        buildJobIntent('article.extract', { articleId: '12' }, { revision: '1' }),
      );
    });
    await ctx.owner.query(
      "UPDATE job_outbox SET created_at = now() - interval '1 hour' WHERE delivered_at IS NULL",
    );
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeNull();
    // Once due, it counts from its `available_at`, not from its creation.
    await ctx.owner.query(
      "UPDATE job_outbox SET available_at = now() - interval '1 minute' WHERE delivered_at IS NULL",
    );
    const due = await oldestPendingOutboxAgeSeconds(ctx.worker);
    expect(due).toBeGreaterThanOrEqual(60);
    expect(due).toBeLessThan(300);
    // A failed send counts from creation once due; future backoff is not current backlog.
    await ctx.owner.query(
      `UPDATE job_outbox SET last_error = 'Error', available_at = now() + interval '15 minutes'
        WHERE delivered_at IS NULL`,
    );
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeNull();
    await ctx.owner.query('UPDATE job_outbox SET available_at = now() WHERE delivered_at IS NULL');
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeGreaterThan(3_000);
    await drain();
  });

  it('bounds the retry backoff', () => {
    expect([0, 1, 2, 5, 10, 30].map(outboxRetryDelaySeconds)).toEqual([1, 2, 4, 32, 900, 900]);
  });

  it('purges only delivered intents past the retention window', async () => {
    await drain();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.match', { articleId: '9' }, { revision: '1' }),
      );
    });
    await ctx.owner.query(
      "UPDATE job_outbox SET created_at = now() - interval '30 days', available_at = now() - interval '30 days' WHERE queue = 'article.match'",
    );
    await ctx.owner.query(
      "UPDATE job_outbox SET delivered_at = now() - interval '8 days' WHERE delivered_at IS NOT NULL",
    );
    const purged = await purgeDeliveredOutbox(ctx.worker, 7);
    expect(purged).toBeGreaterThan(0);
    const left = await outboxRows();
    expect(left.map((r) => r.queue)).toEqual(['article.match']);
    expect(left[0]?.delivered_at).toBeNull();
  });

  it('delays an intent until availableAt, and an identical pending intent coalesces it', async () => {
    await drain();
    const later = new Date(Date.now() + 60 * 60_000);
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx, { availableAt: later }).enqueue(
        buildJobIntent('article.extract', { articleId: '77' }, { revision: '2' }),
      );
    });
    // Not due yet: the relay skips it (spec 03 §8.2, a cooldown defers instead of sleeping).
    expect(await claimOutboxIntents(ctx.worker, { limit: 10, leaseSeconds: 30 })).toEqual([]);
    const row = await ctx.owner.query<{ due_in_minutes: number }>(
      `SELECT round(extract(epoch FROM available_at - now()) / 60)::int AS due_in_minutes
         FROM job_outbox WHERE queue = 'article.extract' AND delivered_at IS NULL`,
    );
    expect(row.rows).toEqual([{ due_in_minutes: 60 }]);
    // An immediate request for the same work coalesces with the pending delayed intent.
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.extract', { articleId: '77' }, { revision: '2' }),
      );
    });
    const pending = (await outboxRows('article.extract')).filter((r) => r.delivered_at === null);
    expect(pending).toHaveLength(1);
    // A past availableAt is due at once.
    await drain();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx, { availableAt: new Date(Date.now() - 60_000) }).enqueue(
        buildJobIntent('article.extract', { articleId: '78' }, { revision: '1' }),
      );
    });
    const due = await claimOutboxIntents(ctx.worker, { limit: 10, leaseSeconds: 30 });
    expect(due.map((c) => c.payload)).toEqual([{ articleId: '78' }]);
  });

  it('writes follow-on intents without a requester in worker transactions', async () => {
    await drain();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(buildJobIntent('house.reconcile', {}));
    });
    const rows = await ctx.worker.execute<{ user_id: string | null }>(
      sql`SELECT user_id FROM job_outbox WHERE queue = 'house.reconcile' AND delivered_at IS NULL`,
    );
    expect(rows.rows).toEqual([{ user_id: null }]);
  });
});

it('the earliest delayed intent wins without changing leases, payloads or delivered history', async () => {
  await drain();
  const intent = buildJobIntent('article.enrich', { articleId: '987' }, { revision: 'earliest' });
  const early = new Date(Date.now() + 60_000);
  const late = new Date(Date.now() + 600_000);
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, late)).toBe(true);
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, early)).toBe(true);
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, late)).toBe(false);
  let pending = (await outboxRows('article.enrich')).filter((r) => r.delivered_at === null);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.available_at).toEqual(early);
  await ctx.owner.query(
    "UPDATE job_outbox SET available_at = now() - interval '1 second' WHERE id = $1",
    [pending[0]?.id],
  );
  const [claimed] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
  expect(claimed).toBeDefined();
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, late)).toBe(true);
  pending = (await outboxRows('article.enrich')).filter((r) => r.delivered_at === null);
  expect(pending[0]).toMatchObject({
    lease_token: null,
    available_at: late,
    attempts: 1,
    payload: intent.payload,
  });
  expect(await completeOutboxIntent(ctx.worker, claimed!)).toBe(false);
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, early)).toBe(true);
  await ctx.owner.query('UPDATE job_outbox SET available_at = now() WHERE id = $1', [claimed!.id]);
  const [replacement] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
  expect(await completeOutboxIntent(ctx.worker, replacement!)).toBe(true);
  expect(await enqueueDelayedWorkerIntent(ctx.worker, intent, early)).toBe(true);
  const rows = (await outboxRows('article.enrich')).filter(
    (r) => r.dedupe_key === intent.dedupeKey,
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.delivered_at).not.toBeNull();
});

it('inserts a new delayed intent when delivery commits while deduplication waits', async () => {
  await drain();
  const intent = buildJobIntent(
    'article.enrich',
    { articleId: '988' },
    { revision: 'delivery-race' },
  );
  const late = new Date(Date.now() + 600_000);
  const early = new Date(Date.now() + 60_000);
  await enqueueDelayedWorkerIntent(ctx.worker, intent, late);
  const row = (await outboxRows('article.enrich')).find((r) => r.dedupe_key === intent.dedupeKey)!;
  const delivery = await ctx.owner.connect();
  let enqueue: Promise<boolean> | undefined;
  try {
    await delivery.query('BEGIN');
    await delivery.query('UPDATE job_outbox SET delivered_at = now() WHERE id = $1', [row.id]);
    enqueue = enqueueDelayedWorkerIntent(ctx.worker, intent, early);
    await expect
      .poll(
        async () => {
          const waiting = await ctx.worker.execute(sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO job_outbox%'`);
          return waiting.rows.length;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    await delivery.query('COMMIT');
    expect(await enqueue).toBe(true);
    const rows = (await outboxRows('article.enrich')).filter(
      (r) => r.dedupe_key === intent.dedupeKey,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: row.id,
      available_at: late,
      delivered_at: expect.any(Date),
    });
    expect(rows[1]).toMatchObject({ available_at: early, delivered_at: null });
  } finally {
    await delivery.query('ROLLBACK');
    await enqueue;
    delivery.release();
  }
});

it.each([false, true])(
  'coalesces two new identical intents in a batch (delayed: %s)',
  async (delayed) => {
    await drain();
    const user = await createUser(ctx.owner);
    const intent = buildJobIntent('user.learn', { userId: user.id });
    expect((await outboxRows()).filter((row) => row.dedupe_key === intent.dedupeKey)).toEqual([]);
    const availableAt = new Date(Date.now() + 60_000);
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx, delayed ? { availableAt } : {}).enqueueMany!([intent, intent]);
    });
    const rows = (await outboxRows()).filter((row) => row.dedupe_key === intent.dedupeKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue: intent.queue,
      payload: intent.payload,
      user_id: null,
      delivered_at: null,
      attempts: 0,
      lease_token: null,
      last_error: null,
    });
    if (delayed) expect(rows[0]!.available_at).toEqual(availableAt);
    else expect(rows[0]!.available_at.getTime()).toBeLessThanOrEqual(Date.now());
  },
);

it('batch inserts preserve pending duplicates, null keys and delivered history', async () => {
  await drain();
  const user = await createUser(ctx.owner);
  const pending = buildJobIntent('user.learn', { userId: user.id });
  const history = buildJobIntent('user.estimate', { userId: user.id });
  const unkeyed = { ...buildJobIntent('house.reconcile', {}), dedupeKey: null };
  await ctx.worker.transaction(async (tx) => {
    await workerOutbox(tx).enqueue(pending);
    await workerOutbox(tx).enqueue(history);
  });
  await ctx.owner.query(`UPDATE job_outbox SET delivered_at = now()
    WHERE queue = 'user.estimate' AND delivered_at IS NULL`);
  const before = await outboxRows('user.learn');
  await ctx.worker.transaction(async (tx) => {
    await workerOutbox(tx).enqueueMany!([pending, pending, history, unkeyed, unkeyed]);
  });
  expect(await outboxRows('user.learn')).toEqual(before);
  expect(
    (await outboxRows('user.estimate')).filter((r) => r.dedupe_key === history.dedupeKey),
  ).toHaveLength(2);
  const pendingRows = (await outboxRows()).filter((r) => r.delivered_at === null);
  expect(pendingRows.map((r) => r.queue)).toEqual([
    'user.learn',
    'user.estimate',
    'house.reconcile',
    'house.reconcile',
  ]);
  expect(pendingRows.every((r) => r.user_id === null)).toBe(true);
});

it('delayed batches retain the earliest time and re-arm leases, including duplicate and null keys', async () => {
  await drain();
  const pending = buildJobIntent('article.extract', { articleId: '990' });
  const fresh = buildJobIntent('article.extract', { articleId: '991' });
  const unkeyed = { ...buildJobIntent('house.reconcile', {}), dedupeKey: null };
  const late = new Date(Date.now() + 600_000);
  const early = new Date(Date.now() + 60_000);
  await enqueueDelayedWorkerIntent(ctx.worker, pending, late);
  await ctx.owner.query(`UPDATE job_outbox SET
    lease_token = '00000000-0000-4000-8000-000000000001',
    lease_until = now() + interval '1 hour' WHERE delivered_at IS NULL`);
  await ctx.worker.transaction(async (tx) => {
    await workerOutbox(tx, { availableAt: early }).enqueueMany!([
      pending,
      pending,
      fresh,
      unkeyed,
      unkeyed,
    ]);
  });
  const before = (await outboxRows()).filter((r) => r.delivered_at === null);
  expect(before).toHaveLength(4);
  expect(before.every((r) => r.available_at.getTime() === early.getTime())).toBe(true);
  expect(before[0]).toMatchObject({
    payload: pending.payload,
    lease_token: null,
  });
  await ctx.worker.transaction(async (tx) => {
    await workerOutbox(tx, { availableAt: late }).enqueueMany!([pending, fresh]);
  });
  expect((await outboxRows()).filter((r) => r.delivered_at === null)).toEqual(before);
  await ctx.owner.query(`UPDATE job_outbox SET delivered_at = now()
    WHERE queue = 'article.extract' AND delivered_at IS NULL`);
  await ctx.worker.transaction(async (tx) => {
    await workerOutbox(tx, { availableAt: new Date(Date.now() - 60_000) }).enqueueMany!([fresh]);
  });
  expect(
    (await claimOutboxIntents(ctx.worker, { limit: 10, leaseSeconds: 30 })).map((r) => r.payload),
  ).toEqual([fresh.payload]);
});

it.each([false, true])(
  'preserves a deferral made before relay acknowledgement (batch %s)',
  async (batch) => {
    await drain();
    const intent = buildJobIntent('analysis.process', {
      analysisRequestId: '00000000-0000-4000-8000-000000000043',
    });
    await ctx.worker.transaction((tx) => workerOutbox(tx).enqueue(intent));
    const [claimed] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    expect(claimed).toBeDefined();
    const due = new Date(Date.now() + 600_000);
    // The just-sent handler sees not_due, schedules itself, and finishes before the relay acks.
    await ctx.worker.transaction(async (tx) => {
      const sender = workerOutbox(tx, { availableAt: due });
      if (batch) await sender.enqueueMany!([intent]);
      else await sender.enqueue(intent);
    });
    expect(await completeOutboxIntent(ctx.worker, claimed!)).toBe(false);
    expect(
      await failOutboxIntent(ctx.worker, claimed!, {
        error: 'late send failure',
        retryInSeconds: 1,
      }),
    ).toBe(false);
    const pending = (await outboxRows('analysis.process')).filter(
      (row) => row.delivered_at === null,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.available_at).toEqual(due);
    expect(pending[0]!.lease_token).toBeNull();
  },
);

it.each([false, true])(
  'keeps crashed-relay work due after a delayed insert (batch %s)',
  async (batch) => {
    await drain();
    const intent = buildJobIntent('house.reconcile', {}, { revision: 'expired-lease' });
    await ctx.worker.transaction((tx) => workerOutbox(tx).enqueue(intent));
    const [claimed] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    await ctx.owner.query(
      "UPDATE job_outbox SET lease_until = now() - interval '1 second' WHERE id = $1",
      [claimed!.id],
    );
    const before = (await outboxRows()).find((row) => row.id === claimed!.id)!;
    await ctx.worker.transaction(async (tx) => {
      const sender = workerOutbox(tx, { availableAt: new Date(Date.now() + 600_000) });
      if (batch) await sender.enqueueMany!([intent]);
      else await sender.enqueue(intent);
    });
    expect((await outboxRows()).find((row) => row.id === claimed!.id)!.available_at).toEqual(
      before.available_at,
    );
    const due = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
    expect(due.map((row) => row.id)).toEqual([claimed!.id]);
  },
);

it('retains failure details without counting a future re-arm as backlog', async () => {
  await drain();
  const intent = buildJobIntent('house.reconcile', {}, { revision: 'failed-rearm' });
  await ctx.worker.transaction((tx) => workerOutbox(tx).enqueue(intent));
  const [failed] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
  await failOutboxIntent(ctx.worker, failed!, { error: 'broker unavailable', retryInSeconds: 0 });
  await ctx.owner.query(
    "UPDATE job_outbox SET created_at = now() - interval '1 hour' WHERE id = $1",
    [failed!.id],
  );
  const [retry] = await claimOutboxIntents(ctx.worker, { limit: 1, leaseSeconds: 30 });
  const due = new Date(Date.now() + 600_000);
  await enqueueDelayedWorkerIntent(ctx.worker, intent, due);
  expect(await completeOutboxIntent(ctx.worker, retry!)).toBe(false);
  expect((await outboxRows()).find((row) => row.id === failed!.id)).toMatchObject({
    last_error: 'broker unavailable',
    attempts: 2,
  });
  expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeNull();
  expect(await oldestPendingOutboxAgeSeconds(ctx.worker, due)).toBeGreaterThan(3_000);
});
