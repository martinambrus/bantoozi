import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OLD_MODEL,
  ClassifyHarness,
  pinRow,
  resetWorld,
  resolutionRow,
  setSetting,
  storeResolution,
} from './support/m8b-t5-world.js';
import {
  ALIAS,
  API_KEY,
  NOW,
  V113,
  V114,
  WatchMailer,
  addAdmin,
  clearAdmins,
  fakeTable,
  iso,
  okProbe,
  progressOf,
  rawSetting,
  realProber,
  runWatch,
  scriptedProber,
  watchRow,
} from './support/model-watch-world.js';

/** `house.model-watch` replaces a dormant resolution silently; only a resolution in force flips. */
const DORMANT_MODEL = 'jev-1.12.0';

let h: ClassifyHarness;
let fake: FakeTypeSafeServer;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  fake = await startFakeTypeSafe({ apiKey: API_KEY, models: fakeTable(V114) });
}, 240_000);

afterAll(async () => {
  await fake?.close();
  await h?.close();
});

beforeEach(async () => {
  await resetWorld(h, { model: V113 });
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    ['engine.model_watch', 'engine.rating_fingerprints', 'house.progress'],
  ]);
  await clearAdmins(h.owner);
  await addAdmin(h.owner, 'dormant-admin@example.test');
  await storeResolution(h.owner, DORMANT_MODEL);
  fake.setOptions({ apiKey: API_KEY, models: fakeTable(V114) });
});

describe('W1: the watch and a dormant resolution', () => {
  it('replaces a dormant row silently: no previous, no notice, no mail, no registered fingerprint', async () => {
    const registry = await rawSetting(h.owner, 'engine.rating_fingerprints');
    const mailer = new WatchMailer();
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer, now: NOW });
    expect(await resolutionRow(h.owner)).toEqual({
      alias: ALIAS,
      model: V114,
      resolvedAt: iso(NOW),
      checkedAt: iso(NOW),
    });
    const watch = await watchRow(h.owner);
    expect(watch.notice).toBeUndefined();
    expect(watch.lastCheck).toEqual({ at: iso(NOW), ok: true });
    expect(mailer.attempts).toBe(0);
    expect(await rawSetting(h.owner, 'engine.rating_fingerprints')).toEqual(registry);
    expect(await progressOf(h.owner)).toBeDefined();
  });

  it('control: with an alias-marked pin the row is in force and confirms before flipping with one mail', async () => {
    await setSetting(h.owner, 'engine.model_pin', {
      model: V113,
      alias: ALIAS,
      since: '2026-10-01T00:00:00.000Z',
    });
    const mailer = new WatchMailer();
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer, now: NOW });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: DORMANT_MODEL });
    expect(mailer.attempts).toBe(0);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    await runWatch(h, { prober: realProber(h, fake, later), mailer, now: later });
    expect(await resolutionRow(h.owner)).toMatchObject({
      model: V114,
      previous: { model: DORMANT_MODEL },
    });
    expect(mailer.attempts).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(await pinRow(h.owner)).toMatchObject({ model: V113 });
  });
});

describe('W2: the setting changes during the probe', () => {
  it('writes no resolution and no mail when the configured model is no longer the alias', async () => {
    await setSetting(h.owner, 'engine.model_pin', {
      model: V113,
      alias: ALIAS,
      since: '2026-10-01T00:00:00.000Z',
    });
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    let calls = 0;
    const mailer = new WatchMailer();
    await runWatch(h, {
      prober: scriptedProber(okProbe(V114)),
      mailer,
      now: NOW,
      configuredModel: async () => (calls++ === 0 ? ALIAS : OLD_MODEL),
    });
    expect(calls).toBe(2);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(mailer.attempts).toBe(0);
    expect((await watchRow(h.owner)).notice).toBeUndefined();
    expect(await progressOf(h.owner)).toBeDefined();
  });
});
