import {
  createDatabase,
  MIGRATIONS_FOLDER,
  PG_BOSS_VERSION,
  runMigrations,
  type Database,
} from '@bantoozi/db';
import {
  ENGINE_MODEL_PROBES_MAX,
  EngineModelProbesSchema,
  enqueueModelProbe,
  parseJobPayload,
  type EngineModelProbe,
  type JobIntent,
} from '@bantoozi/shared';
import type { CredentialResolver, Mailer } from '@bantoozi/shared/server';
import { dropCreatedTestDatabases, setupTestDatabase, type TestDatabase } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TranslationDeps } from '../src/classify/translation.js';
import { createWorkerDeps, type ClassificationDeps } from '../src/handlers/deps.js';
import {
  createHandlers,
  isStageAvailable,
  PROVIDER_QUEUES,
  type JobContext,
} from '../src/handlers/index.js';
import { createModelProbeHandler } from '../src/handlers/model-probe.js';
import type { createModelProber } from '../src/model-probe.js';

/**
 * JEV-1 (worker): the `engine.model-probe` handler probes the payload's model and records the result
 * in `settings['engine.model_probe']`, keyed by the requested id, newest 10 kept. A failing prober
 * is recorded as `internal_error` and never makes the job throw.
 */

type Prober = ReturnType<typeof createModelProber>;

let testDb: TestDatabase;
let owner: pg.Pool;
let workerPool: pg.Pool;
let db: Database;
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const context: JobContext = { queue: 'engine.model-probe', jobId: 'test' };

beforeAll(async () => {
  testDb = await setupTestDatabase({
    pkg: 'worker',
    migrationsDir: MIGRATIONS_FOLDER,
    pgBossVersion: PG_BOSS_VERSION,
    migrate: async (url) => {
      await runMigrations({ databaseUrl: url });
    },
  });
  owner = new pg.Pool({ connectionString: testDb.urls.owner, max: 2 });
  workerPool = new pg.Pool({ connectionString: testDb.urls.worker, max: 4 });
  db = createDatabase(workerPool);
}, 240_000);

afterAll(async () => {
  await Promise.all([owner?.end(), workerPool?.end()]);
  await dropCreatedTestDatabases();
});

beforeEach(async () => {
  await owner.query(
    `DELETE FROM settings WHERE key IN ('engine.model_probe', 'engine.model_impact')`,
  );
});

async function stored(): Promise<Record<string, EngineModelProbe>> {
  const { rows } = await owner.query<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'engine.model_probe'`,
  );
  const parsed = EngineModelProbesSchema.parse(rows[0]?.value);
  return parsed;
}

/** A prober that answers every id as itself (alias: jev-1.13.0) with a strictly rising `at`. */
function scriptedProber(options: { start?: number } = {}): Prober & { asked: string[] } {
  let tick = options.start ?? Date.UTC(2031, 0, 1);
  const asked: string[] = [];
  return {
    asked,
    probe: async (requested: string) => {
      asked.push(requested);
      tick += 60_000;
      return {
        requested,
        answered: requested === 'jev-latest' ? 'jev-1.13.0' : requested,
        ok: true,
        at: new Date(tick).toISOString(),
      };
    },
  } as Prober & { asked: string[] };
}

const run = (prober: Prober, model: string) =>
  createModelProbeHandler({ db, prober, logger })({ model }, context);

describe('engine.model-probe handler', () => {
  it('H1 records the result per requested id, replaces only its own key and keeps the newest 10', async () => {
    const prober = scriptedProber();
    await run(prober, 'jev-latest');
    const first = await stored();
    expect(Object.keys(first)).toEqual(['jev-latest']);
    expect(first['jev-latest']).toMatchObject({
      requested: 'jev-latest',
      answered: 'jev-1.13.0',
      ok: true,
    });
    expect(new Date(first['jev-latest']!.at).toISOString()).toBe(first['jev-latest']!.at);

    await run(prober, 'jev-1.13.0');
    const both = await stored();
    expect(Object.keys(both).sort()).toEqual(['jev-1.13.0', 'jev-latest']);
    expect(both['jev-latest']).toEqual(first['jev-latest']);

    // Probing the alias again replaces only its own key.
    await run(prober, 'jev-latest');
    const again = await stored();
    expect(Object.keys(again).sort()).toEqual(['jev-1.13.0', 'jev-latest']);
    expect(again['jev-1.13.0']).toEqual(both['jev-1.13.0']);
    expect(Date.parse(again['jev-latest']!.at)).toBeGreaterThan(
      Date.parse(first['jev-latest']!.at),
    );

    // Eleven distinct ids: the oldest result goes, the newest ten stay.
    await owner.query(
      `DELETE FROM settings WHERE key IN ('engine.model_probe', 'engine.model_impact')`,
    );
    const ids = Array.from({ length: ENGINE_MODEL_PROBES_MAX + 1 }, (_, i) => `jev-1.${i}.0`);
    const sequence = scriptedProber({ start: Date.UTC(2032, 0, 1) });
    for (const id of ids) await run(sequence, id);
    const kept = await stored();
    expect(Object.keys(kept).sort()).toEqual(ids.slice(1).sort());
    expect(kept[ids[0]!]).toBeUndefined();
    // Control: ten distinct ids lose nothing.
    await owner.query(
      `DELETE FROM settings WHERE key IN ('engine.model_probe', 'engine.model_impact')`,
    );
    const ten = scriptedProber({ start: Date.UTC(2033, 0, 1) });
    for (const id of ids.slice(0, ENGINE_MODEL_PROBES_MAX)) await run(ten, id);
    expect(Object.keys(await stored())).toHaveLength(ENGINE_MODEL_PROBES_MAX);
  });

  it('H1 a failed probe is recorded with its error and no answered id', async () => {
    const failing = {
      probe: async (requested: string) => ({
        requested,
        ok: false,
        at: new Date().toISOString(),
        error: 'model_unavailable',
      }),
    } as Prober;
    await run(failing, 'jev-1.99.0');
    const record = (await stored())['jev-1.99.0'];
    expect(record).toMatchObject({
      requested: 'jev-1.99.0',
      ok: false,
      error: 'model_unavailable',
    });
    expect(record).not.toHaveProperty('answered');
  });

  it('H2 a rejecting prober is recorded as internal_error and the handler resolves', async () => {
    const rejecting = {
      probe: async () => {
        throw new Error('boom');
      },
    } as unknown as Prober;
    await expect(run(rejecting, 'jev-latest')).resolves.toBeUndefined();
    const record = (await stored())['jev-latest'];
    expect(record).toMatchObject({ requested: 'jev-latest', ok: false, error: 'internal_error' });
    expect(Number.isNaN(Date.parse(record!.at))).toBe(false);

    // Control: a prober that works is recorded as ok by the same handler.
    await run(scriptedProber(), 'jev-latest');
    expect((await stored())['jev-latest']).toMatchObject({ ok: true });
  });
});

describe('engine.model-probe registration', () => {
  const baseDeps = {
    db: {} as Database,
    lockPool: {} as pg.Pool,
    fetch: { userAgent: 'test', timeoutMs: 1000, maxBytes: 1024, allowPrivate: false },
    ingestMaxAgeDays: 14,
    settingsEnv: { dailyBudgetUsd: 2, languageModes: {}, signupMode: 'invite' as const },
    limiter: {
      reserve: async () => ({ status: 'granted' as const, token: 't' }),
      release: async () => {},
      block: async () => {},
    },
    logger,
  };
  const classification: ClassificationDeps = {
    router: {} as ClassificationDeps['router'],
    primaryModel: 'jev-1.13.0',
    leaseMs: 600_000,
    callDeadlineMs: 300_000,
    jobBudgetMs: 600_000,
    translation: {} as TranslationDeps,
  };
  const providerValidation = {
    router: {} as ClassificationDeps['router'],
    credentials: {} as CredentialResolver,
    config: {
      nodeEnv: 'test' as const,
      typesafeBaseUrl: 'http://127.0.0.1:9',
      typesafeModel: 'jev-1.13.0',
      typesafePricePerMtokUsd: 0.042,
      ollamaBaseUrl: 'http://127.0.0.1:9',
      ollamaModelFast: 'fast',
      ollamaModelStrong: 'strong',
    },
  };

  it('H3 createHandlers implements the queue only with the provider dependencies', async () => {
    const without = createHandlers(createWorkerDeps({ ...baseDeps, classification }));
    expect(isStageAvailable(without, 'engine.model-probe')).toBe(false);

    const withDeps = createHandlers(
      createWorkerDeps({
        ...baseDeps,
        classification,
        mailer: {} as Mailer,
        providerValidation,
      }),
    );
    expect(isStageAvailable(withDeps, 'engine.model-probe')).toBe(true);
    expect(isStageAvailable(withDeps, 'provider.validate')).toBe(true);
    expect(PROVIDER_QUEUES).toContain('engine.model-probe');
    expect(PROVIDER_QUEUES).toContain('provider.validate');

    // The payload is strict and takes model ids only.
    expect(parseJobPayload('engine.model-probe', { model: 'jev-latest' })).toEqual({
      model: 'jev-latest',
    });
    expect(() => parseJobPayload('engine.model-probe', { model: 'jev-latest', x: 1 })).toThrow();
    expect(() => parseJobPayload('engine.model-probe', { model: 'a b' })).toThrow();
    expect(() => parseJobPayload('engine.model-probe', { model: '' })).toThrow();

    // One pending probe per model: the singleton key follows the model.
    const sent: JobIntent[] = [];
    const sender = { enqueue: async (intent: JobIntent) => void sent.push(intent) };
    await enqueueModelProbe(sender, { model: 'jev-latest' });
    await enqueueModelProbe(sender, { model: 'jev-1.13.0' });
    expect(sent.map((i) => i.send)).toEqual([
      { kind: 'send', singletonKey: 'model-probe:jev-latest' },
      { kind: 'send', singletonKey: 'model-probe:jev-1.13.0' },
    ]);
  });
});
