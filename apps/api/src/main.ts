import { createDatabase, createPool } from '@bantoozi/db';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { buildServer } from './server.js';

/** The API process (spec 01 §4): reads config, builds the server, listens, shuts down gracefully. */
const config = loadConfig({ process: 'api' });
const logger = createLogger({
  name: 'api',
  level: config.logLevel,
  pretty: config.nodeEnv === 'development',
});
const pool = createPool({
  connectionString: config.databaseUrl,
  max: 10,
  applicationName: 'bantoozi-api',
});
const app = await buildServer({ db: createDatabase(pool), logger });

await app.listen({
  port: config.apiPort,
  host: config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1',
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'api stopping');
  try {
    await app.close();
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, 'api shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
