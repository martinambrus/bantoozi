import { createDatabase, createPgOriginLimiter, createPool } from '@bantoozi/db';
import {
  FEED_SCHEDULE_CRON,
  HOUSE_CRON_SCHEDULES,
  QUEUES,
  type HouseCronQueue,
  type HouseCronSchedule,
} from '@bantoozi/shared';
import { createLogger, loadConfig } from '@bantoozi/shared/server';

import { createBoss, pgBossBroker, registerHandlers } from './boss.js';
import { createWorkerModels } from './classification-deps.js';
import { createWorkerDeps } from './handlers/deps.js';
import { createHandlers } from './handlers/index.js';
import { enqueueOverdueHousekeeping } from './housekeeping.js';
import { startOutboxRelay } from './outbox-relay.js';
import { assertProductionReady } from './readiness.js';
import { verifyQuestionSets } from './seed.js';

/**
 * The worker process (spec 01 §4): pg-boss consumers for WORKER_QUEUES plus the outbox relay. The
 * classification stages and `provider.validate` reach the models only through one engine router
 * (spec 04 §1).
 */
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
const models = createWorkerModels(db, config, logger);
const settingsEnv = {
  dailyBudgetUsd: config.dailyBudgetUsd,
  languageModes: config.languageModes,
  signupMode: config.signupMode,
};
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
    settingsEnv,
    limiter: createPgOriginLimiter(db),
    logger,
    classification: models.classification,
    providerValidation: models.providerValidation,
  }),
);

const unavailable = assertProductionReady(config.nodeEnv, handlers, config.workerQueues);
if (unavailable.length > 0) {
  logger.warn({ unavailable }, 'stages not implemented yet: their jobs and intents stay pending');
}

// Stored question sets must match this code before any stage asks them (spec 05 §2).
await verifyQuestionSets(db).catch((error: unknown) => {
  logger.error({ err: error }, 'stored question sets do not match this worker (run pnpm db:seed)');
  throw error;
});

const boss = createBoss(config.databaseUrlWorker);
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
await boss.start();
const registration = await registerHandlers(boss, handlers, config.workerQueues, logger);
if (registration.consuming.includes('feed.schedule')) {
  // Every minute (spec 03 §3); pg-boss keeps one schedule row per queue across workers.
  await boss.schedule('feed.schedule', FEED_SCHEDULE_CRON, {}, { tz: 'UTC' });
}
const houseSchedules = Object.entries(HOUSE_CRON_SCHEDULES) as Array<
  [HouseCronQueue, HouseCronSchedule]
>;
for (const [queue, schedule] of houseSchedules) {
  if (registration.consuming.includes(queue)) {
    await boss.schedule(queue, schedule.cron, {}, { tz: 'UTC' });
  }
}
// Runs missed while no worker was up (spec 11 §6); the relay below delivers them.
const overdue = await enqueueOverdueHousekeeping(
  db,
  registration.consuming,
  settingsEnv,
  new Date(),
);
if (overdue.length > 0) logger.info({ overdue }, 'overdue housekeeping enqueued');
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
    await models.close();
    await Promise.all([pool.end(), lockPool.end()]);
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
