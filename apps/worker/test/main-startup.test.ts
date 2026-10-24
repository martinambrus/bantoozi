import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Boss from '../src/boss.js';
import type * as EvalMode from '../src/eval-mode.js';

const h = vi.hoisted(() => ({
  queue: 'feed.schedule',
  ingestOnly: false,
  readinessFailure: false,
  pool: { on: vi.fn(), end: vi.fn(), query: vi.fn() },
  boss: { on: vi.fn(), start: vi.fn(), stop: vi.fn(), schedule: vi.fn() },
  heartbeat: { stop: vi.fn() },
  health: { close: vi.fn() },
  readiness: {
    stop: vi.fn(),
    reportMissing: vi.fn(),
    missing: () => ['house.alerts'],
    problems: () => [],
  },
  queueReadiness: vi.fn(),
  modelsClose: vi.fn(),
  cpuClose: vi.fn(),
  mailClose: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@bantoozi/db', () => ({
  PG_BOSS_CRON_QUEUE: '__pgboss__send-it',
  createDatabase: () => ({}),
  createPool: () => h.pool,
  createPgOriginLimiter: () => ({}),
}));
vi.mock('@bantoozi/shared/server', () => ({
  loadConfig: () => ({
    workerQueues: ['feed.schedule', 'feed.fetch', 'article.extract', 'user.estimate'],
    evalIngestOnly: h.ingestOnly,
    nodeEnv: 'test',
  }),
  createLogger: () => h.logger,
  createMailer: () => ({ close: h.mailClose }),
}));
vi.mock('../src/seed.js', () => ({ verifyQuestionSets: async () => {} }));
vi.mock('../src/readiness.js', () => ({
  startQueueReadiness: h.queueReadiness,
  assertProductionReady: () => [],
}));
vi.mock('../src/handlers/deps.js', () => ({ createWorkerDeps: () => ({}) }));
vi.mock('../src/handlers/index.js', () => ({ createHandlers: () => ({}) }));
vi.mock('../src/runtime.js', () => ({
  createWorkerRuntime: async () => ({
    models: { close: h.modelsClose },
    values: {},
    heartbeatRuntime: () => ({ problems: [] }),
  }),
}));
vi.mock('../src/cpu-pool.js', () => ({
  CpuPool: class {
    close = h.cpuClose;
  },
  cpuPoolSize: () => 1,
}));
vi.mock('../src/learn/trainer.js', () => ({ poolTrainer: () => ({}) }));
vi.mock('../src/estimate/trainer.js', () => ({ poolEstimateTrainer: () => ({}) }));
vi.mock('../src/learn/fingerprints.js', () => ({ guardedRegistration: async () => undefined }));
vi.mock('../src/alerts/probe.js', () => ({ createLibreTranslateProbe: () => undefined }));
vi.mock('../src/health-server.js', () => ({
  WORKER_POOL_LIMITS: { query: 10, feedLocks: 14 },
  startHealthServer: async () => h.health,
}));
vi.mock('../src/eval-mode.js', async (original) => ({
  ...(await original<typeof EvalMode>()),
  assertWorkerMode: async () => {},
  startHeartbeat: async () => h.heartbeat,
}));
vi.mock('../src/housekeeping.js', () => ({ enqueueOverdueHousekeeping: async () => [] }));
vi.mock('../src/outbox-relay.js', () => ({ startOutboxRelay: () => ({ stop: async () => {} }) }));
vi.mock('../src/boss.js', async (original) => ({
  ...(await original<typeof Boss>()),
  pgBossBroker: () => ({}),
  createBoss: () => h.boss,
  registerHandlers: async () => ({ consuming: [h.queue], unavailable: [] }),
}));

const initialExitCode = process.exitCode;
const originalTerm = new Set(process.listeners('SIGTERM'));
const originalInt = new Set(process.listeners('SIGINT'));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.ingestOnly = false;
  h.readinessFailure = false;
  h.boss.schedule.mockImplementation(async (queue: string) => {
    throw new Error(`Queue ${queue} not found`);
  });
  h.queueReadiness.mockImplementation(async () => {
    if (h.readinessFailure) throw new Error('readiness test stop');
    return h.readiness;
  });
});

afterEach(() => {
  for (const listener of process.listeners('SIGTERM')) {
    if (!originalTerm.has(listener)) process.removeListener('SIGTERM', listener);
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!originalInt.has(listener)) process.removeListener('SIGINT', listener);
  }
  process.exitCode = initialExitCode;
});

describe('worker startup failure cleanup', () => {
  it.each(['feed.schedule', 'house.alerts'])(
    'keeps running and reports missing queues when scheduling %s fails',
    async (queue) => {
      h.queue = queue;
      let failure: unknown;
      try {
        await import('../src/main.js');
      } catch (error) {
        failure = error;
      }
      expect(h.boss.schedule, String(failure)).toHaveBeenCalledWith(
        queue,
        expect.any(String),
        {},
        { tz: 'UTC' },
      );
      expect(h.boss.stop).not.toHaveBeenCalled();
      expect(h.heartbeat.stop).not.toHaveBeenCalled();
      expect(h.readiness.reportMissing).toHaveBeenCalledWith(queue);
      expect(process.exitCode).toBe(initialExitCode);
      const terminate = process
        .listeners('SIGTERM')
        .find((listener) => !originalTerm.has(listener));
      terminate?.('SIGTERM');
      await vi.waitFor(() => expect(h.modelsClose).toHaveBeenCalledOnce());
      expect(failure).toBeUndefined();
    },
  );
});

describe('ingest-only queue readiness', () => {
  it('compares only consumed queues plus the internal cron queue', async () => {
    h.ingestOnly = true;
    h.readinessFailure = true;
    await expect(import('../src/main.js')).rejects.toThrow('readiness test stop');
    expect(h.queueReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        queues: ['feed.schedule', 'feed.fetch', 'article.extract', '__pgboss__send-it'],
      }),
    );
  });
});
