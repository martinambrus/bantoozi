import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { begin, registryOf } from './support/jev4-world.js';
import { resolutionRow, setSetting, storeResolution } from './support/m8b-t5-world.js';
import {
  ALIAS,
  API_KEY,
  STORED_AT,
  V113,
  V114,
  V115,
  WatchMailer,
  addAdmin,
  fakeTable,
  iso,
  rawSetting,
  realProber,
  runWatch,
  watchRow,
} from './support/model-watch-world.js';

// Keep the injected clock ahead of PostgreSQL: delayed intents clamp past dates to now.
const NOW = new Date(Date.now() + 86_400_000);
const GAP = 10 * 60_000;
let h: ClassifyHarness;
let fake: FakeTypeSafeServer;
let mailer: WatchMailer;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: fakeTable(V113) });
}, 240_000);
afterAll(async () => {
  await fake?.close();
  await h?.close();
});
beforeEach(async () => {
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    [
      'engine.model_resolution',
      'engine.model_watch',
      'engine.model_probe',
      'engine.model_impact',
      'engine.rating_fingerprints',
      'engine.circuit',
    ],
  ]);
  await begin(h, V113);
  await setSetting(h.owner, 'engine.model_pin', { model: V113, alias: ALIAS, since: STORED_AT });
  await storeResolution(h.owner, V113, STORED_AT);
  await h.clearOutbox();
  await h.owner.query(`DELETE FROM users WHERE role = 'admin'`);
  await addAdmin(h.owner, 'candidate-admin@example.test');
  mailer = new WatchMailer();
});

async function answer(model: string, elapsed = 0) {
  const at = new Date(NOW.getTime() + elapsed);
  fake.setOptions({ models: fakeTable(model) });
  return runWatch(h, { prober: realProber(h, fake, at), now: at, mailer });
}

afterEach(async () => {
  await h.owner.query('DROP TRIGGER IF EXISTS refuse_confirmation ON job_outbox');
  await h.owner.query('DROP FUNCTION IF EXISTS refuse_confirmation()');
});

const candidate = async () => (await watchRow(h.owner)).candidate;

describe('JEV-8: alias flap controls', () => {
  it.each([
    ['jev-1.14.0', 'jev-1.14.0-rc1'],
    ['jev-1.14.10', 'jev-1.14.9'],
    ['jev-1.14.0', 'jev-1.9.99'],
    ['jev-1.14.0-rc2', 'jev-1.14.0-rc1'],
    ['jev-1.9007199254740993.0', 'jev-1.9007199254740992.0'],
  ])('rejects lower same-major release %s → %s', async (current, older) => {
    await storeResolution(h.owner, current, STORED_AT);
    await answer(older);
    await answer(older, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: current });
    expect(await candidate()).toBeUndefined();
    expect(mailer.sent).toHaveLength(0);
  });

  it.each([
    ['jev-1.14.0-rc1', 'jev-1.14.0'],
    ['jev-1.9.0', 'jev-1.10.0'],
    ['jev-1.14.0+build5', 'jev-1.14.0+build6'],
    ['jev-2.0.0', V114],
  ])('confirms an eligible release %s → %s', async (current, next) => {
    await storeResolution(h.owner, current, STORED_AT);
    await answer(next);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: current });
    await answer(next, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: next });
    expect(mailer.sent).toHaveLength(1);
    if (current === 'jev-2.0.0') expect(mailer.sent[0]!.text).toContain('major change');
  });

  it('rolls back the candidate if its delayed intent cannot be written', async () => {
    await h.owner
      .query(`CREATE FUNCTION refuse_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'confirmation refused'; END $$`);
    await h.owner.query(`CREATE TRIGGER refuse_confirmation BEFORE INSERT ON job_outbox
      FOR EACH ROW WHEN (NEW.queue = 'house.model-watch') EXECUTE FUNCTION refuse_confirmation()`);
    await expect(answer(V114)).rejects.toMatchObject({
      cause: { message: 'confirmation refused' },
    });
    expect(await candidate()).toBeUndefined();
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    expect(await h.intents('house.model-watch', { pending: true })).toEqual([]);
  });

  it('an immediate pending check cannot absorb a delayed confirmation', async () => {
    const { enqueueModelWatchNow } = await import('../src/model-watch.js');
    await enqueueModelWatchNow(h.db);
    await answer(V114);
    const intents = await h.intents('house.model-watch', { pending: true });
    expect(intents).toHaveLength(2);
    expect(intents.at(-1)!.availableAt.getTime()).toBe(NOW.getTime() + GAP);
  });

  it('a failed probe keeps a candidate and later confirmation still adopts', async () => {
    await answer(V114);
    const before = await candidate();
    fake.setOptions({ failRate: 1, failStatus: 503 });
    await runWatch(h, { prober: realProber(h, fake, NOW), now: NOW, mailer });
    expect(await candidate()).toEqual(before);
    fake.setOptions({ failRate: 0 });
    await answer(V114, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
  });

  it('A → B once stores a candidate and one delayed confirmation without adoption or side effects', async () => {
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    await answer(V114);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(await candidate()).toEqual({ model: V114, firstSeenAt: iso(NOW), count: 1 });
    const intents = await h.intents('house.model-watch', { pending: true });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.availableAt.getTime()).toBe(NOW.getTime() + GAP);
    expect(mailer.sent).toHaveLength(0);
    expect(await registryOf(h)).toEqual({});
    expect(await h.intents('house.reenrich', { pending: true })).toEqual([]);
    expect(await h.intents('house.rematch', { pending: true })).toEqual([]);
  });

  it('A → B, early B, then B at 10 minutes adopts once and mails once', async () => {
    await answer(V114);
    await answer(V114, GAP - 1);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    expect(await candidate()).toMatchObject({ model: V114, firstSeenAt: iso(NOW), count: 2 });
    expect(await h.intents('house.model-watch', { pending: true })).toHaveLength(1);
    await answer(V114, GAP);
    const adopted = await resolutionRow(h.owner);
    expect(adopted).toMatchObject({
      model: V114,
      previous: { model: V113, until: iso(new Date(NOW.getTime() + GAP)) },
    });
    expect(await candidate()).toBeUndefined();
    expect(mailer.sent).toHaveLength(1);
    await answer(V114, GAP * 2);
    expect(await resolutionRow(h.owner)).toMatchObject({
      resolvedAt: adopted!.resolvedAt,
      previous: adopted!.previous,
    });
    expect(mailer.sent).toHaveLength(1);
  });

  it('A → B → A clears the candidate and never adopts', async () => {
    await answer(V114);
    await answer(V113, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113, resolvedAt: STORED_AT });
    expect(await candidate()).toBeUndefined();
    expect(mailer.sent).toHaveLength(0);
    expect(await registryOf(h)).toEqual({});
  });

  it('1.14 → 1.13 never rolls back, even after two agreeing probes', async () => {
    await storeResolution(h.owner, V114, STORED_AT);
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    await answer(V113);
    const rec = await answer(V113, GAP);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(await candidate()).toBeUndefined();
    expect(rec.logs.some((entry) => entry.level === 'warn')).toBe(true);
    expect(mailer.sent).toHaveLength(0);
  });

  it('A → B → C replaces the candidate and starts a new clock', async () => {
    await answer(V114);
    await answer(V115, GAP / 2);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    expect(await candidate()).toEqual({
      model: V115,
      firstSeenAt: iso(new Date(NOW.getTime() + GAP / 2)),
      count: 1,
    });
    await answer(V115, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    await answer(V115, GAP * 1.5);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V115 });
    expect(mailer.sent).toHaveLength(1);
  });
});
