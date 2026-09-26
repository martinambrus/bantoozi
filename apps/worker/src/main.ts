import { createDatabase, createPgOriginLimiter, createPool } from '@bantoozi/db';
import { FEED_SCHEDULE_CRON, QUEUES } from '@bantoozi/shared';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { createBoss, pgBossBroker, registerHandlers } from './boss.js';
import { createWorkerDeps } from './handlers/deps.js';
import { createHandlers } from './handlers/index.js';
import { startOutboxRelay } from './outbox-relay.js';
import { assertProductionReady } from './readiness.js';

/** The worker process (spec 01 §4): pg-boss consumers for WORKER_QUEUES plus the outbox relay. */
const config = loadConfig({ process: 'worker' });
const logger = createLogger({
  name: 'worker',
  level: config.logLevel,
  pretty: config.nodeEnv === 'development',
});

const pool = createPool({
  connectionString: config.databaseUrlWorker,
  max: 10,
  applicationName: 'bantoozi-worker',
});
const db = createDatabase(pool);
// Feed fetch locks pin one connection each for a whole fetch (spec 03 §3): a pool of their own.
const lockPool = createPool({
  connectionString: config.databaseUrlWorker,
  max: QUEUES['feed.fetch'].concurrency,
  applicationName: 'bantoozi-worker-locks',
});
// An idle connection dropped by the server must not crash the process (pg emits 'error').
for (const p of [pool, lockPool]) {
  p.on('error', (err) => logger.warn({ err }, 'idle database connection error'));
}
const handlers = createHandlers(
  createWorkerDeps({
    db,
    lockPool,
    fetch: {
      userAgent: config.fetchUserAgent,
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.fetchMaxBytes,
      allowPrivate: config.fetchAllowPrivate,
    },
    ingestMaxAgeDays: config.ingestMaxAgeDays,
    settingsEnv: {
      dailyBudgetUsd: config.dailyBudgetUsd,
      languageModes: config.languageModes,
      signupMode: config.signupMode,
    },
    limiter: createPgOriginLimiter(db),
    logger,
  }),
);

const unavailable = assertProductionReady(config.nodeEnv, handlers, config.workerQueues);
if (unavailable.length > 0) {
  logger.warn({ unavailable }, 'stages not implemented yet: their jobs and intents stay pending');
}

const boss = createBoss(config.databaseUrlWorker);
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
await boss.start();
const registration = await registerHandlers(boss, handlers, config.workerQueues, logger);
if (registration.consuming.includes('feed.schedule')) {
  // Every minute (spec 03 §3); pg-boss keeps one schedule row per queue across workers.
  await boss.schedule('feed.schedule', FEED_SCHEDULE_CRON, {}, { tz: 'UTC' });
}
const relay = startOutboxRelay(db, pgBossBroker(boss), { handlers, logger });
logger.info(registration, 'worker started');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  try {
    await relay.stop();
    await boss.stop({ graceful: true, timeout: 20_000, wait: true });
    await Promise.all([pool.end(), lockPool.end()]);
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
