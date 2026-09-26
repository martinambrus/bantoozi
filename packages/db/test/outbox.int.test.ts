import { buildJobIntent, parseJobPayload, sendSpecFor, type QueueName } from '@bantoozi/shared';
import { createUser } from '@bantoozi/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/client.js';
import {
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

  it('reports the age of the oldest undelivered intent', async () => {
    await drain();
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeNull();
    await ctx.worker.transaction(async (tx) => {
      await workerOutbox(tx).enqueue(
        buildJobIntent('article.cluster', { articleId: '11' }, { revision: '2' }),
      );
    });
    await ctx.owner.query(
      "UPDATE job_outbox SET created_at = now() - interval '6 minutes' WHERE delivered_at IS NULL",
    );
    expect(await oldestPendingOutboxAgeSeconds(ctx.worker)).toBeGreaterThan(300);
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
