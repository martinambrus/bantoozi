import { createDatabase, createPool } from '@bantoozi/db';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { createBoss, pgBossBroker, registerHandlers } from './boss.js';
import { HANDLERS } from './handlers/index.js';
import { startOutboxRelay } from './outbox-relay.js';
import { assertProductionReady } from './readiness.js';

/** The worker process (spec 01 §4): pg-boss consumers for WORKER_QUEUES plus the outbox relay. */
const config = loadConfig({ process: 'worker' });
const logger = createLogger({
  name: 'worker',
  level: config.logLevel,
  pretty: config.nodeEnv === 'development',
});

const unavailable = assertProductionReady(config.nodeEnv, HANDLERS, config.workerQueues);
if (unavailable.length > 0) {
  logger.warn({ unavailable }, 'stages not implemented yet: their jobs and intents stay pending');
}

const pool = createPool({
  connectionString: config.databaseUrlWorker,
  max: 5,
  applicationName: 'bantoozi-worker',
});
const boss = createBoss(config.databaseUrlWorker);
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
await boss.start();
const registration = await registerHandlers(boss, HANDLERS, config.workerQueues, logger);
const relay = startOutboxRelay(createDatabase(pool), pgBossBroker(boss), {
  handlers: HANDLERS,
  logger,
});
logger.info(registration, 'worker started');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  try {
    await relay.stop();
    await boss.stop({ graceful: true, timeout: 20_000, wait: true });
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
