import {
  PG_BOSS_VERSION,
  MIGRATIONS_FOLDER,
  readRatingFingerprint,
  runMigrations,
} from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbOf, pinIntents, pinRow, resetPin } from './support/model-pin-world.js';

/**
 * JEV-2-C (pin): `recordModelPin` records the alias a resolved model came from (`jev-latest`)
 * without treating it as a change: an alias added or dropped alone updates the row in place, keeps
 * `since` and enqueues nothing; a model or fallback change behaves as before and replaces the alias.
 * The rating fingerprint ignores the alias.
 */
let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;

const M = 'jev-1.13.0';
const M2 = 'jev-1.14.0';
const ALIAS = 'jev-latest';
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

interface AliasPin {
  model: string;
  alias?: string | undefined;
  llm?: { fast: string; strong: string } | undefined;
}

async function record(pin: AliasPin, now: Date): Promise<{ changed: boolean }> {
  const mod = (await import('../src/model-pin.js')) as {
    recordModelPin: (db: unknown, pin: AliasPin, now: Date) => Promise<{ changed: boolean }>;
  };
  return mod.recordModelPin(db(), pin, now);
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
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
}, 240_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await resetPin(owner);
});

const REENRICH = { queue: 'house.reenrich', payload: {} };
const REMATCH = { queue: 'house.rematch', payload: {} };

describe('recordModelPin with an alias', () => {
  it('P1 stores the alias on the first insert and enqueues nothing; no alias stores none', async () => {
    expect(await record({ model: M, alias: ALIAS }, T0)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await pinIntents(owner)).toEqual([]);

    await resetPin(owner);
    expect(await record({ model: M }, T0)).toEqual({ changed: false });
    const row = await pinRow(owner);
    expect(row).toEqual({ model: M, since: T0.toISOString() });
    expect(row).not.toHaveProperty('alias');
  });

  it('P2 an alias added later to the same model updates in place: since unchanged, no intents', async () => {
    await resetPin(owner, { model: M, since: T0.toISOString() });
    expect(await record({ model: M, alias: ALIAS }, T1)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await pinIntents(owner)).toEqual([]);
    // Control: a different model on top of the same row is a change.
    expect(await record({ model: M2, alias: ALIAS }, T2)).toEqual({ changed: true });
    expect((await pinRow(owner))?.since).toBe(T2.toISOString());
    expect((await pinIntents(owner)).length).toBe(2);
  });

  it('P3 a dropped alias on the same model is removed in place with no intents', async () => {
    await resetPin(owner, { model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await record({ model: M }, T1)).toEqual({ changed: false });
    const row = await pinRow(owner);
    expect(row).toEqual({ model: M, since: T0.toISOString() });
    expect(row).not.toHaveProperty('alias');
    expect(await pinIntents(owner)).toEqual([]);
    // Control: the same alias again is a no-op, a second one-shot update.
    expect(await record({ model: M, alias: ALIAS }, T2)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await record({ model: M, alias: ALIAS }, T2)).toEqual({ changed: false });
    expect(await pinIntents(owner)).toEqual([]);
  });

  it('P4 a model change with an alias present is one change; the alias is replaced or dropped', async () => {
    await resetPin(owner, { model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await record({ model: M2, alias: ALIAS }, T1)).toEqual({ changed: true });
    expect(await pinRow(owner)).toEqual({ model: M2, alias: ALIAS, since: T1.toISOString() });
    expect(await pinIntents(owner)).toEqual([REENRICH, REMATCH]);

    // The alias is dropped when the new pin gives none.
    expect(await record({ model: M }, T2)).toEqual({ changed: true });
    const row = await pinRow(owner);
    expect(row).toEqual({ model: M, since: T2.toISOString() });
    expect(row).not.toHaveProperty('alias');
    expect(await pinIntents(owner)).toEqual([REENRICH, REENRICH, REMATCH, REMATCH]);
  });

  it('P5 a fallback change behaves as before and keeps the alias handling separate', async () => {
    await resetPin(owner, { model: M, alias: ALIAS, since: T0.toISOString() });
    expect(await record({ model: M, alias: ALIAS, llm: LLM }, T1)).toEqual({ changed: true });
    expect(await pinRow(owner)).toEqual({
      model: M,
      alias: ALIAS,
      llm: LLM,
      since: T1.toISOString(),
    });
    expect(await pinIntents(owner)).toEqual([REENRICH, REMATCH]);
    // Control: the same model and fallback with the alias dropped is not a change.
    expect(await record({ model: M, llm: LLM }, T2)).toEqual({ changed: false });
    expect(await pinRow(owner)).toEqual({ model: M, llm: LLM, since: T1.toISOString() });
    expect(await pinIntents(owner)).toEqual([REENRICH, REMATCH]);
  });

  it('P6 the rating fingerprint is equal with and without the alias and differs for another model', async () => {
    const none = await readRatingFingerprint(db(), DEFAULTS);
    await record({ model: M, alias: ALIAS }, T0);
    expect((await pinRow(owner))?.alias).toBe(ALIAS);
    expect(await readRatingFingerprint(db(), DEFAULTS)).toBe(none);
    await resetPin(owner);
    await record({ model: M }, T0);
    expect(await readRatingFingerprint(db(), DEFAULTS)).toBe(none);
    await resetPin(owner);
    await record({ model: M2, alias: ALIAS }, T0);
    expect((await pinRow(owner))?.alias).toBe(ALIAS);
    expect(await readRatingFingerprint(db(), DEFAULTS)).not.toBe(none);
  });
});
