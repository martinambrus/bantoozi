import { PG_BOSS_VERSION, MIGRATIONS_FOLDER, runMigrations } from '@bantoozi/db';
import { EngineModelResolutionSchema } from '@bantoozi/shared';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbOf } from './support/model-pin-world.js';

/**
 * JEV-2-C (resolution row): `recordModelResolution` writes `engine.model_resolution` under the row
 * lock: a first answer, the same answer again (only `checkedAt` moves) and another model (the old
 * one moves to `previous`).
 */
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;

const ALIAS = 'jev-latest';
const M = 'jev-1.13.0';
const M2 = 'jev-1.14.0';
const T0 = new Date('2026-10-01T00:00:00.000Z');
const T1 = new Date('2026-10-02T00:00:00.000Z');
const T2 = new Date('2026-10-03T00:00:00.000Z');

interface Outcome {
  changed: boolean;
  previous?: { model: string; until: string } | string;
}

async function record(input: {
  alias: string;
  model: string;
  now: Date;
  expectedModel?: string | null;
}): Promise<Outcome> {
  const mod = (await import('../src/model-resolution.js')) as {
    recordModelResolution: (db: unknown, input: unknown) => Promise<Outcome>;
  };
  const parsed = EngineModelResolutionSchema.safeParse(await row());
  return mod.recordModelResolution(dbOf(workerPool), {
    expectedModel: parsed.success ? parsed.data.model : null,
    ...input,
  });
}

async function row(): Promise<unknown> {
  const result = await owner.query<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'engine.model_resolution'`,
  );
  return result.rows[0]?.value;
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
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 3 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 6 });
}, 240_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await owner.query(`DELETE FROM settings WHERE key = 'engine.model_resolution'`);
});

describe('recordModelResolution', () => {
  it('R1 writes a missing row with resolvedAt = checkedAt = now and reports a change', async () => {
    const result = await record({ alias: ALIAS, model: M, now: T0 });
    expect(result.changed).toBe(true);
    expect(result).not.toHaveProperty('previous');
    expect(await row()).toEqual({
      alias: ALIAS,
      model: M,
      resolvedAt: T0.toISOString(),
      checkedAt: T0.toISOString(),
    });
  });

  it('R2 the same model later moves only checkedAt', async () => {
    await record({ alias: ALIAS, model: M, now: T0 });
    const result = await record({ alias: ALIAS, model: M, now: T1 });
    expect(result.changed).toBe(false);
    expect(await row()).toEqual({
      alias: ALIAS,
      model: M,
      resolvedAt: T0.toISOString(),
      checkedAt: T1.toISOString(),
    });
    // Control: another model on the same row is a change (see R3).
    expect((await record({ alias: ALIAS, model: M2, now: T2 })).changed).toBe(true);
  });

  it('R3 another model records previous = the old model until now and restarts both times', async () => {
    await record({ alias: ALIAS, model: M, now: T0 });
    await record({ alias: ALIAS, model: M, now: T1 });
    const result = await record({ alias: ALIAS, model: M2, now: T2 });
    expect(result.changed).toBe(true);
    // The result names the old model (as the bare id or as the stored {model, until}).
    const previous = result.previous;
    expect(typeof previous === 'string' ? previous : previous?.model).toBe(M);
    expect(await row()).toEqual({
      alias: ALIAS,
      model: M2,
      resolvedAt: T2.toISOString(),
      checkedAt: T2.toISOString(),
      previous: { model: M, until: T2.toISOString() },
    });
  });

  it('R4 every stored value satisfies EngineModelResolutionSchema', async () => {
    const steps = [
      { model: M, now: T0 },
      { model: M, now: T1 },
      { model: M2, now: T2 },
    ];
    for (const step of steps) {
      await record({ alias: ALIAS, ...step });
      expect(EngineModelResolutionSchema.safeParse(await row()).success).toBe(true);
    }
    // Control: the schema is strict and refuses a non-concrete model.
    expect(
      EngineModelResolutionSchema.safeParse({
        alias: ALIAS,
        model: 'jev-latest',
        resolvedAt: T0.toISOString(),
        checkedAt: T0.toISOString(),
      }).success,
    ).toBe(false);
  });

  it('R5 two concurrent calls with the same answer leave one valid row', async () => {
    const results = await Promise.all([
      record({ alias: ALIAS, model: M, now: T0 }),
      record({ alias: ALIAS, model: M, now: T1 }),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const count = await owner.query(`SELECT 1 FROM settings WHERE key = 'engine.model_resolution'`);
    expect(count.rowCount).toBe(1);
    const stored = EngineModelResolutionSchema.parse(await row());
    expect(stored).toMatchObject({ alias: ALIAS, model: M });
    expect(stored).not.toHaveProperty('previous');
    expect(stored.checkedAt >= stored.resolvedAt).toBe(true);
  });

  it('leaves an interleaved adoption untouched when a stale run acquires the row lock', async () => {
    await record({ alias: ALIAS, model: M, now: T0 });
    const decision = EngineModelResolutionSchema.parse(await row());
    const interleaved = await workerPool.connect();
    let stale: Promise<Outcome> | undefined;
    try {
      await interleaved.query('BEGIN');
      await interleaved.query(`SELECT value FROM settings
        WHERE key = 'engine.model_resolution' FOR UPDATE`);
      stale = record({ alias: ALIAS, model: M, now: T2, expectedModel: decision.model });
      await interleaved.query(
        `UPDATE settings SET value = $1::jsonb
        WHERE key = 'engine.model_resolution'`,
        [
          JSON.stringify({
            alias: ALIAS,
            model: M2,
            resolvedAt: T1.toISOString(),
            checkedAt: T1.toISOString(),
            previous: { model: M, until: T1.toISOString() },
          }),
        ],
      );
      const adopted = await interleaved.query(`SELECT value FROM settings
        WHERE key = 'engine.model_resolution'`);
      await interleaved.query('COMMIT');
      expect(await stale).toEqual({ changed: false });
      expect(await row()).toEqual(adopted.rows[0].value);
    } finally {
      await interleaved.query('ROLLBACK');
      interleaved.release();
      await stale;
    }
  });

  it('R6 a non-alias alias or a non-concrete model is rejected and writes nothing', async () => {
    const bad = [
      { alias: M, model: M },
      { alias: 'latest', model: M },
      { alias: ALIAS, model: ALIAS },
      { alias: ALIAS, model: 'gpt-4' },
      { alias: ALIAS, model: '' },
    ];
    for (const input of bad) {
      await expect(record({ ...input, now: T0 })).rejects.toThrow();
      expect(await row()).toBeUndefined();
    }
    // Control: the valid pair is accepted.
    await expect(record({ alias: ALIAS, model: M, now: T0 })).resolves.toMatchObject({
      changed: true,
    });
    expect(await row()).toBeDefined();
  });
});
