import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  carriedArticle,
  newReader,
  subscribedFeed,
  type Reader,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * S19 (S18 findings Q3): every list or counts call that finds ranking pending used to write one
 * `user.rank {full}` catch-up intent, while the relay keeps at most one full-rank job per user. With
 * a full-rank intent or job already pending, another intent is pure outbox churn (7.6k per 20
 * minutes in the load test) and, as it stalls behind the pending job, the oldest-intent age. The
 * catch-up must not be written then, and must still be written when nothing covers it.
 *
 * Counted from the owner role (the API role cannot read `job_outbox`): rows of the user before and
 * after two list calls.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

/** A reader whose only article has no stored rank: ranking is pending for every list call. */
async function pendingReader(): Promise<Reader> {
  const r = await newReader(h);
  const feed = await subscribedFeed(h, r.user.id);
  await carriedArticle(h, [feed]);
  return r;
}

interface Page {
  items: unknown[];
  rankingPending: boolean;
}

async function listTwice(r: Reader, path: '/articles' | '/articles/counts' = '/articles') {
  for (let call = 0; call < 2; call += 1) {
    const res = await r.api.get(path, { query: path === '/articles' ? { lane: 'all' } : {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Page>().rankingPending).toBe(true);
  }
}

async function outboxCount(userId: string): Promise<number> {
  const result = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM job_outbox WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]!.n;
}

/**
 * S22 (owner decision 2026-10-11): the catch-up is an INCREMENTAL `user.rank {reason: 'list'}`
 * intent (no `full`), so the helper selects those.
 */
async function fullRankIntents(userId: string): Promise<{ reason: string; delivered: boolean }[]> {
  const result = await h.owner.query<{ reason: string; delivered: boolean }>(
    `SELECT payload->>'reason' AS reason, delivered_at IS NOT NULL AS delivered
       FROM job_outbox
      WHERE user_id = $1 AND queue = 'user.rank' AND payload->>'reason' = 'list'
        AND payload->'full' IS NULL AND payload->'cursor' IS NULL
      ORDER BY id`,
    [userId],
  );
  return result.rows;
}

/** A user.rank intent in the outbox, as another route would have written it. */
async function seedIntent(
  userId: string,
  payload: Record<string, unknown>,
  options: { delivered?: boolean } = {},
): Promise<void> {
  await h.owner.query(
    `INSERT INTO job_outbox (queue, payload, dedupe_key, user_id, delivered_at)
     VALUES ('user.rank', $2::jsonb, $3, $1, CASE WHEN $4::boolean THEN now() END)`,
    [
      userId,
      JSON.stringify(payload),
      `seed-${JSON.stringify(payload)}`,
      options.delivered ?? false,
    ],
  );
}

/** A user.rank job in pg-boss as the relay would have sent it. */
async function seedJob(
  singletonKey: string,
  data: Record<string, unknown>,
  state: 'created' | 'retry' | 'active' | 'completed',
): Promise<void> {
  await h.owner.query(
    `INSERT INTO pgboss.job (name, data, state, singleton_key) VALUES ('user.rank', $1::jsonb, $2, $3)`,
    [JSON.stringify(data), state, singletonKey],
  );
}

describe('the list catch-up intent', () => {
  it('writes one incremental intent when nothing covers it, not one per call', async () => {
    const r = await pendingReader();
    await listTwice(r);
    expect(await fullRankIntents(r.user.id)).toEqual([{ reason: 'list', delivered: false }]);
  });

  it('writes nothing while a full-rank intent of another reason is pending', async () => {
    const r = await pendingReader();
    await seedIntent(r.user.id, { userId: r.user.id, reason: 'feedback:rating', full: true });
    const before = await outboxCount(r.user.id);
    await listTwice(r);
    expect(await outboxCount(r.user.id)).toBe(before);
  });

  it('writes nothing while a full-rank job is pending in the queue', async () => {
    const r = await pendingReader();
    await seedJob(
      `rank-full:${r.user.id}`,
      { userId: r.user.id, reason: 'feedback:rating', full: true },
      'created',
    );
    const before = await outboxCount(r.user.id);
    await listTwice(r);
    expect(await outboxCount(r.user.id)).toBe(before);
  });

  it('writes nothing while a full-rank job waits for a retry', async () => {
    const r = await pendingReader();
    await seedJob(
      `rank-full:${r.user.id}`,
      { userId: r.user.id, reason: 'rule', full: true },
      'retry',
    );
    const before = await outboxCount(r.user.id);
    await listTwice(r);
    expect(await outboxCount(r.user.id)).toBe(before);
  });

  it('the counts call is covered the same way', async () => {
    const r = await pendingReader();
    await seedIntent(r.user.id, { userId: r.user.id, reason: 'feedback:rating', full: true });
    const before = await outboxCount(r.user.id);
    await listTwice(r, '/articles/counts');
    expect(await outboxCount(r.user.id)).toBe(before);
  });

  describe('is still written when nothing covers it', () => {
    it('a delivered full-rank intent and a finished job do not cover it', async () => {
      const r = await pendingReader();
      await seedIntent(
        r.user.id,
        { userId: r.user.id, reason: 'feedback:rating', full: true },
        { delivered: true },
      );
      await seedJob(
        `rank-full:${r.user.id}`,
        { userId: r.user.id, reason: 'x', full: true },
        'completed',
      );
      await listTwice(r);
      const intents = await fullRankIntents(r.user.id);
      expect(intents.filter((i) => !i.delivered)).toEqual([{ reason: 'list', delivered: false }]);
    });

    it('a running job started before the list read does not cover it', async () => {
      const r = await pendingReader();
      await seedJob(
        `rank-full:${r.user.id}`,
        { userId: r.user.id, reason: 'x', full: true },
        'active',
      );
      await listTwice(r);
      expect((await fullRankIntents(r.user.id)).filter((i) => !i.delivered)).toEqual([
        { reason: 'list', delivered: false },
      ]);
    });

    it('a pending incremental rank intent covers the incremental catch-up (S22)', async () => {
      const r = await pendingReader();
      await seedIntent(r.user.id, { userId: r.user.id, reason: 'match' });
      const before = await outboxCount(r.user.id);
      await listTwice(r);
      expect(await outboxCount(r.user.id)).toBe(before);
    });

    it('a pending continuation does not cover it', async () => {
      const r = await pendingReader();
      await seedIntent(r.user.id, {
        userId: r.user.id,
        reason: 'rank-continuation',
        full: true,
        snapshotAt: '2026-10-01T11:00:00.000Z',
        cursor: { arrival: '2026-10-01T10:00:00.000Z', articleId: '41' },
      });
      await listTwice(r);
      expect((await fullRankIntents(r.user.id)).filter((i) => !i.delivered)).toEqual([
        { reason: 'list', delivered: false },
      ]);
    });

    it("another user's pending full-rank intent or job does not cover it", async () => {
      const r = await pendingReader();
      const other = await pendingReader();
      await seedIntent(other.user.id, {
        userId: other.user.id,
        reason: 'feedback:rating',
        full: true,
      });
      await seedJob(
        `rank-full:${other.user.id}`,
        { userId: other.user.id, reason: 'x', full: true },
        'created',
      );
      await listTwice(r);
      expect(await fullRankIntents(r.user.id)).toEqual([{ reason: 'list', delivered: false }]);
    });
  });
});
