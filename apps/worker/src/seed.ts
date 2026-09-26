import { pathToFileURL } from 'node:url';

import {
  createDatabase,
  createPool,
  insertSettingIfMissing,
  type Database,
  type Transaction,
} from '@bantoozi/db';
import {
  SEEDED_SETTING_KEYS,
  parseSetting,
  settingDefault,
  type SettingEnvDefaults,
} from '@bantoozi/shared';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

/**
 * `pnpm db:seed` (spec 02 §2): inserts only `card_text_mode`, `question_sets.active = {}` and
 * `language_modes` (from `LANGUAGE_MODES`) when they are missing, then runs the content hooks. It
 * never overwrites a stored value, so running it again — even with another `LANGUAGE_MODES` —
 * changes nothing. Deploys run it after the migrate job and before the services start.
 */

/** Seed content that later milestones provide (M2: taxonomy, question sets, card library). */
export interface SeedHooks {
  /** Topics (spec 05 §3.2); the database rejects a level-2 topic without a level-1 parent. */
  taxonomy?: (tx: Transaction) => Promise<void>;
  /** Immutable question sets; may fill absent kinds of `question_sets.active` (spec 05 §2). */
  questionSets?: (tx: Transaction) => Promise<void>;
  /** The reviewed public card library (spec 05 §8). */
  library?: (tx: Transaction) => Promise<void>;
}

export interface SeedResult {
  /** Setting keys this run inserted (empty when every key already existed). */
  insertedSettings: string[];
}

export async function runSeed(
  db: Database,
  env: SettingEnvDefaults,
  hooks: SeedHooks = {},
): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const insertedSettings: string[] = [];
    for (const key of SEEDED_SETTING_KEYS) {
      const value = parseSetting(key, settingDefault(key, env));
      if (await insertSettingIfMissing(tx, key, value)) insertedSettings.push(key);
    }
    await hooks.taxonomy?.(tx);
    await hooks.questionSets?.(tx);
    await hooks.library?.(tx);
    return { insertedSettings };
  });
}

async function main(): Promise<void> {
  const config = loadConfig({ process: 'worker' });
  const logger = createLogger({ name: 'seed', level: config.logLevel });
  const pool = createPool({
    connectionString: config.databaseUrlWorker,
    max: 1,
    applicationName: 'bantoozi-seed',
  });
  try {
    const result = await runSeed(createDatabase(pool), {
      dailyBudgetUsd: config.dailyBudgetUsd,
      languageModes: config.languageModes,
      signupMode: config.signupMode,
    });
    logger.info(result, 'seed finished');
  } catch (error) {
    logger.error({ err: error }, 'seed failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
