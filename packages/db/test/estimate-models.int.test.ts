import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSessionDatabase } from '../src/client.js';
import {
  countEstimateRatings,
  deleteEstimateModels,
  insertEstimateModel,
  loadEstimateModel,
  loadEstimateState,
  lockEstimateUser,
  pruneEstimateModels,
  type NewEstimateModel,
} from '../src/index.js';
import { loadEstimateRatings } from '../src/rank/context.js';
import { Scenario } from './learn/fixtures.js';
import { setupDbTest, sqlStateOf, withConnection, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const DAY = 24 * 3600 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function model(userId: string, over: Partial<NewEstimateModel> = {}): NewEstimateModel {
  return {
    userId,
    spec: 'estimate-test-v1',
    n: 12,
    nPos: 7,
    nNeg: 5,
    intercept: -0.1234567890123456,
    weights: { alpha: 0.1 + 0.2, beta: 1 / 3, gamma: -1e-9, delta: 123456.78901234567 },
    platt: { a: 1.0000000000000002, b: -0.30000000000000004 },
    metrics: { auc: 0.8123456789012345, inputSha: 'sha-1', options: { minRatings: 10 } },
    ...over,
  };
}

async function store(userId: string, over: Partial<NewEstimateModel> = {}): Promise<number> {
  return ctx.worker.transaction(async (tx) => {
    expect(await lockEstimateUser(tx, userId)).toBe(true);
    return insertEstimateModel(tx, model(userId, over));
  });
}

async function versions(userId: string): Promise<number[]> {
  const result = await ctx.owner.query<{ version: number }>(
    'SELECT version FROM user_estimate_models WHERE user_id = $1 ORDER BY version',
    [userId],
  );
  return result.rows.map((row) => row.version);
}

async function rate(
  userId: string,
  articleId: string,
  rating: 1 | -1 | null,
  ratedAt: Date | null,
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, article_id) DO UPDATE SET rating = $3, rated_at = $4`,
    [userId, articleId, rating, ratedAt],
  );
}

describe('insertEstimateModel', () => {
  it('returns versions 1, 2, 3 per user, independent between users', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    expect(await store(a.userId)).toBe(1);
    expect(await store(a.userId)).toBe(2);
    expect(await store(b.userId)).toBe(1);
    expect(await store(a.userId)).toBe(3);
    expect(await versions(a.userId)).toEqual([1, 2, 3]);
  });

  it('continues after the highest version when lower ones were pruned', async () => {
    const s = await Scenario.create(ctx);
    await store(s.userId);
    await store(s.userId);
    await ctx.worker.transaction((tx) => pruneEstimateModels(tx, s.userId, 1));
    expect(await store(s.userId)).toBe(3);
  });

  it('reads back intercept, weights, platt and metrics exactly as stored, without rounding', async () => {
    const s = await Scenario.create(ctx);
    const input = model(s.userId);
    await store(s.userId);
    const stored = await loadEstimateModel(ctx.worker, s.userId);
    expect(stored).not.toBeNull();
    expect(stored?.intercept).toBe(input.intercept);
    expect(stored?.weights).toEqual(input.weights);
    expect(stored?.platt).toEqual(input.platt);
    expect(stored?.metrics).toEqual(input.metrics);
    expect(stored).toMatchObject({
      userId: s.userId,
      version: 1,
      spec: input.spec,
      n: 12,
      nPos: 7,
      nNeg: 5,
    });
    expect(stored?.trainedAt).toBeInstanceOf(Date);
  });

  it('stores a large weights object intact', async () => {
    const s = await Scenario.create(ctx);
    const weights: Record<string, number> = {};
    for (let i = 0; i < 5000; i += 1) weights[`w${i}`] = Math.sin(i) / 7;
    await store(s.userId, { weights });
    expect((await loadEstimateModel(ctx.worker, s.userId))?.weights).toEqual(weights);
  });

  it('rejects a version below 1 and a count that is not n_pos + n_neg (23514)', async () => {
    const s = await Scenario.create(ctx);
    const insert = (version: number, n: number, nPos: number, nNeg: number) =>
      ctx.owner.query(
        `INSERT INTO user_estimate_models (user_id, version, spec, n, n_pos, n_neg, intercept, weights, platt, metrics)
         VALUES ($1, $2, 'x', $3, $4, $5, 0, '{}', '{}', '{}')`,
        [s.userId, version, n, nPos, nNeg],
      );
    expect(await sqlStateOf(insert(0, 12, 6, 6))).toBe('23514');
    expect(await sqlStateOf(insert(1, 13, 6, 6))).toBe('23514');
    expect(await sqlStateOf(insert(1, 12, -1, 13))).toBe('23514');
    await insert(1, 12, 6, 6);
    expect(await versions(s.userId)).toEqual([1]);
  });

  it('cascades the models when the user is deleted', async () => {
    const s = await Scenario.create(ctx);
    await store(s.userId);
    await ctx.owner.query('DELETE FROM users WHERE id = $1', [s.userId]);
    expect(await versions(s.userId)).toEqual([]);
  });
});

describe('loadEstimateState and loadEstimateModel', () => {
  it('return null for a user without models', async () => {
    const s = await Scenario.create(ctx);
    expect(await loadEstimateState(ctx.worker, s.userId)).toBeNull();
    expect(await loadEstimateModel(ctx.worker, s.userId)).toBeNull();
  });

  it('return the newest version; the state has no weights, platt or intercept', async () => {
    const s = await Scenario.create(ctx);
    await store(s.userId, { spec: 'old', n: 10, nPos: 5, nNeg: 5, metrics: { inputSha: 'one' } });
    await store(s.userId, { spec: 'new', n: 14, nPos: 8, nNeg: 6, metrics: { inputSha: 'two' } });
    const state = await loadEstimateState(ctx.worker, s.userId);
    expect(state).toMatchObject({
      version: 2,
      spec: 'new',
      n: 14,
      nPos: 8,
      nNeg: 6,
      metrics: { inputSha: 'two' },
    });
    expect(state?.trainedAt).toBeInstanceOf(Date);
    expect(Object.keys(state ?? {}).sort()).toEqual(
      ['metrics', 'n', 'nNeg', 'nPos', 'spec', 'trainedAt', 'version'].sort(),
    );
    const full = await loadEstimateModel(ctx.worker, s.userId);
    expect(full).toMatchObject({ version: 2, spec: 'new', n: 14 });
    expect(full?.weights).toEqual(model(s.userId).weights);
    expect(full?.platt).toEqual(model(s.userId).platt);
    expect(full?.intercept).toBe(model(s.userId).intercept);
  });

  it('never return another user’s rows', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await store(a.userId, { spec: 'of-a' });
    expect(await loadEstimateState(ctx.worker, b.userId)).toBeNull();
    expect(await loadEstimateModel(ctx.worker, b.userId)).toBeNull();
    await store(b.userId, { spec: 'of-b' });
    expect((await loadEstimateState(ctx.worker, a.userId))?.spec).toBe('of-a');
    expect((await loadEstimateModel(ctx.worker, b.userId))?.spec).toBe('of-b');
  });
});

describe('pruneEstimateModels and deleteEstimateModels', () => {
  it('prune keeps the two newest versions only', async () => {
    const s = await Scenario.create(ctx);
    for (let i = 0; i < 4; i += 1) await store(s.userId);
    await ctx.worker.transaction((tx) => pruneEstimateModels(tx, s.userId, 2));
    expect(await versions(s.userId)).toEqual([3, 4]);
  });

  it('prune leaves fewer rows alone and never touches another user', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await store(a.userId);
    for (let i = 0; i < 3; i += 1) await store(b.userId);
    await ctx.worker.transaction((tx) => pruneEstimateModels(tx, a.userId, 2));
    expect(await versions(a.userId)).toEqual([1]);
    expect(await versions(b.userId)).toEqual([1, 2, 3]);
  });

  it('delete returns how many rows went and leaves other users', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await store(a.userId);
    await store(a.userId);
    await store(b.userId);
    expect(await ctx.worker.transaction((tx) => deleteEstimateModels(tx, a.userId))).toBe(2);
    expect(await ctx.worker.transaction((tx) => deleteEstimateModels(tx, a.userId))).toBe(0);
    expect(await versions(a.userId)).toEqual([]);
    expect(await versions(b.userId)).toEqual([1]);
  });
});

describe('lockEstimateUser', () => {
  it('is true for a live user', async () => {
    const s = await Scenario.create(ctx);
    expect(await ctx.worker.transaction((tx) => lockEstimateUser(tx, s.userId))).toBe(true);
  });

  it('is false for a soft-deleted user and for an unknown user', async () => {
    const s = await Scenario.create(ctx);
    await ctx.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [s.userId]);
    expect(await ctx.worker.transaction((tx) => lockEstimateUser(tx, s.userId))).toBe(false);
    expect(
      await ctx.worker.transaction((tx) =>
        lockEstimateUser(tx, '0190d4a7-1234-7abc-8def-000000000000'),
      ),
    ).toBe(false);
  });

  it('makes a second transaction of the same user wait until the first commits', async () => {
    const s = await Scenario.create(ctx);
    await withConnection(ctx.workerPool, async (first) =>
      withConnection(ctx.workerPool, async (second) => {
        const firstDb = createSessionDatabase(first);
        const secondDb = createSessionDatabase(second);
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const firstLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const order: string[] = [];
        const one = firstDb.transaction(async (tx) => {
          await lockEstimateUser(tx, s.userId);
          locked();
          await hold;
          order.push('first-commit');
        });
        await Promise.race([firstLocked, one]);
        const two = secondDb.transaction(async (tx) => {
          await lockEstimateUser(tx, s.userId);
          order.push('second-locked');
        });
        await sleep(400);
        expect(order).toEqual([]);
        release();
        await Promise.all([one, two]);
        expect(order).toEqual(['first-commit', 'second-locked']);
      }),
    );
  });

  it('does not make two different users wait for each other', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await withConnection(ctx.workerPool, async (first) =>
      withConnection(ctx.workerPool, async (second) => {
        const firstDb = createSessionDatabase(first);
        const secondDb = createSessionDatabase(second);
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const firstLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const one = firstDb.transaction(async (tx) => {
          await lockEstimateUser(tx, a.userId);
          locked();
          await hold;
        });
        await Promise.race([firstLocked, one]);
        const other = await Promise.race([
          secondDb.transaction((tx) => lockEstimateUser(tx, b.userId)),
          sleep(3000).then(() => 'blocked' as const),
        ]);
        release();
        await one;
        expect(other).toBe(true);
      }),
    );
  });
});

describe('countEstimateRatings', () => {
  it('equals the counts of loadEstimateRatings, ignoring unrated and bookmarked-only rows', async () => {
    const s = await Scenario.create(ctx);
    const since = ago(5 * DAY);
    const rows: [1 | -1 | null, Date | null][] = [
      [1, ago(DAY)],
      [1, ago(2 * DAY)],
      [-1, ago(3 * DAY)],
      [1, since],
      [-1, new Date(since.getTime() - 1000)],
      [1, ago(30 * DAY)],
      [null, null],
    ];
    for (const [rating, ratedAt] of rows) await rate(s.userId, await s.article(), rating, ratedAt);
    const marked = await s.article();
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status)
       VALUES ($1, $2, now(), 'pending')`,
      [s.userId, marked],
    );
    const loaded = await loadEstimateRatings(ctx.worker, s.userId, since);
    const expected = {
      n: loaded.length,
      nPos: loaded.filter((r) => r.rating === 1).length,
      nNeg: loaded.filter((r) => r.rating === -1).length,
    };
    expect(expected).toEqual({ n: 4, nPos: 3, nNeg: 1 });
    expect(await countEstimateRatings(ctx.worker, s.userId, since)).toEqual(expected);
    const all = await loadEstimateRatings(ctx.worker, s.userId, new Date(0));
    expect(await countEstimateRatings(ctx.worker, s.userId, new Date(0))).toEqual({
      n: all.length,
      nPos: all.filter((r) => r.rating === 1).length,
      nNeg: all.filter((r) => r.rating === -1).length,
    });
    expect(all.length).toBe(6);
  });

  it('counts nothing for a user without ratings and ignores other users', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await rate(b.userId, await b.article(), 1, ago(DAY));
    expect(await countEstimateRatings(ctx.worker, a.userId, new Date(0))).toEqual({
      n: 0,
      nPos: 0,
      nNeg: 0,
    });
  });
});

describe('user_article.score_source', () => {
  it('accepts estimate and rejects an unknown source (23514)', async () => {
    const s = await Scenario.create(ctx);
    const article = await s.article();
    await ctx.owner.query(
      `INSERT INTO user_article (user_id, article_id, score_source) VALUES ($1, $2, 'estimate')`,
      [s.userId, article],
    );
    const stored = await ctx.owner.query<{ score_source: string }>(
      'SELECT score_source FROM user_article WHERE user_id = $1 AND article_id = $2',
      [s.userId, article],
    );
    expect(stored.rows[0]?.score_source).toBe('estimate');
    const other = await s.article();
    expect(
      await sqlStateOf(
        ctx.owner.query(
          `INSERT INTO user_article (user_id, article_id, score_source) VALUES ($1, $2, 'bogus')`,
          [s.userId, other],
        ),
      ),
    ).toBe('23514');
  });
});
