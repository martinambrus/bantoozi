import {
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  createDatabase,
  runMigrations,
  type Transaction,
} from '@bantoozi/db';
import { SEEDED_SETTING_KEYS } from '@bantoozi/shared';
import { dropCreatedTestDatabases, setupTestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runSeed, type SeedHooks } from '../src/seed.js';

let worker: pg.Pool;

beforeAll(async () => {
  const testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  worker = new pg.Pool({ connectionString: testDb.urls.worker, max: 2 });
});

afterAll(async () => {
  await worker.end();
  await dropCreatedTestDatabases();
});

const settings = async () =>
  (
    await worker.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM settings ORDER BY key',
    )
  ).rows;

const env = (languageModes: Record<string, 'native' | 'translate'>) => ({
  dailyBudgetUsd: 5,
  languageModes,
  signupMode: 'invite' as const,
});

describe('pnpm db:seed', () => {
  it('inserts only the three seeded keys, once, and never overwrites them', async () => {
    const first = await runSeed(createDatabase(worker), env({ en: 'native', sk: 'translate' }));
    expect(first.insertedSettings).toEqual([...SEEDED_SETTING_KEYS]);
    const afterFirst = await settings();
    expect(afterFirst).toEqual([
      { key: 'card_text_mode', value: 'as_written' },
      { key: 'language_modes', value: { en: 'native', sk: 'translate' } },
      { key: 'question_sets.active', value: {} },
    ]);

    // A second run with a different LANGUAGE_MODES changes nothing.
    const second = await runSeed(createDatabase(worker), env({ en: 'native', cs: 'native' }));
    expect(second.insertedSettings).toEqual([]);
    expect(await settings()).toEqual(afterFirst);
  });

  it('keeps an administrator’s value and only fills keys that are missing', async () => {
    await worker.query("UPDATE settings SET value = '\"english\"' WHERE key = 'card_text_mode'");
    await worker.query("DELETE FROM settings WHERE key = 'question_sets.active'");
    const result = await runSeed(createDatabase(worker), env({ en: 'native' }));
    expect(result.insertedSettings).toEqual(['question_sets.active']);
    expect(await settings()).toEqual([
      { key: 'card_text_mode', value: 'english' },
      { key: 'language_modes', value: { en: 'native', sk: 'translate' } },
      { key: 'question_sets.active', value: {} },
    ]);
  });

  it('runs the content hooks M2 fills inside the seed transaction', async () => {
    const calls: string[] = [];
    const hook = (name: string) => async (tx: Transaction) => {
      calls.push(name);
      await tx.execute('SELECT 1');
    };
    const hooks: SeedHooks = {
      taxonomy: hook('taxonomy'),
      questionSets: hook('questionSets'),
      library: hook('library'),
    };
    await runSeed(createDatabase(worker), env({ en: 'native' }), hooks);
    expect(calls).toEqual(['taxonomy', 'questionSets', 'library']);

    const failing: SeedHooks = {
      taxonomy: async () => {
        throw new Error('bad taxonomy');
      },
    };
    await worker.query("DELETE FROM settings WHERE key = 'language_modes'");
    await expect(runSeed(createDatabase(worker), env({ en: 'native' }), failing)).rejects.toThrow(
      'bad taxonomy',
    );
    // The whole seed is one transaction: a failing hook leaves nothing half-seeded.
    expect((await settings()).map((s) => s.key)).toEqual([
      'card_text_mode',
      'question_sets.active',
    ]);
  });
});
