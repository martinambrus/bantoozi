import { canonicalSha256 } from '@bantoozi/shared/server';
import { parseSetting, parseStoredSetting, settingDefault } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { createPgEngineStore, markBudgetCrossings } from '../src/engine/store.js';
import { recordWorkerHeartbeat } from '../src/heartbeat.js';
import { closeOpenSetup, replaceSetupState } from '../src/api/setup.js';
import { writeSetting } from '../src/api/admin.js';
import { seedQuestionSets } from '../src/library/question-sets.js';
import { applyG1Settings } from '../src/eval/g1.js';
import { readStoredSetting, updateSettingLocked } from '../src/settings.js';
import { setupDbTest, type DbTestContext } from './support/test-db.js';

let ctx: DbTestContext;
const now = new Date('2026-10-24T12:00:00Z');
const env = { dailyBudgetUsd: 10, languageModes: {}, signupMode: 'invite' as const };
beforeAll(async () => {
  ctx = await setupDbTest();
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  await ctx.owner.query('DELETE FROM settings');
});
const put = (key: string, value: unknown) =>
  ctx.owner.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)', [
    key,
    JSON.stringify(value),
  ]);
const get = (key: string) => readStoredSetting(ctx.worker, key);

it('updates a breaker without losing future root, engine or reset-request fields; resets still remove known fields', async () => {
  const circuit = settingDefault('engine.circuit', env)!;
  await put('engine.circuit', {
    ...circuit,
    future: 1,
    typesafe: { ...circuit.typesafe, future: 2, openedAt: now.toISOString() },
    resetRequested: { future: 3 },
  });
  const store = createPgEngineStore(ctx.worker, { dailyBudgetUsd: 10 });
  expect((await store.readCircuit()).typesafe).toEqual({
    ...circuit.typesafe,
    openedAt: now.toISOString(),
  });
  await store.updateCircuit('typesafe', () => ({ state: 'open', reopenCount: 1 }));
  expect(await get('engine.circuit')).toEqual({
    ...circuit,
    future: 1,
    typesafe: { state: 'open', reopenCount: 1, future: 2 },
    resetRequested: { future: 3 },
  });
});

it('keeps future heartbeat fields on its own entry, nested pool and other workers', async () => {
  const entry = {
    at: now.toISOString(),
    queues: ['feed.fetch'],
    evalIngestOnly: false,
    envCredentials: [],
  };
  await put('worker.heartbeat', {
    own: { ...entry, future: 1, pool: { total: 1, idle: 1, waiting: 0, future: 2 } },
    other: { ...entry, future: 3 },
    stale: { ...entry, at: '2026-01-01T00:00:00Z' },
  });
  await recordWorkerHeartbeat(
    ctx.worker,
    'own',
    { ...entry, pool: { total: 2, idle: 0, waiting: 1 } },
    now,
  );
  expect(await get('worker.heartbeat')).toEqual({
    own: { ...entry, future: 1, pool: { total: 2, idle: 0, waiting: 1, future: 2 } },
    other: { ...entry, future: 3 },
  });
});

it('rotates and closes setup while preserving future keys and deleting the known token digest', async () => {
  const fresh = parseSetting('auth.setup', {
    digest: 'a'.repeat(64),
    createdAt: now.toISOString(),
  });
  await put('auth.setup', { ...fresh, future: 1 });
  await replaceSetupState(ctx.app, { ...fresh, digest: 'b'.repeat(64) });
  expect(await get('auth.setup')).toEqual({ ...fresh, digest: 'b'.repeat(64), future: 1 });
  await closeOpenSetup(ctx.app, '00000000-0000-4000-8000-000000000001');
  const closed = await get('auth.setup');
  expect(closed).toMatchObject({
    future: 1,
    createdAt: fresh.createdAt,
    userId: '00000000-0000-4000-8000-000000000001',
  });
  expect(parseStoredSetting('auth.setup', closed).digest).toBeUndefined();
});

it('preserves future active-set fields while seeding a newly active known kind', async () => {
  await put('question_sets.active', { future: 'new-kind' });
  const definition = { test: true };
  await ctx.worker.transaction((tx) =>
    seedQuestionSets(
      tx,
      [
        {
          kind: 'enrich',
          version: 'lenient-test',
          definition,
          sha256: canonicalSha256(definition),
        },
      ],
      { enrich: 'lenient-test' },
    ),
  );
  expect(await get('question_sets.active')).toMatchObject({
    future: 'new-kind',
    enrich: expect.any(String),
  });
});

it('preserves nested future fields through admin and G1 writes', async () => {
  await put('ranker.thresholds', { future: 1, model: { future: 2, historyDays: 90 } });
  await ctx.app.transaction((tx) =>
    writeSetting(tx, {
      key: 'ranker.thresholds',
      value: { model: { historyDays: 120 } },
      updatedBy: null,
    }),
  );
  expect(await get('ranker.thresholds')).toEqual({
    future: 1,
    model: { future: 2, historyDays: 120 },
  });
  await ctx.worker.transaction((tx) =>
    applyG1Settings(
      tx,
      {
        languageModes: {},
        cardTextMode: 'as_written',
        rankerThresholds: { model: { historyDays: 180 } },
        dailyBudgetUsd: 10,
        tier2DailyCap: 300,
      },
      { env, now },
    ),
  );
  expect(await get('ranker.thresholds')).toEqual({
    future: 1,
    model: { future: 2, historyDays: 180 },
  });
});

it('keeps future metrics fields using the typed snapshot shape rather than the open JSON registry', async () => {
  const window = { lanes: {}, regret: { numerator: 0, denominator: 0 } };
  const key = 'metrics.daily.2026-10-24';
  const current = { ...window, future: 1, windows: { d7: { ...window, future: 2 }, d30: window } };
  await put(key, current);
  await ctx.worker.transaction((tx) =>
    updateSettingLocked(tx, key, window, () => ({
      ...window,
      windows: { d7: window, d30: window },
    })),
  );
  expect(await get(key)).toEqual(current);
});

it('keeps future budget-alert fields while crossing thresholds in a new day', async () => {
  const day = '2035-10-24';
  await put('engine.budget_alerts', { day: '2035-10-23', p80At: now.toISOString(), future: 1 });
  await ctx.owner.query(
    `INSERT INTO engine_reservations (id, day, engine, kind, reserved_usd, status, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', $1, 'typesafe', 'enrich', 9, 'reserved', now() + interval '1 hour')`,
    [day],
  );
  await ctx.worker.transaction((tx) => markBudgetCrossings(tx, day, 10));
  const stored = await get('engine.budget_alerts');
  expect(stored).toMatchObject({ day, future: 1, p80At: expect.any(String) });
  expect((stored as { p80At: string }).p80At).not.toBe(now.toISOString());
});

it('keeps future fields in typed housekeeping cursors, including nested recovery positions', async () => {
  const job = 'house.rescore-degraded';
  const cursor = { enrich: { key: '2026-10-01T00:00:00Z', articleId: '1', future: 2 }, future: 1 };
  await put('house.progress', { [job]: { cursor, updatedAt: now.toISOString(), version: 1 } });
  await ctx.worker.transaction((tx) =>
    updateSettingLocked<Record<string, unknown>>(tx, 'house.progress', {}, () => ({
      [job]: {
        cursor: { enrich: { key: '2026-10-02T00:00:00Z', articleId: '2' } },
        updatedAt: now.toISOString(),
        version: 1,
      },
    })),
  );
  expect(await get('house.progress')).toMatchObject({
    [job]: {
      cursor: { enrich: { key: '2026-10-02T00:00:00Z', articleId: '2', future: 2 }, future: 1 },
    },
  });
});

it('switches housekeeping cursor variants without retaining known fields from the previous variant', async () => {
  const job = 'house.purge-users';
  const entry = { updatedAt: now.toISOString(), version: 1 };
  await put('house.progress', {
    [job]: { ...entry, cursor: { disabled: 'ledger_unconfigured', future: 1 } },
  });
  const cursor = { failed: { ledger: 1, db: 0, blocked: 0 }, at: now.toISOString() };
  await ctx.worker.transaction((tx) =>
    updateSettingLocked<Record<string, unknown>>(tx, 'house.progress', {}, () => ({
      [job]: { ...entry, cursor },
    })),
  );
  expect(await get('house.progress')).toEqual({
    [job]: { ...entry, cursor: { ...cursor, future: 1 } },
  });
});

it('preserves a future housekeeping job while this release updates a known job', async () => {
  const entry = { updatedAt: now.toISOString(), version: 1 };
  const future = { ...entry, future: true };
  await put('house.progress', { 'house.purge-auth': entry, 'house.future-job': future });
  await ctx.worker.transaction((tx) =>
    updateSettingLocked<Record<string, unknown>>(tx, 'house.progress', {}, (raw) => {
      const known = parseStoredSetting('house.progress', raw);
      return parseSetting('house.progress', {
        ...known,
        'house.purge-auth': { ...entry, version: 2 },
      });
    }),
  );
  expect(await get('house.progress')).toEqual({
    'house.purge-auth': { ...entry, version: 2 },
    'house.future-job': future,
  });
});

it('keeps the metrics size limit strict after restoring future fields', async () => {
  const window = { lanes: {}, regret: { numerator: 0, denominator: 0 } };
  const key = 'metrics.daily.2035-10-24';
  const old = { ...window, windows: { d7: window, d30: window }, future: 'x'.repeat(63 * 1024) };
  await put(key, old);
  const next = {
    ...window,
    lanes: { ['x'.repeat(2000)]: { likeRate: null, rated: 0 } },
    windows: { d7: window, d30: window },
  };
  await expect(
    ctx.worker.transaction((tx) => updateSettingLocked(tx, key, window, () => next)),
  ).rejects.toThrow('metrics snapshot too large');
  expect(await get(key)).toEqual(old);
});

it('preserves nested stored extensions through EngineStore.setSetting and rejects unknown input fields', async () => {
  const store = createPgEngineStore(ctx.worker, { dailyBudgetUsd: 10 });
  const stored = { model: { historyDays: 90, future: 2 }, future: 1 };
  await put('ranker.thresholds', stored);
  await store.setSetting('ranker.thresholds', { model: { historyDays: 120 } });
  expect(await get('ranker.thresholds')).toEqual({
    model: { historyDays: 120, future: 2 },
    future: 1,
  });
  await expect(
    store.setSetting('ranker.thresholds', { model: { historyDays: 130 }, injected: true }),
  ).rejects.toThrow();
  expect(await get('ranker.thresholds')).toEqual({
    model: { historyDays: 120, future: 2 },
    future: 1,
  });
});
