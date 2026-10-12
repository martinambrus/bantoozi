import {
  PG_BOSS_VERSION,
  MIGRATIONS_FOLDER,
  readRatingFingerprint,
  runMigrations,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LAYA,
  callRecordModelPin,
  dbOf,
  pinIntents,
  pinRow,
  resetPin,
  seedWithPin,
  type WorkerPin,
} from './support/model-pin-world.js';

/**
 * M8-T2 `engine.model_pin` (PLAN §14 M8-T2, D-164, spec 11 §8, spec 06 §8.1): the rating
 * fingerprint ignores `since` and `llm`; `pnpm db:seed` creates the row; a worker start records a
 * changed model, fallback state or fallback models once, under the row lock, with one
 * `house.reenrich` and one `house.rematch` intent.
 */
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;

const M = 'jev-1.13.0';
const LLM = { fast: 'glm-fast', strong: 'glm-strong' };
const T0 = new Date('2026-10-01T00:00:00.000Z');
const T1 = new Date('2026-10-02T00:00:00.000Z');
const T2 = new Date('2026-10-03T00:00:00.000Z');
const DEFAULTS = {
  model: M,
  languageModes: { en: 'native', sk: 'native', cs: 'native' } as const,
  cardTextMode: 'as_written' as const,
};
const db = () => dbOf(workerPool);

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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
}, 240_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await resetPin(owner);
});

const fingerprint = () => readRatingFingerprint(db(), DEFAULTS);

describe('rating fingerprint and the pin row', () => {
  it('depends only on the model: a seeded row equals no row, another model differs, llm is ignored', async () => {
    const none = await fingerprint();
    await resetPin(owner, { model: M, since: T0.toISOString() });
    expect(await fingerprint()).toBe(none);
    await resetPin(owner, { model: M, since: T1.toISOString() });
    expect(await fingerprint()).toBe(none);
    await resetPin(owner, { model: M, llm: LLM, since: T0.toISOString() });
    expect(await fingerprint()).toBe(none);
    await resetPin(owner, { model: 'jev-2', since: T0.toISOString() });
    expect(await fingerprint()).not.toBe(none);
  });
});

describe('pnpm db:seed', () => {
  it('inserts the pin with the configured model, since and llm only while the fallback is on; a rerun changes nothing', async () => {
    await seedWithPin(db(), { model: M });
    const row = await pinRow(owner);
    expect(row).toEqual({ model: M, since: expect.any(String) });
    expect(Number.isNaN(Date.parse(row!.since))).toBe(false);
    expect(row).not.toHaveProperty('llm');
    await seedWithPin(db(), { model: 'jev-other', llm: LLM });
    expect(await pinRow(owner)).toEqual(row);

    await resetPin(owner);
    await seedWithPin(db(), { model: M, llm: LLM });
    expect(await pinRow(owner)).toEqual({ model: M, llm: LLM, since: expect.any(String) });
    expect(await pinIntents(owner)).toEqual([]);
  });
});

describe('recordModelPin on worker start', () => {
  it('inserts a missing row and records no intent', async () => {
    expect(await callRecordModelPin(db(), { model: M }, T0)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, since: T0.toISOString() });
    expect(await pinIntents(owner)).toEqual([]);
  });

  it('is a no-op for an unchanged pin, so a second worker start changes nothing', async () => {
    await resetPin(owner, { model: M, llm: LLM, since: T0.toISOString() });
    expect(await callRecordModelPin(db(), { model: M, llm: LLM }, T1)).toEqual({ changed: false });
    expect(await callRecordModelPin(db(), { model: M, llm: LLM }, T2)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, llm: LLM, since: T0.toISOString() });
    expect(await pinIntents(owner)).toEqual([]);
  });

  it('records a new model once: row updated, since advanced, one reenrich and one rematch', async () => {
    await resetPin(owner, { model: M, since: T0.toISOString() });
    expect(await callRecordModelPin(db(), { model: 'jev-2' }, T1)).toEqual({ changed: true });
    expect(await pinRow(owner)).toEqual({ model: 'jev-2', since: T1.toISOString() });
    expect(await pinIntents(owner)).toEqual([
      { queue: 'house.reenrich', payload: {} },
      { queue: 'house.rematch', payload: {} },
    ]);
    expect(await callRecordModelPin(db(), { model: 'jev-2' }, T2)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: 'jev-2', since: T1.toISOString() });
    expect((await pinIntents(owner)).length).toBe(2);
  });

  it('counts the fallback switched on, off or with other models as changes and keeps laya', async () => {
    await resetPin(owner, { model: M, laya: LAYA, since: T0.toISOString() });
    const steps: { pin: WorkerPin; at: Date }[] = [
      { pin: { model: M, llm: LLM }, at: new Date('2026-10-02T00:00:00.000Z') },
      {
        pin: { model: M, llm: { fast: 'glm-fast-2', strong: LLM.strong } },
        at: new Date('2026-10-03T00:00:00.000Z'),
      },
      {
        pin: { model: M, llm: { fast: 'glm-fast-2', strong: 'glm-strong-2' } },
        at: new Date('2026-10-04T00:00:00.000Z'),
      },
      { pin: { model: M }, at: new Date('2026-10-05T00:00:00.000Z') },
    ];
    let intents = 0;
    for (const { pin, at } of steps) {
      expect(await callRecordModelPin(db(), pin, at)).toEqual({ changed: true });
      intents += 2;
      expect(await pinRow(owner)).toEqual({ ...pin, laya: LAYA, since: at.toISOString() });
      expect((await pinIntents(owner)).length).toBe(intents);
    }
    expect(await pinIntents(owner)).toEqual([
      ...Array.from({ length: 4 }, () => ({ queue: 'house.reenrich', payload: {} })),
      ...Array.from({ length: 4 }, () => ({ queue: 'house.rematch', payload: {} })),
    ]);
  });

  it('is fenced by a suggestion finishing transaction holding the row FOR SHARE', async () => {
    await resetPin(owner, { model: M, since: T0.toISOString() });
    const holder = await owner.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT key FROM settings WHERE key = 'engine.model_pin' FOR SHARE`);
      let settled = false;
      const call = callRecordModelPin(db(), { model: 'jev-2' }, T1).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void call.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      expect(await pinRow(owner)).toEqual({ model: M, since: T0.toISOString() });
      await holder.query('COMMIT');
      released = true;
      expect(await call).toEqual({ value: { changed: true } });
      expect(await pinRow(owner)).toEqual({ model: 'jev-2', since: T1.toISOString() });
    } finally {
      if (!released) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
