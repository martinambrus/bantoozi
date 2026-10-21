import { createDatabase, type Database } from '@bantoozi/db';
import type { EngineRequest, EngineRouter, Question } from '@bantoozi/engine';
import type { InferenceAuthorization } from '@bantoozi/shared';
import { createLogger } from '@bantoozi/shared/server';
import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerCredentialResolver } from '../src/credentials/index.js';
import { createModelProbeHandler } from '../src/handlers/model-probe.js';
import { createModelProber } from '../src/model-probe.js';
import { requestModelWatch } from '../src/model-watch.js';

import {
  NEW_MODEL,
  OLD_MODEL,
  ClassifyHarness,
  baseConfig,
  recorder,
  resetWorld,
  setSetting,
  startRuntime,
  storeResolution,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';

/**
 * JEV-3 (U2): the retired-model trigger of `house.model-watch`. When Bantoozi follows `jev-latest`
 * and Jev stops serving the pinned release, the failing classification call queues one
 * `house.model-watch` job, at most one per 10 minutes across all worker processes (T1, T2, T3);
 * nothing is queued for a concrete setting, other failures, probes or `recordPin: false` (T4).
 * Time is the injected `now`; there are no sleeps.
 */

const ALIAS = 'jev-latest';
const API_KEY = 'model-watch-trigger-key-0001';
const T0 = new Date('2026-10-21T10:00:00.000Z');
const MIN = 60_000;
const GAP = 10 * MIN;
const QUEUE = 'house.model-watch';
const WATCH_KEY = 'engine.model_watch';

/** The production-like table: the alias already follows 1.14.0 and 1.13.0 is retired. */
const RETIRED_TABLE = { [ALIAS]: NEW_MODEL, [NEW_MODEL]: NEW_MODEL };

const claim = (db: Database, now: Date, options?: { minGapMs?: number }) =>
  requestModelWatch(db, now, options);

let h: ClassifyHarness;
let fake: FakeTypeSafeServer;
const runtimes: WorkerRuntimeLike[] = [];
const extraPools: pg.Pool[] = [];

beforeAll(async () => {
  h = await ClassifyHarness.start();
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: RETIRED_TABLE });
}, 240_000);

afterAll(async () => {
  await fake?.close();
  await Promise.all(extraPools.map((pool) => pool.end().catch(() => undefined)));
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h);
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    [WATCH_KEY, 'engine.circuit', 'engine.typesafe_model'],
  ]);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query('DELETE FROM engine_reservations');
  fake.setOptions({
    apiKey: API_KEY,
    models: RETIRED_TABLE,
    failRate: 0,
    failStatus: undefined,
    statusOverride: undefined,
  });
  fake.requests.splice(0);
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
});

interface WatchRow {
  queue: string;
  payload: unknown;
  dedupe_key: string | null;
  delivered_at: Date | null;
}
async function watchRows(): Promise<WatchRow[]> {
  const { rows } = await h.owner.query<WatchRow>(
    `SELECT queue, payload, dedupe_key, delivered_at FROM job_outbox WHERE queue = $1 ORDER BY id`,
    [QUEUE],
  );
  return rows;
}
async function watchSetting(): Promise<Record<string, unknown> | undefined> {
  const { rows } = await h.owner.query<{ value: Record<string, unknown> }>(
    `SELECT value FROM settings WHERE key = $1`,
    [WATCH_KEY],
  );
  return rows[0]?.value;
}
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const clearWatch = async () => {
  await h.owner.query('DELETE FROM job_outbox WHERE queue = $1', [QUEUE]);
  await h.owner.query('DELETE FROM settings WHERE key = $1', [WATCH_KEY]);
};

describe('T1: requestModelWatch claims one check per gap', () => {
  it('T1a the first call queues one pending job; later calls inside the gap queue nothing', async () => {
    expect(await claim(h.db, T0)).toBe(true);
    let rows = await watchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: QUEUE, payload: {}, delivered_at: null });
    expect(rows[0]!.dedupe_key).not.toBeNull();
    expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());

    expect(await claim(h.db, at(MIN))).toBe(false);
    rows = await watchRows();
    expect(rows).toHaveLength(1);
    expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());

    expect(await claim(h.db, at(GAP - 1))).toBe(false);
    expect(await watchRows()).toHaveLength(1);
    expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());
  });

  it('T1b exactly the gap later passes: a second row with another dedupe key, triggeredAt moved', async () => {
    expect(await claim(h.db, T0)).toBe(true);
    expect(await claim(h.db, at(GAP - 1))).toBe(false);
    expect(await claim(h.db, at(GAP))).toBe(true);
    const rows = await watchRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dedupe_key).not.toBe(rows[1]!.dedupe_key);
    expect(rows.every((r) => r.queue === QUEUE && r.delivered_at === null)).toBe(true);
    expect((await watchSetting())?.['triggeredAt']).toBe(at(GAP).toISOString());
  });

  it('T1c the minGapMs option replaces the default gap', async () => {
    expect(await claim(h.db, T0, { minGapMs: 2 * MIN })).toBe(true);
    expect(await claim(h.db, at(2 * MIN - 1), { minGapMs: 2 * MIN })).toBe(false);
    expect(await claim(h.db, at(2 * MIN), { minGapMs: 2 * MIN })).toBe(true);
    expect(await watchRows()).toHaveLength(2);
    // Control: the default gap would still have refused the second minute.
    await clearWatch();
    expect(await claim(h.db, T0)).toBe(true);
    expect(await claim(h.db, at(2 * MIN))).toBe(false);
    expect(await watchRows()).toHaveLength(1);
  });

  it('T1d a claim keeps a stored lastCheck and notice', async () => {
    const stored = {
      triggeredAt: new Date(T0.getTime() - 3 * GAP).toISOString(),
      lastCheck: { at: at(-2 * GAP).toISOString(), ok: false, error: 'timeout' },
      notice: {
        from: OLD_MODEL,
        to: NEW_MODEL,
        at: at(-2 * GAP).toISOString(),
        major: false,
        attempts: 2,
      },
    };
    await setSetting(h.owner, WATCH_KEY, stored);
    expect(await claim(h.db, T0)).toBe(true);
    expect(await watchSetting()).toEqual({ ...stored, triggeredAt: T0.toISOString() });
    expect(await watchRows()).toHaveLength(1);
  });

  it('T1e a triggeredAt in the future refuses and writes nothing', async () => {
    const future = { triggeredAt: at(5 * MIN).toISOString() };
    await setSetting(h.owner, WATCH_KEY, future);
    expect(await claim(h.db, T0)).toBe(false);
    expect(await watchSetting()).toEqual(future);
    expect(await watchRows()).toHaveLength(0);
  });

  it('T1f a stored row without triggeredAt (only lastCheck) is claimable', async () => {
    const stored = { lastCheck: { at: at(-MIN).toISOString(), ok: true } };
    await setSetting(h.owner, WATCH_KEY, stored);
    expect(await claim(h.db, T0)).toBe(true);
    expect(await watchSetting()).toEqual({ ...stored, triggeredAt: T0.toISOString() });
  });
});

describe('T2: concurrent callers', () => {
  it('T2a eight simultaneous callers: exactly one true and one row, on a fresh state each round', async () => {
    for (let round = 0; round < 3; round += 1) {
      await clearWatch();
      const results = await Promise.all(Array.from({ length: 8 }, () => claim(h.db, T0)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await watchRows()).toHaveLength(1);
      expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());
    }
  });

  it('T2b with a stored row older than the gap the race is still won once', async () => {
    await setSetting(h.owner, WATCH_KEY, { triggeredAt: at(-GAP).toISOString() });
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(h.db, T0)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await watchRows()).toHaveLength(1);
  });

  it('T2c two independent Database handles (two processes) win exactly once together', async () => {
    const poolA = new pg.Pool({ connectionString: h.testDb.urls.worker, max: 4 });
    const poolB = new pg.Pool({ connectionString: h.testDb.urls.worker, max: 4 });
    extraPools.push(poolA, poolB);
    const dbA = createDatabase(poolA);
    const dbB = createDatabase(poolB);
    for (let round = 0; round < 3; round += 1) {
      await clearWatch();
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => claim(dbA, T0)),
        ...Array.from({ length: 4 }, () => claim(dbB, T0)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await watchRows()).toHaveLength(1);
    }
    // After the gap the two handles again win once together.
    const later = await Promise.all([claim(dbA, at(GAP)), claim(dbB, at(GAP))]);
    expect(later.filter(Boolean)).toHaveLength(1);
    expect(await watchRows()).toHaveLength(2);
  });
});

// ── The runtime worlds (T3, T4) ───────────────────────────────────────────────────────────────

const clock = () => {
  const state = { t: T0.getTime() };
  return { now: () => new Date(state.t), advance: (ms: number) => void (state.t += ms) };
};

interface World {
  runtime: WorkerRuntimeLike;
  router: EngineRouter;
  clock: ReturnType<typeof clock>;
}

/** A started worker runtime against the fake server; `alias` follows `jev-latest`, else a concrete id. */
async function world(
  options: {
    alias?: boolean;
    table?: Record<string, string>;
    recordPin?: boolean;
  } = {},
): Promise<World> {
  const { alias = true, table = RETIRED_TABLE, recordPin } = options;
  fake.setOptions({ models: table });
  if (alias) {
    await setSetting(h.owner, 'engine.typesafe_model', ALIAS);
    await storeResolution(h.owner, OLD_MODEL);
  }
  const c = clock();
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('test', { typesafeBaseUrl: fake.url, typesafeApiKey: API_KEY }),
    recorder: recorder(),
    now: c.now,
    ...(recordPin === undefined ? {} : { recordPin }),
  });
  runtimes.push(runtime);
  // The runtime's own check at start (alias with a stored resolution) is not under test here.
  await h.owner.query('DELETE FROM job_outbox WHERE queue = $1', [QUEUE]);
  return { runtime, router: runtime.models.classification.router as EngineRouter, clock: c };
}

/** An extracted article with a live reader, as an engine request with its authorization. */
async function articleRequest(): Promise<EngineRequest> {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  const articleId = await h.article({ feedIds: [feedId] });
  const revision = (await h.articleRow(articleId)).revision;
  const authorization: InferenceAuthorization = {
    type: 'article',
    articleId,
    articleRevision: revision,
    witnesses: [{ kind: 'automatic', userId, feedId, inferenceVersion: '1' }],
  };
  const questions: Record<string, Question> = {
    topic: {
      type: 'choice',
      instructions: 'Main topic',
      criteria: { energy: 'Energy and power grids', sport: 'Sport' },
    },
  };
  return {
    kind: 'enrich',
    state: { article: { title: 'Grid storage report', excerpt: 'Batteries and solar farms.' } },
    questions,
    questionSetSha: 'a'.repeat(64),
    stateSha256: 'b'.repeat(64),
    articleId,
    articleRevision: revision,
    priority: 'bulk',
    authorization,
  };
}

async function failedCalls(
  kind?: string,
): Promise<{ kind: string; status: string; error: string | null }[]> {
  const { rows } = await h.owner.query<{ kind: string; status: string; error: string | null }>(
    `SELECT kind, status, error FROM engine_calls
      WHERE status <> 'ok' AND ($1::text IS NULL OR kind = $1) ORDER BY id`,
    [kind ?? null],
  );
  return rows;
}

async function askFails(w: World): Promise<string | null> {
  const outcome = await w.router.ask(await articleRequest());
  expect(outcome.ok).toBe(false);
  const rows = await failedCalls('enrich');
  expect(rows.length).toBeGreaterThanOrEqual(1);
  return rows[rows.length - 1]!.error;
}

describe('T3: the hook end to end (alias world, retired pin)', () => {
  it('T3a the failing enrich call queues one watch; a second one a minute later queues none; after the gap a second row', async () => {
    const w = await world();
    expect(w.runtime.modelState).toMatchObject({ kind: 'resolved', model: OLD_MODEL });

    const error = await askFails(w);
    expect(error).toMatch(/^model_unavailable/);
    expect(await watchRows()).toHaveLength(1);
    expect((await watchRows())[0]).toMatchObject({ queue: QUEUE, payload: {} });
    expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());

    w.clock.advance(MIN);
    expect(await askFails(w)).toMatch(/^model_unavailable/);
    expect(await watchRows()).toHaveLength(1);
    expect((await watchSetting())?.['triggeredAt']).toBe(T0.toISOString());

    w.clock.advance(GAP);
    expect(await askFails(w)).toMatch(/^model_unavailable/);
    const rows = await watchRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dedupe_key).not.toBe(rows[1]!.dedupe_key);
    expect((await watchSetting())?.['triggeredAt']).toBe(at(MIN + GAP).toISOString());
  });

  it('T3c the call result is the same failed outcome, whether or not the claim wins', async () => {
    const w = await world();
    const first = await w.router.ask(await articleRequest());
    const second = await w.router.ask(await articleRequest());
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(await watchRows()).toHaveLength(1);
    expect(second).toMatchObject({ ok: false });
  });
});

describe('T4: negative controls (pass before and after the implementation)', () => {
  it('T4a a concrete setting: model_unavailable, no row, no engine.model_watch', async () => {
    const w = await world({ alias: false, table: { [NEW_MODEL]: NEW_MODEL } });
    expect(w.runtime.modelState).toEqual({ kind: 'concrete', model: OLD_MODEL });
    const error = await askFails(w);
    console.log(`T4a engine_calls.error = ${JSON.stringify(error)}`);
    expect(error).toMatch(/^model_unavailable/);
    expect(await watchRows()).toHaveLength(0);
    expect(await watchSetting()).toBeUndefined();
  });

  it('T4b a provider outage (503) fails with another error and queues nothing', async () => {
    const w = await world();
    fake.setOptions({ failRate: 1, failStatus: 503 });
    const error = await askFails(w);
    console.log(`T4b engine_calls.error = ${JSON.stringify(error)}`);
    expect(error).not.toMatch(/model_unavailable/);
    expect(fake.requests.length).toBeGreaterThanOrEqual(1);
    expect(await watchRows()).toHaveLength(0);
    expect(await watchSetting()).toBeUndefined();
  }, 120_000);

  it('T4c a model_mismatch (the server answers another release) queues nothing', async () => {
    const w = await world({ table: { [OLD_MODEL]: 'jev-1.12.0' } });
    const error = await askFails(w);
    console.log(`T4c engine_calls.error = ${JSON.stringify(error)}`);
    expect(error).toMatch(/model_mismatch/);
    expect(error).not.toMatch(/model_unavailable/);
    expect(await watchRows()).toHaveLength(0);
    expect(await watchSetting()).toBeUndefined();
  });

  it('T4d a probe of an unknown id (real prober, and the engine.model-probe handler) queues nothing', async () => {
    const w = await world();
    const logger = createLogger({ name: 'model-watch-trigger', level: 'silent' });
    const credentials = createWorkerCredentialResolver({
      db: h.db,
      masterKeyId: undefined,
      masterKeys: undefined,
      envKeys: { typesafe: API_KEY },
      logger,
      metadataTtlMs: 0,
    });
    // The prober records through the very router that carries the hook.
    const prober = createModelProber({
      ledger: w.router,
      credentials,
      config: { nodeEnv: 'test', typesafeBaseUrl: fake.url, typesafePricePerMtokUsd: 0.042 },
      logger,
      now: w.clock.now,
    });
    const probe = await prober.probe('jev-1.99.0');
    expect(probe).toMatchObject({ requested: 'jev-1.99.0', ok: false, error: 'model_unavailable' });

    await createModelProbeHandler({ db: h.db, prober, logger })(
      { model: 'jev-1.98.0' },
      { queue: 'engine.model-probe', jobId: 'model-watch-trigger-t4d' },
    );
    const stored = await h.owner.query<{ value: Record<string, { ok: boolean; error?: string }> }>(
      `SELECT value FROM settings WHERE key = 'engine.model_probe'`,
    );
    expect(stored.rows[0]?.value['jev-1.98.0']).toMatchObject({
      ok: false,
      error: 'model_unavailable',
    });

    const probeCalls = await failedCalls('model_probe');
    console.log(`T4d model_probe engine_calls = ${JSON.stringify(probeCalls)}`);
    expect(probeCalls.length).toBeGreaterThanOrEqual(2);
    expect(probeCalls.every((c) => /model_unavailable/.test(c.error ?? ''))).toBe(true);
    expect(await watchRows()).toHaveLength(0);
    expect(await watchSetting()).toBeUndefined();
  });

  it('T4e recordPin false: model_unavailable, no row', async () => {
    const w = await world({ recordPin: false });
    expect(w.runtime.modelState).toMatchObject({ kind: 'resolved', model: OLD_MODEL });
    const error = await askFails(w);
    expect(error).toMatch(/^model_unavailable/);
    expect(await watchRows()).toHaveLength(0);
    expect(await watchSetting()).toBeUndefined();
  });
});
