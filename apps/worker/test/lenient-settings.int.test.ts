import {
  readSweepCursors,
  recordHouseProgress,
  recordRebuildProgress,
  takePendingRuns,
} from '../src/handlers/house-purge-auth.js';
import { readStoredSetting } from '@bantoozi/db';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { recordModelPin } from '../src/model-pin.js';
import { recordModelProbe } from '../src/model-probe.js';
import { recordModelResolution } from '../src/model-resolution.js';
import {
  observeModelCandidate,
  requestModelWatch,
  writePendingNotice,
} from '../src/model-watch.js';
import { ClassifyHarness } from './support/classify.js';
import { setSetting } from './support/m8b-t5-world.js';

let h: ClassifyHarness;
const now = new Date(Date.now() + 60_000);
const at = now.toISOString();
beforeAll(async () => {
  h = await ClassifyHarness.start();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.owner.query('DELETE FROM settings');
});
const put = (key: string, value: unknown) => setSetting(h.owner, key, value);
const get = (key: string) => readStoredSetting(h.db, key);

it('keeps valid watch fields, future keys and notice extensions through every watch writer', async () => {
  const lastCheck = { at, ok: true, future: 2 };
  const notice = { from: 'jev-1.2.2', to: 'jev-1.2.3', at, major: false, attempts: 0, future: 3 };
  await put('engine.model_watch', { triggeredAt: 123, lastCheck, notice, future: 1 });
  expect(await requestModelWatch(h.db, now)).toBe(true);
  expect(await get('engine.model_watch')).toEqual({
    triggeredAt: at,
    lastCheck,
    notice,
    future: 1,
  });
  await h.db.transaction((tx) =>
    writePendingNotice(tx, { from: 'jev-1.2.3', to: 'jev-1.2.4' }, now),
  );
  expect(await get('engine.model_watch')).toMatchObject({
    future: 1,
    lastCheck,
    notice: { ...notice, to: 'jev-1.2.4' },
  });
  await put('engine.model_candidate', { model: 'jev-1.2.4', firstSeenAt: at, count: 1, future: 4 });
  await observeModelCandidate(h.db, 'jev-1.2.4', now);
  expect(await get('engine.model_candidate')).toMatchObject({
    model: 'jev-1.2.4',
    count: 2,
    future: 4,
  });
  expect(await get('engine.model_watch')).toMatchObject({
    future: 1,
    lastCheck,
    notice: { future: 3 },
  });
});

it('preserves future pin and resolution fields while updating known values', async () => {
  await put('engine.model_pin', {
    model: 'jev-1.2.3',
    since: at,
    llm: { fast: 'a', strong: 'b', future: 2 },
    future: 1,
  });
  await recordModelPin(h.db, { model: 'jev-1.2.3', llm: { fast: 'new', strong: 'b' } }, now);
  expect(await get('engine.model_pin')).toMatchObject({
    future: 1,
    llm: { fast: 'new', future: 2 },
  });
  const resolution = {
    alias: 'jev-latest',
    model: 'jev-1.2.3',
    resolvedAt: at,
    checkedAt: at,
    future: 1,
  };
  await put('engine.model_resolution', resolution);
  await recordModelResolution(h.db, {
    alias: 'jev-latest',
    model: 'jev-1.2.4',
    expectedModel: 'jev-1.2.3',
    now,
  });
  expect(await get('engine.model_resolution')).toMatchObject({
    model: 'jev-1.2.4',
    previous: { model: 'jev-1.2.3' },
    future: 1,
  });
});

it('keeps valid probe siblings when one entry is corrupt and preserves probe/impact extensions', async () => {
  const probe = { requested: 'jev-1.2.3', answered: 'jev-1.2.3', ok: true, at };
  await put('engine.model_probe', {
    'jev-1.2.3': { ...probe, future: 1 },
    'jev-1.2.2': { ok: 'invalid' },
  });
  await put('engine.model_impact', { at, activeModels: 0, future: 2 });
  await recordModelProbe(h.db, { ...probe, requested: 'jev-1.2.4', answered: 'jev-1.2.4' });
  expect(await get('engine.model_probe')).toEqual({
    'jev-1.2.3': { ...probe, future: 1 },
    'jev-1.2.4': { ...probe, requested: 'jev-1.2.4', answered: 'jev-1.2.4' },
  });
  expect(await get('engine.model_impact')).toMatchObject({ future: 2 });
});

it('keeps valid pending rebuild runs and their extensions through a write-back', async () => {
  const first = { since: at, future: 1 };
  const last = { future: 2 };
  await put('house.progress', {
    'house.reenrich': {
      updatedAt: at,
      version: 1,
      cursor: { pending: [first, { since: 42 }, last], future: 3 },
    },
  });
  await recordRebuildProgress(h.deps, 'house.reenrich', now, {
    complete: false,
    pending: { since: '2026-01-01T00:00:00Z' },
  });
  expect(await get('house.progress')).toMatchObject({
    'house.reenrich': {
      cursor: { pending: [first, last, { since: '2026-01-01T00:00:00Z' }], future: 3 },
    },
  });
  expect(await h.db.transaction((tx) => takePendingRuns(tx, 'house.reenrich', now))).toEqual([
    { since: at },
    {},
    { since: '2026-01-01T00:00:00Z' },
  ]);
});

it('drops only malformed sweep entries and retains valid positions through a write-back', async () => {
  await put('house.progress', {
    'house.purge-articles': {
      updatedAt: at,
      version: 1,
      cursor: { sweeps: { first: '1', broken: 42, last: '9' }, future: 1 },
    },
  });
  const sweeps = await readSweepCursors(h.deps, 'house.purge-articles');
  expect(sweeps).toEqual({ first: '1', last: '9' });
  await recordHouseProgress(h.deps, 'house.purge-articles', now, false, { sweeps });
  expect(await get('house.progress')).toMatchObject({
    'house.purge-articles': {
      cursor: { sweeps: { first: '1', last: '9' }, future: 1 },
    },
  });
});
