import { hostname } from 'node:os';

import { createDatabase, createPgOriginLimiter, createPool } from '@bantoozi/db';
import {
  FEED_SCHEDULE_CRON,
  HOUSE_CRON_SCHEDULES,
  type HouseCronQueue,
  type HouseCronSchedule,
} from '@bantoozi/shared';
import { createLogger, createMailer, loadConfig } from '@bantoozi/shared/server';

import { createLibreTranslateProbe } from './alerts/probe.js';
import { createBoss, pgBossBroker, registerHandlers } from './boss.js';
import { createFileDeletionLedger } from './deletion-ledger.js';
import { WORKER_POOL_LIMITS, startHealthServer, type HealthServer } from './health-server.js';
import { createWorkerDeps } from './handlers/deps.js';
import {
  assertWorkerMode,
  effectiveWorkerQueues,
  startHeartbeat,
  type Heartbeat,
} from './eval-mode.js';
import { createHandlers } from './handlers/index.js';
import { enqueueOverdueHousekeeping } from './housekeeping.js';
import { startOutboxRelay } from './outbox-relay.js';
import { assertProductionReady } from './readiness.js';
import { createWorkerRuntime } from './runtime.js';
import { createShutdownGate } from './shutdown-gate.js';
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
  max: WORKER_POOL_LIMITS.query,
  applicationName: 'bantoozi-worker',
});
const db = createDatabase(pool);
// Feed fetch locks pin one connection each for a whole fetch (spec 03 §3): a pool of their own.
const lockPool = createPool({
  connectionString: config.databaseUrlWorker,
  max: WORKER_POOL_LIMITS.feedLocks,
  applicationName: 'bantoozi-worker-locks',
});
// An idle connection dropped by the server must not crash the process (pg emits 'error').
for (const p of [pool, lockPool]) {
  p.on('error', (err) => logger.warn({ err }, 'idle database connection error'));
}
await assertWorkerMode(db, config.evalIngestOnly);

await verifyQuestionSets(db).catch((error: unknown) => {
  logger.error({ err: error }, 'stored question sets do not match this worker (run pnpm db:seed)');
  throw error;
});

// The runtime builds the models from the effective settings and records the engine model pin under
// its row lock (a changed pin enqueues the model rebuild once); it checks restart-class changes.
const shutdownGate = createShutdownGate();
const runtime = await createWorkerRuntime({
  db,
  config,
  logger,
  exit: (code) => process.exit(typeof process.exitCode === 'number' ? process.exitCode : code),
  drain: () => shutdownGate.drain('settings-restart'),
  selfRestart: config.workerSelfRestart,
  recordPin: !config.evalIngestOnly,
});
const models = runtime.models;
const runtimeSettings = runtime.settings;
let settingsTimer: NodeJS.Timeout | undefined;
const settingsEnv = {
  prefilterMinCards: config.prefilterMinCards,
  dailyBudgetUsd: config.dailyBudgetUsd,
  languageModes: config.languageModes,
  signupMode: config.signupMode,
};
const mailer = createMailer({
  transport: config.mailTransport,
  from: config.mailFrom,
  smtpUrl: config.smtpUrl,
  logger,
});
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
    runtimeSettings,
    settingsEnv,
    limiter: createPgOriginLimiter(db),
    logger,
    classification: models.classification,
    mailer,
    adminEmails: config.adminEmails,
    libreTranslateProbe: createLibreTranslateProbe(runtime.values.libretranslateUrl),
    providerValidation: models.providerValidation,
    ...(config.evalIngestOnly ? { evalIngestOnly: true } : {}),
    ...(config.deletionLedgerPath !== undefined && config.deletionLedgerRecipient !== undefined
      ? {
          deletionLedger: createFileDeletionLedger({
            path: config.deletionLedgerPath,
            recipient: config.deletionLedgerRecipient,
          }),
        }
      : {}),
    ...(config.deletionHmacKey === undefined ? {} : { deletionHmacKey: config.deletionHmacKey }),
  }),
);
// EVAL_INGEST_ONLY (spec 10 §2.1): only fetching and extraction; a golden database refuses
// ordinary workers (D-96).
const workerQueues = effectiveWorkerQueues(config.workerQueues, config.evalIngestOnly);
const unavailable = assertProductionReady(config.nodeEnv, handlers, workerQueues);
if (unavailable.length > 0) {
  logger.warn({ unavailable }, 'stages not implemented yet: their jobs and intents stay pending');
}

// Stored question sets must match this code before any stage asks them (spec 05 §2).
let stopping = false;
let heartbeat: Heartbeat | undefined;
let boss: ReturnType<typeof createBoss> | undefined;
let relay: ReturnType<typeof startOutboxRelay> | undefined;
let health: HealthServer | undefined;
const processId = `${hostname()}:${process.pid}`;
let stopped: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  stopped ??= stop(signal);
  return stopped;
}
async function stop(signal: string): Promise<void> {
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  if (settingsTimer !== undefined) clearInterval(settingsTimer);
  try {
    // The heartbeat advertises these consumers (an ingest-only collection checks it), so it is
    // removed only after the relay and the queue consumers have stopped.
    await health?.close();
    await relay?.stop();
    await boss?.stop({ graceful: true, timeout: 20_000, wait: true });
    await heartbeat?.stop();
    await models.close();
    mailer.close();
    await Promise.all([pool.end(), lockPool.end()]);
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}
try {
  heartbeat = await startHeartbeat({
    db,
    processId,
    queues: workerQueues,
    evalIngestOnly: config.evalIngestOnly,
    envCredentials: [
      ...(config.typesafeApiKey ? (['typesafe'] as const) : []),
      ...(config.ollamaApiKey ? (['ollama'] as const) : []),
    ],
    logger,
    runtime: () => ({ ...runtime.heartbeatRuntime() }),
    poolStats: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }),
    onGoldenDatabase: (error) => {
      logger.error({ err: error }, 'stopping: the database became a golden evaluation database');
      process.exitCode = 1;
      void shutdown('golden-database');
    },
  });
} catch (error) {
  // The database turned golden between the startup check and the first beat (or the beat failed):
  // nothing consumes yet, so stop before serving it.
  logger.error({ err: error }, 'worker heartbeat could not start');
  process.exitCode = 1;
  await shutdown('heartbeat-start');
}

if (!stopping) {
  health = await startHealthServer({
    host: config.workerMetricsHost,
    port: config.workerMetricsPort,
    token: config.metricsToken,
    queues: workerQueues,
    readHeartbeatAt: async () => {
      const result = await pool.query<{ at: string | null }>(
        `SELECT value -> $1 ->> 'at' AS at FROM settings WHERE key = 'worker.heartbeat'`,
        [processId],
      );
      const at = result.rows[0]?.at;
      return at === null || at === undefined ? undefined : new Date(at);
    },
  });
  boss = createBoss(config.databaseUrlWorker);
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  const registration = await registerHandlers(boss, handlers, workerQueues, logger);
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
  relay = startOutboxRelay(db, pgBossBroker(boss), { handlers, logger });
  logger.info({ ...registration, evalIngestOnly: config.evalIngestOnly }, 'worker started');
}

shutdownGate.wire(shutdown);
// The runtime check may request a self-restart: start it only once the shutdown is wired.
if (!stopping) {
  settingsTimer = setInterval(() => {
    runtime.check().catch((error: unknown) => {
      logger.warn({ err: error }, 'runtime settings refresh failed');
    });
  }, 10_000);
  settingsTimer.unref();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
