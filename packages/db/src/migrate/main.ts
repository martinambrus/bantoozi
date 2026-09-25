import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { runMigrations } from './migrate.js';

/** `pnpm db:migrate`: the one-shot migrate job (spec 01 §4); exits non-zero on failure. */
const config = loadConfig({ process: 'migrate' });
const logger = createLogger({ name: 'migrate', level: config.logLevel });

try {
  const result = await runMigrations({ databaseUrl: config.databaseUrlMigrate, logger });
  logger.info(result, 'migrate job finished');
} catch (error) {
  logger.error({ err: error }, 'migrate job failed');
  process.exitCode = 1;
}
