import { hostname } from 'node:os';

import {
  createDatabase,
  createPgOriginLimiter,
  createPool,
  createRuntimeSettingsCache,
  runtimeSettingsLoader,
  type RuntimeSettingsCache,
} from '@bantoozi/db';
import { OLLAMA_PRICE_TABLE } from '@bantoozi/engine';
import {
  FEED_SCHEDULE_CRON,
  HOUSE_CRON_SCHEDULES,
  type HouseCronQueue,
  type HouseCronSchedule,
} from '@bantoozi/shared';
import { createLogger, createMailer, loadConfig } from '@bantoozi/shared/server';

import { createLibreTranslateProbe } from './alerts/probe.js';
import { createBoss, pgBossBroker, registerHandlers } from './boss.js';
import { createWorkerModels } from './classification-deps.js';
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
import { recordModelPin } from './model-pin.js';
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
// Live runtime settings (M8b-T4): the engine reads the price from this mutable copy at each estimate.
const liveConfig: { -readonly [K in keyof typeof config]: (typeof config)[K] } = { ...config };
const models = createWorkerModels(db, liveConfig, logger);
const innerSettings = createRuntimeSettingsCache({
  load: runtimeSettingsLoader(db),
  env: {
    typesafeModel: config.typesafeModel,
    typesafeBaseUrl: config.typesafeBaseUrl,
    typesafePricePerMtokUsd: config.typesafePricePerMtokUsd,
    engineConcurrency: config.engineConcurrency,
    llmFallbackEnabled: config.llmFallbackEnabled,
    ollamaModelFast: config.ollamaModelFast,
    ollamaModelStrong: config.ollamaModelStrong,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaMaxConcurrency: config.ollamaMaxConcurrency,
    prefilterMinCards: config.prefilterMinCards,
    ingestMaxAgeDays: config.ingestMaxAgeDays,
    fetchTimeoutMs: config.fetchTimeoutMs,
    fetchMaxBytes: config.fetchMaxBytes,
    rateLimitsEnabled: config.rateLimitsEnabled,
    libretranslateUrl: config.libretranslateUrl,
  },
  context: {
    production: config.nodeEnv === 'production',
    providerHostAllowlist: config.providerHostAllowlist,
    ollamaPricedModels: Object.keys(OLLAMA_PRICE_TABLE),
  },
});
// On each refresh that produced a new snapshot, apply the engine values that need no restart.
let appliedSnapshot: Awaited<ReturnType<RuntimeSettingsCache['get']>> | undefined;
const runtimeSettings: RuntimeSettingsCache = {
  async get() {
    const snapshot = await innerSettings.get();
    if (snapshot !== appliedSnapshot) {
      appliedSnapshot = snapshot;
      liveConfig.typesafePricePerMtokUsd = snapshot.values.typesafePricePerMtokUsd;
      try {
        models.classification.router.reconfigure({
          concurrency: snapshot.values.engineConcurrency,
        });
      } catch (error) {
        logger.warn({ err: error }, 'engine concurrency setting could not be applied');
      }
    }
    return snapshot;
  },
  invalidate: () => innerSettings.invalidate(),
};
// Keep the engine values current while no job reads the settings.
const settingsTimer = setInterval(() => {
  void runtimeSettings.get().catch((error: unknown) => {
    logger.warn({ err: error }, 'runtime settings refresh failed');
  });
}, 10_000);
settingsTimer.unref();
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
    libreTranslateProbe: createLibreTranslateProbe(config.libretranslateUrl),
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
await assertWorkerMode(db, config.evalIngestOnly);

const unavailable = assertProductionReady(config.nodeEnv, handlers, workerQueues);
if (unavailable.length > 0) {
  logger.warn({ unavailable }, 'stages not implemented yet: their jobs and intents stay pending');
}

// Stored question sets must match this code before any stage asks them (spec 05 §2).
await verifyQuestionSets(db).catch((error: unknown) => {
  logger.error({ err: error }, 'stored question sets do not match this worker (run pnpm db:seed)');
  throw error;
});

// Record the engine model pin under its row lock; a changed pin enqueues the model rebuild once.
if (!config.evalIngestOnly) {
  const pin = await recordModelPin(
    db,
    {
      model: config.typesafeModel,
      ...(config.llmFallbackEnabled
        ? { llm: { fast: config.ollamaModelFast, strong: config.ollamaModelStrong } }
        : {}),
    },
    new Date(),
  );
  if (pin.changed) logger.info('engine model pin changed: re-enrichment and re-matching enqueued');
}

// The heartbeat starts before any consumer: it is written first and the golden-database check
// follows it, while `eval ingest-sample` creates the evaluation user first and checks heartbeats
// after it, so a worker and a collection that start together always see each other (D-96).
let stopping = false;
let heartbeat: Heartbeat | undefined;
let boss: ReturnType<typeof createBoss> | undefined;
let relay: ReturnType<typeof startOutboxRelay> | undefined;
let health: HealthServer | undefined;
const processId = `${hostname()}:${process.pid}`;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  clearInterval(settingsTimer);
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

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
