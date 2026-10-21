import { createDatabase, MIGRATIONS_FOLDER, PG_BOSS_VERSION, runMigrations } from '@bantoozi/db';
import { dropCreatedTestDatabases, setupTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as seed from '../src/seed.js';
import { pinRow, resetPin } from './support/model-pin-world.js';

/**
 * JEV-2-C (seed): `seedModelPinOf` turns the effective runtime values into the pin `pnpm db:seed`
 * inserts: the effective concrete model (never the alias), or nothing while an alias is unresolved.
 */
let owner: pg.Pool;
let worker: pg.Pool;

const LLM = { fast: 'glm-fast', strong: 'glm-strong' };
const M = 'jev-1.13.0';
const M2 = 'jev-1.14.0';
const ALIAS = 'jev-latest';

beforeAll(async () => {
  const testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 2 });
  worker = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
}, 240_000);

afterAll(async () => {
  await Promise.all([owner?.end(), worker?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await resetPin(owner);
});

interface Pin {
  model: string;
  llm?: { fast: string; strong: string } | undefined;
}

function pinOf(values: {
  typesafeModel: string;
  typesafeResolvedModel: string | null;
  llm?: boolean;
}): Pin | undefined {
  const fn = (seed as unknown as Record<string, unknown>)['seedModelPinOf'] as (
    values: unknown,
  ) => Pin | undefined;
  return fn({
    typesafeModel: values.typesafeModel,
    typesafeResolvedModel: values.typesafeResolvedModel,
    llmFallbackEnabled: values.llm === true,
    ollamaModels: { ...LLM },
  });
}

const seedEnv = (pin: Pin | undefined) =>
  ({
    dailyBudgetUsd: 5,
    languageModes: { en: 'native', sk: 'native', cs: 'native' },
    signupMode: 'invite',
    ...(pin === undefined ? {} : { modelPin: pin }),
  }) as never;

describe('seedModelPinOf', () => {
  it('S1 maps the effective values to the pin the seed inserts', async () => {
    expect(pinOf({ typesafeModel: M, typesafeResolvedModel: null })).toStrictEqual({ model: M });
    expect(pinOf({ typesafeModel: M, typesafeResolvedModel: null, llm: true })).toStrictEqual({
      model: M,
      llm: LLM,
    });
    // A resolution next to a concrete setting is ignored.
    expect(pinOf({ typesafeModel: M, typesafeResolvedModel: M2 })).toStrictEqual({ model: M });

    expect(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: M })).toStrictEqual({ model: M });
    expect(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: M2 })).toStrictEqual({ model: M2 });
    expect(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: M, llm: true })).toStrictEqual({
      model: M,
      llm: LLM,
    });
    expect(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: null })).toBeUndefined();
    expect(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: null, llm: true })).toBeUndefined();
  });

  it('S2 runSeed inserts the resolved concrete model, never the alias, and no pin while unresolved', async () => {
    const db = createDatabase(worker);
    await seed.runSeed(db, seedEnv(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: M })));
    const row = await pinRow(owner);
    expect(row).toMatchObject({ model: M });
    expect(JSON.stringify(row)).not.toContain(ALIAS);
    expect(row).not.toHaveProperty('alias');

    // Unresolved alias: no pin row at all.
    await resetPin(owner);
    await seed.runSeed(db, seedEnv(pinOf({ typesafeModel: ALIAS, typesafeResolvedModel: null })));
    expect(await pinRow(owner)).toBeUndefined();

    // Control: a concrete setting inserts its model.
    await seed.runSeed(db, seedEnv(pinOf({ typesafeModel: M2, typesafeResolvedModel: null })));
    expect(await pinRow(owner)).toMatchObject({ model: M2 });
  });
});
