import { writeSetting } from '@bantoozi/db';
import { EngineModelWatchSchema as OriginModelWatchSchema } from '../../../packages/shared/test/support/origin-model-watch.js';
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
  candidateRow,
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
      'engine.model_candidate',
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
  const current = (await resolutionRow(h.owner))?.model;
  fake.setOptions({ models: fakeTable(model, ...(current === undefined ? [] : [current])) });
  return runWatch(h, { prober: realProber(h, fake, at), now: at, mailer });
}

afterEach(async () => {
  await h.owner.query('DROP TRIGGER IF EXISTS refuse_confirmation ON job_outbox');
  await h.owner.query('DROP FUNCTION IF EXISTS refuse_confirmation()');
});

const candidate = async () => candidateRow(h.owner);

describe('JEV-8: alias flap controls', () => {
  it('keeps the watch row readable by the origin/main worker after observing a candidate', async () => {
    const triggeredAt = iso(NOW);
    const notice = { from: V113, to: V114, at: triggeredAt, major: false, attempts: 0 };
    await setSetting(h.owner, 'engine.model_watch', { triggeredAt, notice });
    const { observeModelCandidate } = await import('../src/model-watch.js');
    await observeModelCandidate(h.db, V114, NOW);
    const watch = await watchRow(h.owner);
    expect(OriginModelWatchSchema.parse(watch)).toMatchObject({ triggeredAt, notice });
    const { settingValue } = await import('./support/model-watch-world.js');
    expect(await settingValue(h.owner, 'engine.model_candidate')).toEqual({
      model: V114,
      firstSeenAt: iso(NOW),
      count: 1,
    });
  });

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

  it('confirms a lower release when the current concrete model is retired', async () => {
    await storeResolution(h.owner, V114, STORED_AT);
    fake.setOptions({ models: { [ALIAS]: V113, [V113]: V113 } });
    for (const elapsed of [0, GAP]) {
      const at = new Date(NOW.getTime() + elapsed);
      await runWatch(h, { prober: realProber(h, fake, at), now: at, mailer });
      expect(await resolutionRow(h.owner)).toMatchObject({ model: elapsed === 0 ? V114 : V113 });
      if (elapsed === 0) expect(await candidate()).toMatchObject({ model: V113 });
    }
    expect(mailer.sent).toHaveLength(1);
    expect(await candidate()).toBeUndefined();
  });

  it('keeps the never-lower rule when checking the current model fails transiently', async () => {
    await storeResolution(h.owner, V114, STORED_AT);
    const prober = {
      probe: async (requested: string) =>
        requested === ALIAS
          ? { requested, answered: V113, ok: true, at: iso(NOW) }
          : { requested, ok: false, at: iso(NOW), error: 'timeout' },
    };
    for (const elapsed of [0, GAP]) {
      await runWatch(h, { prober, now: new Date(NOW.getTime() + elapsed), mailer });
    }
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(await candidate()).toBeUndefined();
    expect(mailer.sent).toHaveLength(0);
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

  it('requestModelWatch preserves an existing candidate byte for byte', async () => {
    await answer(V114);
    const before = await rawSetting(h.owner, 'engine.model_candidate');
    const { requestModelWatch } = await import('../src/model-watch.js');
    expect(await requestModelWatch(h.db, NOW)).toBe(true);
    expect(await rawSetting(h.owner, 'engine.model_candidate')).toEqual(before);
    expect(await watchRow(h.owner)).toMatchObject({
      triggeredAt: iso(NOW),
      lastCheck: { at: iso(NOW), ok: true },
    });
    expect(await h.intents('house.model-watch', { pending: true })).toHaveLength(2);
  });

  it('retries an early confirmation with a distinct delayed intent', async () => {
    await answer(V114);
    await answer(V114, GAP - 1);
    const intents = await h.intents('house.model-watch', { pending: true });
    expect(intents).toHaveLength(2);
    expect(intents[1]!.availableAt.getTime()).toBeGreaterThan(NOW.getTime() + GAP - 1);
    await answer(V114, GAP + 60_000);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(await h.intents('house.model-watch', { pending: true })).toHaveLength(2);
  });

  it('retries failed confirmations at most three times and still permits later adoption', async () => {
    await answer(V114);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      fake.setOptions({ failRate: 1, failStatus: 503 });
      const at = new Date(NOW.getTime() + GAP + attempt * 60_000);
      await runWatch(h, { prober: realProber(h, fake, at), now: at, mailer });
      const intents = await h.intents('house.model-watch', { pending: true });
      expect(intents).toHaveLength(Math.min(1 + attempt, 4));
      expect(await candidate()).toMatchObject({ model: V114, firstSeenAt: iso(NOW) });
    }
    const revisions = await h.owner.query(`SELECT count(DISTINCT dedupe_key)::int AS n
      FROM job_outbox WHERE queue = 'house.model-watch' AND delivered_at IS NULL`);
    expect(revisions.rows[0].n).toBe(4);
    fake.setOptions({ failRate: 0 });
    await answer(V114, GAP * 2);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a failed probe keeps a candidate and later confirmation still adopts', async () => {
    await answer(V114);
    const before = await candidate();
    fake.setOptions({ failRate: 1, failStatus: 503 });
    await runWatch(h, { prober: realProber(h, fake, NOW), now: NOW, mailer });
    expect(await candidate()).toEqual({ ...before, count: 2 });
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
    expect(await h.intents('house.model-watch', { pending: true })).toHaveLength(2);
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

describe('candidate lifetime', () => {
  it.each([86_400_000, 86_400_001])(
    'candidate age %i respects the 24-hour boundary',
    async (age) => {
      await answer(V114);
      await answer(V114, age);
      if (age === 86_400_000) {
        expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
        expect(await candidate()).toBeUndefined();
      } else {
        expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
        expect(await candidate()).toEqual({
          model: V114,
          firstSeenAt: iso(new Date(NOW.getTime() + age)),
          count: 1,
        });
        expect(mailer.sent).toHaveLength(0);
        expect(await registryOf(h)).toEqual({});
        await answer(V114, age + GAP);
        expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
      }
    },
  );

  it('clears a candidate when a check sees a concrete setting', async () => {
    await answer(V114);
    await runWatch(h, { prober: realProber(h, fake, NOW), configured: V113, now: NOW, mailer });
    expect(await candidate()).toBeUndefined();
    await answer(V114, GAP);
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    expect(await candidate()).toMatchObject({ model: V114, count: 1 });
  });

  it('clears a candidate when the setting leaves the alias during a probe', async () => {
    await answer(V114);
    let reads = 0;
    await runWatch(h, {
      prober: realProber(h, fake, NOW),
      configuredModel: async () => (++reads === 1 ? ALIAS : V113),
      now: NOW,
      mailer,
    });
    expect(await candidate()).toBeUndefined();
  });
});

it('discards an expired candidate on a failed confirmation without scheduling another retry', async () => {
  await answer(V114);
  const before = await h.intents('house.model-watch', { pending: true });
  fake.setOptions({ failRate: 1, failStatus: 503 });
  const at = new Date(NOW.getTime() + 86_400_001);
  await runWatch(h, { prober: realProber(h, fake, at), now: at, mailer });
  expect(await candidate()).toBeUndefined();
  expect(await h.intents('house.model-watch', { pending: true })).toHaveLength(before.length);
});

it('discards a candidate when the setting is saved concrete and back between watch runs', async () => {
  fake.setOptions({ failRate: 0 });
  await answer(V114);
  expect(await candidate()).toMatchObject({ model: V114, count: 1 });
  await h.db.transaction(async (tx) => {
    await writeSetting(tx, { key: 'engine.typesafe_model', value: V113, updatedBy: null });
  });
  await h.db.transaction(async (tx) => {
    await writeSetting(tx, { key: 'engine.typesafe_model', value: ALIAS, updatedBy: null });
  });
  expect(await candidate()).toBeUndefined();
  await answer(V114, 30 * 60_000);
  expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
  expect(await candidate()).toMatchObject({
    model: V114,
    count: 1,
    firstSeenAt: iso(new Date(NOW.getTime() + 30 * 60_000)),
  });
  await answer(V114, 40 * 60_000);
  expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
});
