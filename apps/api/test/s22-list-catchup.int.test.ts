import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  carriedArticle,
  clearOutbox,
  clusterOf,
  newReader,
  rank,
  rankRevision,
  restamp,
  subscribedFeed,
  freshFence,
  type Reader,
} from './support/article-fixtures.js';
import { createApiHarness, type ApiHarness } from './support/harness.js';

/**
 * S22 (owner decision 2026-10-11): after a reader action marks rows, the list reports
 * `rankingPending` and its catch-up intent is INCREMENTAL (never `full`); the catch-up is suppressed
 * while a rank is already on its way (`rank_covered()`: an undelivered `user.rank` intent without a
 * cursor, full or not, or a created/retry `rank:<u>` or `rank-full:<u>` job) and an active job does
 * not suppress it. Supersedes the full-rank cases of s19-list-catchup.int.test.ts.
 *
 * Counted from the owner role (the API role cannot read `job_outbox`).
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

/**
 * A reader whose cluster {a, b} is fully ranked, after reading `a`. The sibling `b` is then due
 * (`next_rank_at` in the past): written explicitly here, so each catch-up test depends on the list
 * logic only; `the read itself marks the sibling` pins that the action writes it.
 */
async function markedReader(): Promise<Reader & { a: string; b: string }> {
  const r = await newReader(h);
  const feed = await subscribedFeed(h, r.user.id);
  const a = await carriedArticle(h, [feed]);
  const b = await carriedArticle(h, [feed]);
  await clusterOf(h, [a, b]);
  await rank(h, r.user.id, a, { lane: 'for_you', p: 0.9, tier: 5 });
  await rank(h, r.user.id, b, { lane: 'for_you', p: 0.9, tier: 5 });
  const read = await r.api.post(`/articles/${a}/read`, freshFence);
  expect(read.statusCode, read.body).toBe(200);
  // The action's own intents are not what is under test: start from an empty outbox.
  await clearOutbox(h, r.user.id);
  await restamp(h, r.user.id); // a revision bump (old behaviour) must not be what makes it pending
  await h.owner.query(
    `UPDATE user_article SET next_rank_at = now() - interval '1 second'
      WHERE user_id = $1 AND article_id = $2`,
    [r.user.id, b],
  );
  return { ...r, a, b };
}

interface Page {
  rankingPending: boolean;
}

async function listTwice(r: Reader, path: '/articles' | '/articles/counts' = '/articles') {
  for (let call = 0; call < 2; call += 1) {
    const res = await r.api.get(path, {
      query: path === '/articles' ? { lane: 'all', status: 'all' } : {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Page>().rankingPending, `call ${call}`).toBe(true);
  }
}

interface Intent {
  payload: Record<string, unknown>;
  delivered: boolean;
}

async function rankIntents(userId: string): Promise<Intent[]> {
  const result = await h.owner.query<{ payload: Record<string, unknown>; delivered: boolean }>(
    `SELECT payload, delivered_at IS NOT NULL AS delivered FROM job_outbox
      WHERE user_id = $1 AND queue = 'user.rank' ORDER BY id`,
    [userId],
  );
  return result.rows;
}

async function seedIntent(userId: string, payload: Record<string, unknown>, delivered = false) {
  await h.owner.query(
    `INSERT INTO job_outbox (queue, payload, dedupe_key, user_id, delivered_at)
     VALUES ('user.rank', $2::jsonb, $3, $1, CASE WHEN $4::boolean THEN now() END)`,
    [userId, JSON.stringify(payload), `s22-${JSON.stringify(payload)}`, delivered],
  );
}

async function seedJob(
  singletonKey: string,
  data: Record<string, unknown>,
  state: 'created' | 'retry' | 'active' | 'completed',
) {
  await h.owner.query(
    `INSERT INTO pgboss.job (name, data, state, singleton_key) VALUES ('user.rank', $1::jsonb, $2, $3)`,
    [JSON.stringify(data), state, singletonKey],
  );
}

describe('S22 list catch-up after a reader action', () => {
  it('the read itself marks the sibling (no revision bump, no full intent) and ranking is pending', async () => {
    const r = await newReader(h);
    const feed = await subscribedFeed(h, r.user.id);
    const a = await carriedArticle(h, [feed]);
    const b = await carriedArticle(h, [feed]);
    await clusterOf(h, [a, b]);
    await rank(h, r.user.id, a, { lane: 'for_you', p: 0.9, tier: 5 });
    await rank(h, r.user.id, b, { lane: 'for_you', p: 0.9, tier: 5 });
    await clearOutbox(h, r.user.id);
    const revision = await rankRevision(h, r.user.id);
    expect((await r.api.post(`/articles/${a}/read`, freshFence)).statusCode).toBe(200);
    expect(await rankRevision(h, r.user.id)).toBe(revision);
    const due = await h.owner.query<{ due: boolean | null }>(
      `SELECT next_rank_at <= now() AS due FROM user_article WHERE user_id = $1 AND article_id = $2`,
      [r.user.id, b],
    );
    expect(due.rows[0]?.due).toBe(true);
    const intents = await rankIntents(r.user.id);
    expect(intents.some((i) => i.payload['full'] === true)).toBe(false);
    await listTwice(r);
  });

  it('the marked row makes ranking pending, and the catch-up is one incremental intent', async () => {
    const r = await markedReader();
    await listTwice(r);
    const intents = (await rankIntents(r.user.id)).filter((i) => !i.delivered);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.payload).toMatchObject({ userId: r.user.id, reason: 'list' });
    expect(intents[0]!.payload['full']).toBeUndefined();
  });

  it('the counts call catches up the same way', async () => {
    const r = await markedReader();
    await listTwice(r, '/articles/counts');
    const intents = (await rankIntents(r.user.id)).filter((i) => !i.delivered);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.payload['full']).toBeUndefined();
  });

  describe('suppressed while a rank is on its way', () => {
    it('an undelivered incremental intent', async () => {
      const r = await markedReader();
      await seedIntent(r.user.id, { userId: r.user.id, reason: 'feedback:read' });
      await listTwice(r);
      expect(await rankIntents(r.user.id)).toHaveLength(1);
    });

    it('an undelivered full intent', async () => {
      const r = await markedReader();
      await seedIntent(r.user.id, { userId: r.user.id, reason: 'rule', full: true });
      await listTwice(r);
      expect(await rankIntents(r.user.id)).toHaveLength(1);
    });

    it.each(['created', 'retry'] as const)('a %s rank:<user> job', async (state) => {
      const r = await markedReader();
      await seedJob(`rank:${r.user.id}`, { userId: r.user.id, reason: 'feedback:read' }, state);
      await listTwice(r);
      expect(await rankIntents(r.user.id)).toHaveLength(0);
    });

    it.each(['created', 'retry'] as const)('a %s rank-full:<user> job', async (state) => {
      const r = await markedReader();
      await seedJob(
        `rank-full:${r.user.id}`,
        { userId: r.user.id, reason: 'rule', full: true },
        state,
      );
      await listTwice(r);
      expect(await rankIntents(r.user.id)).toHaveLength(0);
    });
  });

  describe('not suppressed', () => {
    it('an active job (it may already have read the state)', async () => {
      const r = await markedReader();
      await seedJob(`rank:${r.user.id}`, { userId: r.user.id, reason: 'feedback:read' }, 'active');
      await listTwice(r);
      const open = (await rankIntents(r.user.id)).filter((i) => !i.delivered);
      expect(open).toHaveLength(1);
      expect(open[0]!.payload['full']).toBeUndefined();
    });

    it('a delivered intent, a finished job, a continuation with a cursor, another user', async () => {
      const r = await markedReader();
      const other = await markedReader();
      await seedIntent(r.user.id, { userId: r.user.id, reason: 'x' }, true);
      await seedJob(`rank:${r.user.id}`, { userId: r.user.id, reason: 'x' }, 'completed');
      await seedIntent(r.user.id, {
        userId: r.user.id,
        reason: 'continuation',
        cursor: { arrival: '2026-10-01T10:00:00.000Z', articleId: '41' },
      });
      await seedIntent(other.user.id, { userId: other.user.id, reason: 'feedback:read' });
      await seedJob(`rank:${other.user.id}`, { userId: other.user.id, reason: 'x' }, 'created');
      await listTwice(r);
      const open = (await rankIntents(r.user.id)).filter(
        (i) => !i.delivered && i.payload['reason'] === 'list',
      );
      expect(open).toHaveLength(1);
      expect(open[0]!.payload['full']).toBeUndefined();
    });
  });
});
