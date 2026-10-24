import { MODEL_NOTICE_MAX_ATTEMPTS } from '@bantoozi/shared';
import { activeAdminEmails } from '@bantoozi/db';
import { startFakeTypeSafe, type FakeTypeSafeServer } from '@bantoozi/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { recorder } from './support/m8b-t5-world.js';
import {
  ALIAS,
  API_KEY,
  LATER,
  NOW,
  STORED_AT,
  V113,
  V114,
  V115,
  V2,
  WatchMailer,
  addAdmin,
  addressesOf,
  clearAdmins,
  failedProbe,
  fakeTable,
  iso,
  majorMail,
  okProbe,
  probeOf,
  progressOf,
  rawSetting,
  realProber,
  runWatch,
  sameMajorMail,
  scriptedProber,
  settingValue,
  watchRow,
  type WatchRow,
} from './support/model-watch-world.js';
import { pinRow, resolutionRow, setSetting, storeResolution } from './support/m8b-t5-world.js';
import {
  begin,
  dropRegistry,
  effectiveSettingsOf,
  exactShaOf,
  familyShaOracle,
  registryOf,
  registryStamp,
} from './support/jev4-world.js';

/**
 * JEV-3 U1 (`house.model-watch`, W1..W7). The clock is the injected `NOW`; mail goes to a recording
 * mailer; the real prober runs against the fake TypeSafe server for W1, W2 and W3b, a scripted
 * prober elsewhere.
 */

const STORED_AT_DATE = new Date(STORED_AT);
const ADMIN_A = 'watch-admin-a@example.test';
const ADMIN_B = 'watch-admin-b@example.test';

let h: ClassifyHarness;
let fake: FakeTypeSafeServer;

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
      'house.progress',
      'engine.rating_fingerprints',
      'engine.circuit',
      'engine.daily_budget_usd',
    ],
  ]);
  await h.owner.query('DELETE FROM engine_calls');
  await h.owner.query('DELETE FROM engine_reservations');
  await h.owner.query('DELETE FROM usage_daily');
  await clearAdmins(h.owner);
  fake.setOptions({
    apiKey: API_KEY,
    models: fakeTable(V113),
    failRate: 0,
    failStatus: undefined,
    statusOverride: undefined,
  });
  fake.requests.splice(0);
  await begin(h, V113);
  // An instance that follows the alias: its workers pinned the model with the alias marked.
  await setSetting(h.owner, 'engine.model_pin', {
    model: V113,
    alias: ALIAS,
    since: new Date().toISOString(),
  });
  await storeResolution(h.owner, V113, STORED_AT);
  await h.clearOutbox();
});

afterEach(async () => {
  await h.owner.query(`DROP TRIGGER IF EXISTS refuse_registry ON settings`);
  await h.owner.query(`DROP FUNCTION IF EXISTS refuse_registry()`);
});

const flipTo = (latest: string) => fake.setOptions({ models: fakeTable(latest) });

/** Two active admins, in address order. */
async function twoAdmins(): Promise<void> {
  await addAdmin(h.owner, ADMIN_A);
  await addAdmin(h.owner, ADMIN_B);
}

/** Adoption-specific controls start with a prior observation; lifecycle probes live in the candidate suite. */
async function confirmNext(model: string, at: Date = NOW): Promise<void> {
  await setSetting(h.owner, 'engine.model_candidate', {
    model,
    firstSeenAt: iso(new Date(at.getTime() - 10 * 60_000)),
    count: 1,
  });
}

const noticeOf = async () => (await watchRow(h.owner)).notice;

describe('fixtures (sanity: these pass without the implementation)', () => {
  it('the fake table flips jev-latest and every release answers itself, seen by the real prober', async () => {
    const prober = realProber(h, fake, NOW);
    expect(await prober.probe(ALIAS)).toMatchObject({ ok: true, answered: V113 });
    for (const [latest, expected] of [
      [V114, V114],
      [V2, V2],
      [V115, V115],
    ] as const) {
      flipTo(latest);
      expect(await prober.probe(ALIAS)).toMatchObject({
        requested: ALIAS,
        ok: true,
        answered: expected,
      });
      expect(await prober.probe(latest)).toMatchObject({ ok: true, answered: latest });
      expect(await prober.probe(V113)).toMatchObject({ ok: true, answered: V113 });
    }
  });

  it('a failing fake makes the real prober fail without throwing', async () => {
    fake.setOptions({ failRate: 1, failStatus: 503 });
    expect(await realProber(h, fake, NOW).probe(ALIAS)).toMatchObject({
      ok: false,
      error: 'provider_unavailable',
    });
  });

  it('the recording mailer accepts, refuses by address and by switch, and lists recipients', async () => {
    const mailer = new WatchMailer();
    await mailer.send({ to: ADMIN_A, subject: 's', text: 't' });
    mailer.rejecting.add(ADMIN_B);
    await expect(mailer.send({ to: ADMIN_B, subject: 's', text: 't' })).rejects.toThrow();
    mailer.failing = true;
    await expect(mailer.send({ to: ADMIN_A, subject: 's', text: 't' })).rejects.toThrow();
    expect(mailer.attempts).toBe(3);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.to(ADMIN_A)).toHaveLength(1);
    expect(mailer.to(ADMIN_B)).toHaveLength(0);
    expect(addressesOf({ to: `${ADMIN_A}, ${ADMIN_B}`, subject: '', text: '' })).toEqual([
      ADMIN_A,
      ADMIN_B,
    ]);
  });

  it('the admin fixtures are what the handler will read', async () => {
    await twoAdmins();
    expect(await activeAdminEmails(h.db)).toEqual([ADMIN_A, ADMIN_B]);
    await clearAdmins(h.owner);
    expect(await activeAdminEmails(h.db)).toEqual([]);
  });

  it('ensureFingerprintRegistered registers the stored pin whatever primaryModel it is given', async () => {
    const { ensureFingerprintRegistered } = await import('../src/learn/fingerprints.js');
    await dropRegistry(h);
    const exact = await exactShaOf(h);
    await ensureFingerprintRegistered(
      h.db,
      { settingsEnv: h.settingsEnv, primaryModel: V114 },
      NOW,
    );
    expect(Object.keys(await registryOf(h))).toEqual([exact]);
  });

  it('the start state: pin and resolution at 1.13.0, an empty registry, no watch row', async () => {
    expect(await pinRow(h.owner)).toMatchObject({ model: V113 });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113, resolvedAt: STORED_AT });
    expect(await registryOf(h)).toEqual({});
    expect(await watchRow(h.owner)).toEqual({});
    expect(await progressOf(h.owner)).toBeUndefined();
  });
});

describe('W1: a same-major flip on the fake server', () => {
  it('adopts 1.14.0 with previous, records the probe, mails each admin once, leaves no notice; a second run changes only checkedAt', async () => {
    await confirmNext(V114);
    await twoAdmins();
    flipTo(V114);
    const mailer = new WatchMailer();
    const pinBefore = await pinRow(h.owner);

    await runWatch(h, { prober: realProber(h, fake, NOW), mailer });

    expect(await resolutionRow(h.owner)).toEqual({
      alias: ALIAS,
      model: V114,
      resolvedAt: iso(NOW),
      checkedAt: iso(NOW),
      previous: { model: V113, until: iso(NOW) },
    });
    expect(await probeOf(h.owner)).toMatchObject({
      requested: ALIAS,
      answered: V114,
      ok: true,
      at: iso(NOW),
    });
    // The watch never touches the pin: that is the restarted worker's job.
    expect(await pinRow(h.owner)).toEqual(pinBefore);

    const oracle = sameMajorMail(V113, V114);
    expect(mailer.sent).toHaveLength(2);
    for (const address of [ADMIN_A, ADMIN_B]) {
      const mails = mailer.to(address);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toContain(oracle.subject);
      expect(mails[0]!.text).toContain(oracle.sentence);
    }
    expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(NOW), ok: true } });
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW), completedAt: iso(NOW) });

    // A second run without a flip: the probe answers the same release.
    await runWatch(h, { prober: realProber(h, fake, LATER), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(2);
    expect(await resolutionRow(h.owner)).toEqual({
      alias: ALIAS,
      model: V114,
      resolvedAt: iso(NOW),
      checkedAt: iso(LATER),
      previous: { model: V113, until: iso(NOW) },
    });
    expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(LATER), ok: true } });
    expect(await progressOf(h.owner)).toMatchObject({
      updatedAt: iso(LATER),
      completedAt: iso(LATER),
    });
  });

  it('an unchanged alias neither mails nor registers anything', async () => {
    await twoAdmins();
    const mailer = new WatchMailer();
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer });
    expect(mailer.attempts).toBe(0);
    expect(await resolutionRow(h.owner)).toEqual({
      alias: ALIAS,
      model: V113,
      resolvedAt: STORED_AT,
      checkedAt: iso(NOW),
    });
    expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(NOW), ok: true } });
    expect(await registryOf(h)).toEqual({});
  });
});

describe('W2: a major flip on the fake server', () => {
  it('mails the major-change text, never the same-major sentence, and records major in the notice while it is pending', async () => {
    await confirmNext(V2);
    await twoAdmins();
    flipTo(V2);
    const mailer = new WatchMailer();
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer });

    expect(await resolutionRow(h.owner)).toMatchObject({
      model: V2,
      previous: { model: V113, until: iso(NOW) },
    });
    const oracle = majorMail(V113, V2);
    expect(mailer.sent).toHaveLength(2);
    for (const address of [ADMIN_A, ADMIN_B]) {
      const [mail] = mailer.to(address);
      expect(mail!.subject).toContain(oracle.subject);
      expect(mail!.text).toContain(oracle.sentence);
      expect(mail!.text).not.toContain('ratings and personal models kept');
      expect(mail!.subject).not.toContain('Jev updated');
    }
    expect(await noticeOf()).toBeUndefined();
  });
});

describe('W3: a failed probe keeps the resolution', () => {
  it.each([
    'timeout',
    'provider_unavailable',
    'auth_rejected',
    'model_unavailable',
    'alias_unresolved',
  ])(
    '%s: resolution untouched, no mail, lastCheck failed, probe and progress recorded',
    async (error) => {
      await twoAdmins();
      const before = await rawSetting(h.owner, 'engine.model_resolution');
      const mailer = new WatchMailer();
      const prober = scriptedProber(failedProbe(error));

      await expect(runWatch(h, { prober, mailer })).resolves.toBeDefined();

      expect(prober.probe).toHaveBeenCalledTimes(1);
      expect(prober.probe.mock.calls[0]![0]).toBe(ALIAS);
      expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
      expect(mailer.attempts).toBe(0);
      expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(NOW), ok: false, error } });
      expect(await probeOf(h.owner)).toMatchObject({ requested: ALIAS, ok: false, error });
      expect(await progressOf(h.owner)).toMatchObject({
        updatedAt: iso(NOW),
        completedAt: iso(NOW),
      });
      expect(await registryOf(h)).toEqual({});
    },
  );

  it('a failed probe that names a concrete release does not move the resolution either', async () => {
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    const mailer = new WatchMailer();
    await runWatch(h, {
      prober: scriptedProber(failedProbe('alias_unresolved', { answered: V114 })),
      mailer,
    });
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(mailer.attempts).toBe(0);
    expect((await watchRow(h.owner)).lastCheck).toMatchObject({ at: iso(NOW), ok: false });
  });

  it('an ok answer that is not a concrete Jev id keeps the resolution, mails nobody, and fails the check', async () => {
    await twoAdmins();
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    const mailer = new WatchMailer();
    await runWatch(h, { prober: scriptedProber(okProbe('glm-5.3')), mailer });
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(mailer.attempts).toBe(0);
    expect((await watchRow(h.owner)).lastCheck).toMatchObject({ at: iso(NOW), ok: false });
    expect((await watchRow(h.owner)).notice).toBeUndefined();
    expect(await probeOf(h.owner)).toMatchObject({ ok: true, answered: 'glm-5.3' });
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW) });
  });

  it('W3b the real prober against a fake that fails every request: the run resolves, the resolution stays', async () => {
    await twoAdmins();
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    fake.setOptions({ failRate: 1, failStatus: 503 });
    const mailer = new WatchMailer();

    await expect(runWatch(h, { prober: realProber(h, fake, NOW), mailer })).resolves.toBeDefined();

    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(mailer.attempts).toBe(0);
    const recorded = await probeOf(h.owner);
    expect(recorded).toMatchObject({ requested: ALIAS, ok: false });
    expect(recorded?.error).toBeTruthy();
    expect(await watchRow(h.owner)).toEqual({
      lastCheck: { at: iso(NOW), ok: false, error: recorded!.error },
    });
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW), completedAt: iso(NOW) });
  });

  it('a prober that answers after a failure moves on: the next run adopts the release', async () => {
    await twoAdmins();
    const mailer = new WatchMailer();
    const prober = scriptedProber(failedProbe('timeout'), okProbe(V114));
    await runWatch(h, { prober, mailer });
    expect(mailer.attempts).toBe(0);
    await confirmNext(V114, LATER);
    await runWatch(h, { prober, mailer, now: LATER });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114, resolvedAt: iso(LATER) });
    expect(mailer.sent).toHaveLength(2);
    expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(LATER), ok: true } });
  });
});

describe('W4: a concrete model setting is not probed', () => {
  it('neither the prober nor the fake server is called; nothing changes but the progress record', async () => {
    await twoAdmins();
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    const requests = fake.requestCount();
    const spy = scriptedProber(okProbe(V114));
    const real = realProber(h, fake, NOW);
    const mailer = new WatchMailer();

    await runWatch(h, { prober: spy, configured: V113, mailer });
    await runWatch(h, { prober: real, configured: V113, mailer });
    // Only the exact alias is watched: a near miss is a concrete setting too.
    await runWatch(h, { prober: spy, configured: 'jev-latest ', mailer });

    expect(spy.probe).not.toHaveBeenCalled();
    expect(fake.requestCount()).toBe(requests);
    expect(mailer.attempts).toBe(0);
    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(await probeOf(h.owner)).toBeUndefined();
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW), completedAt: iso(NOW) });
  });

  it('a pending notice is still delivered while the setting is concrete', async () => {
    await addAdmin(h.owner, ADMIN_A);
    await setSetting(h.owner, 'engine.model_watch', {
      notice: { from: V113, to: V114, at: iso(STORED_AT_DATE), major: false, attempts: 2 },
    });
    const spy = scriptedProber(okProbe(V115));
    const mailer = new WatchMailer();
    await runWatch(h, { prober: spy, configured: V114, mailer });
    expect(spy.probe).not.toHaveBeenCalled();
    expect(mailer.to(ADMIN_A)).toHaveLength(1);
    expect(mailer.to(ADMIN_A)[0]!.text).toContain(sameMajorMail(V113, V114).sentence);
    expect(await noticeOf()).toBeUndefined();
  });
});

describe('W5: the outgoing rating fingerprint is registered before the resolution moves', () => {
  it('registers the old sha with its family sha and settings on a flip; a run without a flip leaves the registry alone', async () => {
    await twoAdmins();
    await dropRegistry(h);
    const exact = await exactShaOf(h);
    const family = await familyShaOracle(h);
    const settings = JSON.parse(JSON.stringify(await effectiveSettingsOf(h)));
    expect(await registryOf(h)).toEqual({});

    // No flip: nothing registered, nothing written.
    flipTo(V113);
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer: new WatchMailer() });
    expect(await registryOf(h)).toEqual({});
    expect(await registryStamp(h)).toBeNull();

    flipTo(V114);
    await confirmNext(V114, LATER);
    await runWatch(h, {
      prober: realProber(h, fake, LATER),
      mailer: new WatchMailer(),
      now: LATER,
    });
    const registry = await registryOf(h);
    expect(Object.keys(registry)).toEqual([exact]);
    expect(registry[exact]).toMatchObject({ family, settings, firstSeenAt: iso(LATER) });

    // Another run on the new release: still one entry, not rewritten.
    const stamp = await registryStamp(h);
    await runWatch(h, {
      prober: realProber(h, fake, LATER),
      mailer: new WatchMailer(),
      now: LATER,
    });
    expect(await registryStamp(h)).toBe(stamp);
    expect(Object.keys(await registryOf(h))).toEqual([exact]);
  });

  it('an already registered sha is not written again on a flip', async () => {
    await confirmNext(V114);
    await twoAdmins();
    await dropRegistry(h);
    const exact = await exactShaOf(h);
    flipTo(V114);
    await runWatch(h, { prober: realProber(h, fake, NOW), mailer: new WatchMailer() });
    const stamp = await registryStamp(h);
    expect(stamp).not.toBeNull();
    // A second flip from 1.14.0: the pin is still 1.13.0 (no worker restarted), so the sha of the
    // pin is the one already registered and the registry is not rewritten.
    flipTo(V115);
    await confirmNext(V115, LATER);
    await runWatch(h, {
      prober: realProber(h, fake, LATER),
      mailer: new WatchMailer(),
      now: LATER,
    });
    expect(Object.keys(await registryOf(h))).toEqual([exact]);
    expect(await registryStamp(h)).toBe(stamp);
  });

  it('a registry write that fails leaves the resolution, the notice and the mail untouched', async () => {
    await confirmNext(V114);
    await twoAdmins();
    await dropRegistry(h);
    await h.owner.query(`
      CREATE FUNCTION refuse_registry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'registry refused'; END $$`);
    await h.owner.query(`
      CREATE TRIGGER refuse_registry BEFORE INSERT OR UPDATE ON settings
        FOR EACH ROW WHEN (NEW.key = 'engine.rating_fingerprints')
        EXECUTE FUNCTION refuse_registry()`);
    const before = await rawSetting(h.owner, 'engine.model_resolution');
    flipTo(V114);
    const mailer = new WatchMailer();

    await runWatch(h, { prober: realProber(h, fake, NOW), mailer }).catch(() => undefined);

    expect(await rawSetting(h.owner, 'engine.model_resolution')).toEqual(before);
    expect(await noticeOf()).toBeUndefined();
    expect(mailer.attempts).toBe(0);
    expect(await registryOf(h)).toEqual({});
  });
});

describe('W6: notice delivery', () => {
  it('a failing mailer logs the delivery trouble under the house.model-watch job', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;
    const rec = await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    const failed = rec.logs.filter((l) => l.msg === 'alert email not delivered');
    expect(failed.map((l) => l.obj.job)).toEqual(['house.model-watch']);
  });

  it('a failing mailer keeps the notice pending (attempts 1) after adopting the release; the next run delivers one mail and clears it; the third sends none', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;

    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(await noticeOf()).toEqual({
      from: V113,
      to: V114,
      at: iso(NOW),
      major: false,
      attempts: 1,
    });
    expect(mailer.sent).toHaveLength(0);

    mailer.failing = false;
    await runWatch(h, { prober: scriptedProber(okProbe(V114, LATER)), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.to(ADMIN_A)[0]!.subject).toContain(sameMajorMail(V113, V114).subject);
    expect(mailer.to(ADMIN_A)[0]!.text).toContain(sameMajorMail(V113, V114).sentence);
    expect(await noticeOf()).toBeUndefined();
    expect(await resolutionRow(h.owner)).toMatchObject({
      model: V114,
      resolvedAt: iso(NOW),
      checkedAt: iso(LATER),
    });

    await runWatch(h, { prober: scriptedProber(okProbe(V114, LATER)), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a pending notice is delivered once per run even though delivery has two points in the run', async () => {
    await addAdmin(h.owner, ADMIN_A);
    await setSetting(h.owner, 'engine.model_watch', {
      notice: { from: V113, to: V114, at: iso(STORED_AT_DATE), major: false, attempts: 3 },
    });
    await storeResolution(h.owner, V114, STORED_AT);
    const mailer = new WatchMailer();
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.attempts).toBe(1);
    expect(await noticeOf()).toBeUndefined();
  });

  it('delivers a pending notice first: it is mailed even when the probe step blows up', async () => {
    await addAdmin(h.owner, ADMIN_A);
    await setSetting(h.owner, 'engine.model_watch', {
      notice: { from: V113, to: V114, at: iso(STORED_AT_DATE), major: false, attempts: 1 },
    });
    await storeResolution(h.owner, V114, STORED_AT);
    const prober = scriptedProber(okProbe(V114));
    prober.probe.mockRejectedValue(new Error('prober exploded'));
    const mailer = new WatchMailer();

    await runWatch(h, { prober, mailer }).catch(() => undefined);

    expect(prober.probe).toHaveBeenCalledTimes(1);
    expect(mailer.to(ADMIN_A)).toHaveLength(1);
    expect(await noticeOf()).toBeUndefined();
  });

  it('two admins where the first address rejects and the second accepts count as delivered', async () => {
    await confirmNext(V114);
    await twoAdmins();
    const mailer = new WatchMailer();
    mailer.rejecting.add(ADMIN_A);

    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });

    expect(mailer.to(ADMIN_A)).toHaveLength(0);
    expect(mailer.to(ADMIN_B)).toHaveLength(1);
    expect(mailer.attempts).toBe(2);
    expect(await noticeOf()).toBeUndefined();

    // Cleared: the next run does not mail the rejecting address again.
    mailer.rejecting.clear();
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up after MODEL_NOTICE_MAX_ATTEMPTS failed deliveries: the notice is cleared, an error is logged, and no further mail is tried', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;
    const rec = recorder();
    const prober = scriptedProber(okProbe(V114));

    await runWatch(h, { prober, mailer, rec });
    let runs = 1;
    const cap = MODEL_NOTICE_MAX_ATTEMPTS + 3;
    while ((await noticeOf()) !== undefined && runs < cap) {
      const pending = (await noticeOf())!;
      expect(pending.attempts).toBeGreaterThanOrEqual(1);
      expect(pending.attempts).toBeLessThan(MODEL_NOTICE_MAX_ATTEMPTS);
      await runWatch(h, { prober, mailer, rec });
      runs += 1;
    }

    expect(await noticeOf()).toBeUndefined();
    expect(mailer.attempts).toBe(MODEL_NOTICE_MAX_ATTEMPTS);
    expect(mailer.sent).toHaveLength(0);
    expect(rec.logs.filter((entry) => entry.level === 'error')).not.toHaveLength(0);

    const attempts = mailer.attempts;
    mailer.failing = false;
    await runWatch(h, { prober, mailer, rec });
    expect(mailer.attempts).toBe(attempts);
    expect(mailer.sent).toHaveLength(0);
  });

  it('with no admin and no ADMIN_EMAILS the notice is cleared with a warning and the run does not throw', async () => {
    await confirmNext(V114);
    const mailer = new WatchMailer();
    const rec = recorder();
    await expect(
      runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer, rec }),
    ).resolves.toBeDefined();
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(await noticeOf()).toBeUndefined();
    expect(mailer.attempts).toBe(0);
    expect(rec.logs.filter((entry) => entry.level === 'warn')).not.toHaveLength(0);
    expect(rec.logs.filter((entry) => entry.level === 'error')).toHaveLength(0);
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW) });
  });

  it('with no mailer the notice is cleared with a warning', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const rec = recorder();
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer: null, rec });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
    expect(await noticeOf()).toBeUndefined();
    expect(rec.logs.filter((entry) => entry.level === 'warn')).not.toHaveLength(0);
  });

  it('ADMIN_EMAILS is the recipient list only while there is no active admin', async () => {
    await confirmNext(V114);
    const fallback = new WatchMailer();
    await runWatch(h, {
      prober: scriptedProber(okProbe(V114)),
      mailer: fallback,
      adminEmails: ['env-admin@example.test'],
    });
    expect(fallback.to('env-admin@example.test')).toHaveLength(1);
    expect(fallback.sent).toHaveLength(1);

    await storeResolution(h.owner, V113, STORED_AT);
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const active = new WatchMailer();
    await runWatch(h, {
      prober: scriptedProber(okProbe(V114)),
      mailer: active,
      adminEmails: ['env-admin@example.test'],
    });
    expect(active.to(ADMIN_A)).toHaveLength(1);
    expect(active.to('env-admin@example.test')).toHaveLength(0);
  });

  it('two flips while delivery fails leave one merged notice from the earliest release to the latest', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;

    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    await runWatch(h, {
      prober: scriptedProber(okProbe(V114)),
      mailer,
      now: new Date(NOW.getTime() + 60_000),
    });
    const middle = (await noticeOf())!;
    expect(middle).toMatchObject({ from: V113, to: V114 });
    expect(middle.attempts).toBeGreaterThanOrEqual(2);

    const third = new Date(NOW.getTime() + 120_000);
    await confirmNext(V115, third);
    await runWatch(h, { prober: scriptedProber(okProbe(V115, third)), mailer, now: third });
    const merged = (await noticeOf())!;
    expect(merged).toMatchObject({ from: V113, to: V115, at: iso(third), major: false });
    expect(merged.attempts).toBeLessThanOrEqual(1);
    expect(await resolutionRow(h.owner)).toMatchObject({
      model: V115,
      previous: { model: V114, until: iso(third) },
    });

    mailer.failing = false;
    await runWatch(h, { prober: scriptedProber(okProbe(V115)), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain(sameMajorMail(V113, V115).subject);
    expect(mailer.sent[0]!.text).toContain(sameMajorMail(V113, V115).sentence);
    expect(await noticeOf()).toBeUndefined();
  });

  it('1.13 to 1.14 to 2.0.0 while delivery fails merges into one major notice', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    expect((await noticeOf())!.major).toBe(false);

    await confirmNext(V2, LATER);
    await runWatch(h, { prober: scriptedProber(okProbe(V2, LATER)), mailer, now: LATER });
    expect(await noticeOf()).toMatchObject({ from: V113, to: V2, major: true });

    mailer.failing = false;
    await runWatch(h, { prober: scriptedProber(okProbe(V2)), mailer, now: LATER });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain(majorMail(V113, V2).subject);
    expect(mailer.sent[0]!.text).toContain(majorMail(V113, V2).sentence);
  });

  it('major is sticky: 1.13 to 2.0.0 and back to 1.14.0 before delivery is still a major notice', async () => {
    await confirmNext(V2);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;
    await runWatch(h, { prober: scriptedProber(okProbe(V2)), mailer });
    await confirmNext(V114, LATER);
    await runWatch(h, { prober: scriptedProber(okProbe(V114, LATER)), mailer, now: LATER });
    expect(await noticeOf()).toMatchObject({ from: V113, to: V114, major: true });
    mailer.failing = false;
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer, now: LATER });
    expect(mailer.sent[0]!.subject).toContain(majorMail(V113, V114).subject);
    expect(mailer.sent[0]!.text).not.toContain('ratings and personal models kept');
  });

  it('the notice is written in the same transaction as the resolution (never a resolution without its notice)', async () => {
    await confirmNext(V114);
    await addAdmin(h.owner, ADMIN_A);
    const mailer = new WatchMailer();
    mailer.failing = true;
    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });
    const resolution = await resolutionRow(h.owner);
    const notice = await noticeOf();
    expect(resolution?.previous?.model).toBe(notice?.from);
    expect(resolution?.model).toBe(notice?.to);
    expect(resolution?.resolvedAt).toBe(notice?.at);
  });
});

describe('W7: the first resolution', () => {
  it('is written without previous, a notice, a mail or a registered fingerprint', async () => {
    await twoAdmins();
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_resolution'`);
    const mailer = new WatchMailer();

    await runWatch(h, { prober: scriptedProber(okProbe(V114)), mailer });

    expect(await resolutionRow(h.owner)).toEqual({
      alias: ALIAS,
      model: V114,
      resolvedAt: iso(NOW),
      checkedAt: iso(NOW),
    });
    expect(mailer.attempts).toBe(0);
    expect(await watchRow(h.owner)).toEqual({ lastCheck: { at: iso(NOW), ok: true } });
    expect(await registryOf(h)).toEqual({});
    expect(await progressOf(h.owner)).toMatchObject({ updatedAt: iso(NOW), completedAt: iso(NOW) });
  });

  it('the stored lastCheck shape carries exactly the documented fields', async () => {
    await runWatch(h, {
      prober: scriptedProber(failedProbe('timeout')),
      mailer: new WatchMailer(),
    });
    const row: WatchRow = await watchRow(h.owner);
    expect(Object.keys(row.lastCheck ?? {}).sort()).toEqual(['at', 'error', 'ok']);
    expect(await settingValue(h.owner, 'engine.model_watch')).toBeDefined();
  });
});
