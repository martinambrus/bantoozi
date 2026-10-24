import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSessionDatabase } from '../src/client.js';
import {
  LEARNING_HISTORY_KEEP,
  appendLearningHistory,
  loadLearningHistory,
  lockEstimateUser,
  lockLearnUser,
} from '../src/index.js';
import { Scenario } from './learn/fixtures.js';
import {
  asTenant,
  setupDbTest,
  sqlStateOf,
  withConnection,
  type DbTestContext,
} from './support/test-db.js';

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RawRow {
  id: string;
  kind: string;
  n: number;
  at: Date;
}

async function raw(userId: string, kind?: string): Promise<RawRow[]> {
  const result = await ctx.owner.query<RawRow>(
    `SELECT id::text AS id, kind, n, at FROM user_learning_history
      WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY at, id`,
    [userId, kind ?? null],
  );
  return result.rows;
}

async function count(userId: string, kind?: string): Promise<number> {
  return (await raw(userId, kind)).length;
}

/** `rows` rows of `kind`, n = 1..rows, at = `baseMs` + n minutes (oldest first by n). */
async function seed(userId: string, kind: string, rows: number, baseMs: number): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO user_learning_history (user_id, kind, n, at)
     SELECT $1, $2, g, to_timestamp(($3::bigint + g * 60000) / 1000.0) FROM generate_series(1, $4::int) g`,
    [userId, kind, baseMs, rows],
  );
}

const append = (
  userId: string,
  kind: 'model' | 'estimate',
  over: Partial<Parameters<typeof appendLearningHistory>[1]> = {},
) =>
  ctx.worker.transaction((tx) =>
    appendLearningHistory(tx, { userId, kind, n: 1, auc: null, ...over }),
  );

const BASE = Date.now() - 10 * 24 * 3600 * 1000;

describe('LEARNING_HISTORY_KEEP', () => {
  it('is 200', () => {
    expect(LEARNING_HISTORY_KEEP).toBe(200);
  });
});

describe('appendLearningHistory', () => {
  it('stores every field and loadLearningHistory reads it back', async () => {
    const s = await Scenario.create(ctx);
    const at = new Date(BASE);
    await append(s.userId, 'model', {
      n: 48,
      auc: 0.7123456789012345,
      baselineAuc: 0.6123456789012345,
      activated: true,
      turnedOn: true,
      engineModel: 'jev-1.14.0',
      reason: 'low_auc,worse_logloss',
      at,
    });
    const loaded = await loadLearningHistory(ctx.worker, s.userId);
    expect(loaded.rows).toEqual([
      {
        at,
        kind: 'model',
        n: 48,
        auc: 0.7123456789012345,
        baselineAuc: 0.6123456789012345,
        activated: true,
        turnedOn: true,
        engineModel: 'jev-1.14.0',
        reason: 'low_auc,worse_logloss',
      },
    ]);
    expect(loaded.truncated).toEqual({ model: false, estimate: false });
  });

  it('defaults the optional fields and takes at from the database clock', async () => {
    const s = await Scenario.create(ctx);
    const before = Date.now();
    await append(s.userId, 'estimate', { n: 12, auc: 0.8 });
    const after = Date.now();
    const [row] = (await loadLearningHistory(ctx.worker, s.userId)).rows;
    expect(row).toMatchObject({
      kind: 'estimate',
      n: 12,
      auc: 0.8,
      baselineAuc: null,
      activated: false,
      turnedOn: false,
      engineModel: null,
      reason: null,
    });
    // The database now() of the transaction, within a generous clock-skew window of this process.
    expect(row!.at.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(row!.at.getTime()).toBeLessThanOrEqual(after + 5000);
    const stored = await ctx.owner.query<{ same: boolean }>(
      `SELECT at BETWEEN now() - interval '1 minute' AND now() AS same
         FROM user_learning_history WHERE user_id = $1`,
      [s.userId],
    );
    expect(stored.rows[0]?.same).toBe(true);
  });

  it('keeps an explicit at, also one in the past', async () => {
    const s = await Scenario.create(ctx);
    const at = new Date('2020-01-02T03:04:05.678Z');
    await append(s.userId, 'estimate', { n: 3, auc: null, at });
    expect((await loadLearningHistory(ctx.worker, s.userId)).rows[0]?.at).toEqual(at);
  });

  it('stores a null or absent engineModel as null', async () => {
    const s = await Scenario.create(ctx);
    await append(s.userId, 'model', { n: 1, auc: 0.5, engineModel: null });
    await append(s.userId, 'model', { n: 2, auc: 0.5 });
    await append(s.userId, 'model', { n: 3, auc: 0.5, engineModel: 'jev-2.0.0' });
    const rows = (await loadLearningHistory(ctx.worker, s.userId)).rows;
    expect(rows.map((r) => r.engineModel)).toEqual([null, null, 'jev-2.0.0']);
  });

  it('stores NaN and Infinity auc values as null', async () => {
    const s = await Scenario.create(ctx);
    await append(s.userId, 'model', { n: 1, auc: Number.NaN, baselineAuc: Number.NaN });
    await append(s.userId, 'model', {
      n: 2,
      auc: Number.POSITIVE_INFINITY,
      baselineAuc: Number.NEGATIVE_INFINITY,
    });
    await append(s.userId, 'model', { n: 3, auc: 0.5, baselineAuc: 0.25 });
    const rows = (await loadLearningHistory(ctx.worker, s.userId)).rows;
    expect(rows.map((r) => [r.n, r.auc, r.baselineAuc])).toEqual([
      [1, null, null],
      [2, null, null],
      [3, 0.5, 0.25],
    ]);
  });

  it('rejects an unknown kind and a negative n (23514)', async () => {
    const s = await Scenario.create(ctx);
    expect(
      await sqlStateOf(
        ctx.owner.query(
          `INSERT INTO user_learning_history (user_id, kind, n) VALUES ($1, 'bogus', 1)`,
          [s.userId],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlStateOf(
        ctx.owner.query(
          `INSERT INTO user_learning_history (user_id, kind, n) VALUES ($1, 'model', -1)`,
          [s.userId],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlStateOf(
        ctx.worker.transaction((tx) =>
          appendLearningHistory(tx, {
            userId: s.userId,
            kind: 'bogus' as unknown as 'model',
            n: 1,
            auc: null,
          }),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlStateOf(
        ctx.worker.transaction((tx) =>
          appendLearningHistory(tx, { userId: s.userId, kind: 'model', n: -1, auc: null }),
        ),
      ),
    ).toBe('23514');
    expect(await count(s.userId)).toBe(0);
  });

  it('an aborted transaction leaves no row behind', async () => {
    const s = await Scenario.create(ctx);
    await expect(
      ctx.worker.transaction(async (tx) => {
        await appendLearningHistory(tx, { userId: s.userId, kind: 'model', n: 1, auc: null });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await count(s.userId)).toBe(0);
  });
});

describe('retention', () => {
  it('one append to 205 pre-loaded rows of a kind leaves exactly the newest 200', async () => {
    const s = await Scenario.create(ctx);
    await seed(s.userId, 'estimate', 205, BASE);
    // The setup is real: more than the cap is stored before the append.
    expect(await count(s.userId, 'estimate')).toBe(205);

    await append(s.userId, 'estimate', { n: 1000, auc: null });

    const rows = await raw(s.userId, 'estimate');
    expect(rows).toHaveLength(200);
    // 205 seeded + the new one = 206; the 6 oldest (n = 1..6) are gone, the new row is kept.
    expect(rows.map((r) => r.n).sort((x, y) => x - y)).toEqual([
      ...Array.from({ length: 199 }, (_, i) => i + 7),
      1000,
    ]);
  });

  it('breaks ties on at by id: with equal times the highest ids survive, including the new row', async () => {
    const s = await Scenario.create(ctx);
    const at = new Date(BASE);
    await ctx.owner.query(
      `INSERT INTO user_learning_history (user_id, kind, n, at)
       SELECT $1, 'model', g, $2 FROM generate_series(1, 205) g`,
      [s.userId, at],
    );
    expect(await count(s.userId, 'model')).toBe(205);
    await append(s.userId, 'model', { n: 1000, auc: null, at });

    const rows = await raw(s.userId, 'model');
    expect(rows).toHaveLength(200);
    const all = rows.map((r) => BigInt(r.id));
    // The seeded ids are consecutive; the survivors are the newest 200 ids of the 206.
    const max = all.reduce((a, b) => (a > b ? a : b));
    expect(all.map(Number).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 200 }, (_, i) => Number(max) - 199 + i),
    );
    expect(rows.some((r) => r.n === 1000)).toBe(true);
    expect(rows.filter((r) => r.n === 1).length).toBe(0);
    expect(rows.filter((r) => r.n === 6).length).toBe(0);
    expect(rows.filter((r) => r.n === 7).length).toBe(1);
  });

  it('prunes by time, not by insertion order: an old explicit at is the first to go', async () => {
    const s = await Scenario.create(ctx);
    await seed(s.userId, 'estimate', 200, BASE);
    await append(s.userId, 'estimate', { n: 5000, auc: null, at: new Date(BASE - 86_400_000) });
    const rows = await raw(s.userId, 'estimate');
    expect(rows).toHaveLength(200);
    expect(rows.some((r) => r.n === 5000)).toBe(false);
  });

  it('never touches the other kind or another user', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await seed(a.userId, 'estimate', 205, BASE);
    await seed(a.userId, 'model', 7, BASE);
    await seed(b.userId, 'estimate', 230, BASE);
    await seed(b.userId, 'model', 3, BASE);
    expect(await count(a.userId, 'estimate')).toBe(205);

    await append(a.userId, 'estimate', { n: 1, auc: null });

    expect(await count(a.userId, 'estimate')).toBe(200);
    expect(await count(a.userId, 'model')).toBe(7);
    expect(await count(b.userId, 'estimate')).toBe(230);
    expect(await count(b.userId, 'model')).toBe(3);

    await append(a.userId, 'model', { n: 1, auc: null });
    expect(await count(a.userId, 'model')).toBe(8);
    expect(await count(a.userId, 'estimate')).toBe(200);
  });

  it('cuts a user with 230 pre-loaded rows to 200 at the next append', async () => {
    const s = await Scenario.create(ctx);
    await seed(s.userId, 'model', 230, BASE);
    expect(await count(s.userId, 'model')).toBe(230);
    await append(s.userId, 'model', { n: 9999, auc: null });
    const rows = await raw(s.userId, 'model');
    expect(rows).toHaveLength(200);
    expect(Math.min(...rows.map((r) => r.n))).toBe(32);
    expect(rows.some((r) => r.n === 9999)).toBe(true);
  });

  it('205 appends of one kind keep 200, the newest ones', async () => {
    const s = await Scenario.create(ctx);
    for (let i = 1; i <= 205; i += 1) {
      await ctx.worker.transaction((tx) =>
        appendLearningHistory(tx, {
          userId: s.userId,
          kind: 'estimate',
          n: i,
          auc: null,
          at: new Date(BASE + i * 60_000),
        }),
      );
    }
    const rows = await raw(s.userId, 'estimate');
    expect(rows).toHaveLength(200);
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 200 }, (_, i) => i + 6));
  }, 120_000);
});

describe('loadLearningHistory', () => {
  it('returns an empty history for a user without rows', async () => {
    const s = await Scenario.create(ctx);
    expect(await loadLearningHistory(ctx.worker, s.userId)).toEqual({
      rows: [],
      truncated: { model: false, estimate: false },
    });
  });

  it('returns the rows oldest first (at, then id), mixing kinds', async () => {
    const s = await Scenario.create(ctx);
    const t = (minutes: number) => new Date(BASE + minutes * 60_000);
    await append(s.userId, 'model', { n: 3, auc: null, at: t(3) });
    await append(s.userId, 'estimate', { n: 1, auc: null, at: t(1) });
    await append(s.userId, 'estimate', { n: 2, auc: null, at: t(2) });
    // Equal times: the earlier insert (lower id) comes first.
    await append(s.userId, 'model', { n: 4, auc: null, at: t(4) });
    await append(s.userId, 'estimate', { n: 5, auc: null, at: t(4) });
    const { rows } = await loadLearningHistory(ctx.worker, s.userId);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.kind)).toEqual(['estimate', 'estimate', 'model', 'model', 'estimate']);
  });

  it('returns only the given user’s rows', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await append(a.userId, 'model', { n: 11, auc: null });
    await append(b.userId, 'estimate', { n: 22, auc: null });
    expect((await loadLearningHistory(ctx.worker, a.userId)).rows.map((r) => r.n)).toEqual([11]);
    expect((await loadLearningHistory(ctx.worker, b.userId)).rows.map((r) => r.n)).toEqual([22]);
  });

  it('flags truncated per kind exactly when the user has 200 or more rows of that kind', async () => {
    const s = await Scenario.create(ctx);
    await seed(s.userId, 'model', 199, BASE);
    await seed(s.userId, 'estimate', 200, BASE);
    expect((await loadLearningHistory(ctx.worker, s.userId)).truncated).toEqual({
      model: false,
      estimate: true,
    });
    await seed(s.userId, 'model', 1, BASE + 86_400_000);
    expect((await loadLearningHistory(ctx.worker, s.userId)).truncated).toEqual({
      model: true,
      estimate: true,
    });
    // Another user's volume does not leak into this one's flags.
    const other = await Scenario.create(ctx);
    await seed(other.userId, 'model', 5, BASE);
    expect((await loadLearningHistory(ctx.worker, other.userId)).truncated).toEqual({
      model: false,
      estimate: false,
    });
  });

  it('reads through the capped history: 205 appends then 200 rows, truncated', async () => {
    const s = await Scenario.create(ctx);
    await seed(s.userId, 'estimate', 205, BASE);
    await append(s.userId, 'estimate', { n: 1, auc: null });
    const loaded = await loadLearningHistory(ctx.worker, s.userId);
    expect(loaded.rows).toHaveLength(200);
    expect(loaded.truncated.estimate).toBe(true);
  });
});

describe('ownership and privileges', () => {
  it('cascades the rows when the user is deleted', async () => {
    const s = await Scenario.create(ctx);
    await append(s.userId, 'model', { n: 1, auc: null });
    await append(s.userId, 'estimate', { n: 2, auc: null });
    expect(await count(s.userId)).toBe(2);
    await ctx.owner.query('DELETE FROM users WHERE id = $1', [s.userId]);
    expect(await count(s.userId)).toBe(0);
  });

  it('the app role reads its own rows through the tenant setting and nobody else’s', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await append(a.userId, 'model', { n: 41, auc: 0.7 });
    await append(b.userId, 'estimate', { n: 42, auc: 0.6 });
    const read = (tenant: string | null) =>
      asTenant(ctx.appPool, tenant, async (client) =>
        (
          await client.query<{ n: number }>('SELECT n FROM user_learning_history ORDER BY n')
        ).rows.map((r) => r.n),
      );
    expect(await read(a.userId)).toEqual([41]);
    expect(await read(b.userId)).toEqual([42]);
    expect(await read(null)).toEqual([]);
  });

  it('the app role cannot insert, update or delete (42501)', async () => {
    const a = await Scenario.create(ctx);
    await append(a.userId, 'model', { n: 1, auc: null });
    const deny = (sql: string) =>
      sqlStateOf(asTenant(ctx.appPool, a.userId, (client) => client.query(sql, [a.userId])));
    expect(
      await deny(`INSERT INTO user_learning_history (user_id, kind, n) VALUES ($1, 'model', 1)`),
    ).toBe('42501');
    expect(await deny('UPDATE user_learning_history SET n = n + 1 WHERE user_id = $1')).toBe(
      '42501',
    );
    expect(await deny('DELETE FROM user_learning_history WHERE user_id = $1')).toBe('42501');
    expect(await count(a.userId)).toBe(1);
  });

  it('the app role has no right on the identity sequence', async () => {
    const result = await ctx.owner.query<{ usage: boolean; update: boolean }>(
      `SELECT has_sequence_privilege('bantoozi_app', 'user_learning_history_id_seq', 'USAGE') AS usage,
              has_sequence_privilege('bantoozi_app', 'user_learning_history_id_seq', 'UPDATE') AS update`,
    );
    expect(result.rows[0]).toEqual({ usage: false, update: false });
  });
});

describe('serialisation with the existing per-user locks', () => {
  /** The learn handler’s writer transaction (advisory learn lock, users FOR NO KEY UPDATE) and the
   * estimate handler’s (advisory estimate lock, users FOR SHARE) conflict on the users row, so the
   * history append needs no lock of its own. */
  const holdLearn = async (
    first: pg.PoolClient,
    userId: string,
    hold: Promise<void>,
    locked: () => void,
  ) =>
    createSessionDatabase(first).transaction(async (tx) => {
      expect(await lockLearnUser(tx, userId, 'update')).toBe(true);
      await appendLearningHistory(tx, { userId, kind: 'model', n: 1, auc: null });
      locked();
      await hold;
    });

  it('a learn-style transaction blocks an estimate-style one of the same user until it commits', async () => {
    const s = await Scenario.create(ctx);
    await withConnection(ctx.workerPool, async (first) =>
      withConnection(ctx.workerPool, async (second) => {
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const firstLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const order: string[] = [];
        const one = holdLearn(first, s.userId, hold, locked).then(() => order.push('learn-commit'));
        await Promise.race([firstLocked, one]);
        const two = createSessionDatabase(second).transaction(async (tx) => {
          expect(await lockEstimateUser(tx, s.userId)).toBe(true);
          order.push('estimate-locked');
          await appendLearningHistory(tx, { userId: s.userId, kind: 'estimate', n: 2, auc: null });
        });
        await sleep(400);
        expect(order).toEqual([]);
        release();
        await Promise.all([one, two]);
        // Both clients see their answers in either order once the lock is released; what matters
        // is that nothing ran before the release (checked above).
        expect([...order].sort()).toEqual(['estimate-locked', 'learn-commit']);
      }),
    );
    expect((await raw(s.userId)).map((r) => r.kind).sort()).toEqual(['estimate', 'model']);
  });

  it('does not block an estimate-style transaction of another user', async () => {
    const a = await Scenario.create(ctx);
    const b = await Scenario.create(ctx);
    await withConnection(ctx.workerPool, async (first) =>
      withConnection(ctx.workerPool, async (second) => {
        let release!: () => void;
        const hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const firstLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const one = holdLearn(first, a.userId, hold, locked);
        await Promise.race([firstLocked, one]);
        const other = await Promise.race([
          createSessionDatabase(second).transaction(async (tx) => {
            await lockEstimateUser(tx, b.userId);
            await appendLearningHistory(tx, {
              userId: b.userId,
              kind: 'estimate',
              n: 3,
              auc: null,
            });
            return 'done' as const;
          }),
          sleep(15_000).then(() => 'blocked' as const),
        ]);
        release();
        await one;
        expect(other).toBe('done');
      }),
    );
    expect(await count(b.userId, 'estimate')).toBe(1);
  });
});
