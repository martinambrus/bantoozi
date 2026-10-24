import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as fingerprints from '../src/learn/fingerprints.js';
import { ClassifyHarness } from './support/classify.js';
import { begin } from './support/jev4-world.js';
import { resolutionRow, setSetting, storeResolution } from './support/m8b-t5-world.js';
import {
  ALIAS,
  V113,
  V114,
  STORED_AT,
  candidateRow,
  iso,
  okProbe,
  runWatch,
  scriptedProber,
  watchRow,
} from './support/model-watch-world.js';

const NOW = new Date(Date.now() + 86_400_000);
const CONFIRM = new Date(NOW.getTime() + 600_000);
let h: ClassifyHarness;
beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  await h?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await h.owner.query(
    "DELETE FROM settings WHERE key IN ('engine.model_watch', 'engine.model_candidate', 'engine.model_resolution')",
  );
  await begin(h, V113);
  await setSetting(h.owner, 'engine.model_pin', { model: V113, alias: ALIAS, since: STORED_AT });
  await storeResolution(h.owner, V113, STORED_AT);
  await runWatch(h, { prober: scriptedProber(okProbe(V114, NOW)), now: NOW, mailer: null });
});

describe('confirmed watch registration status', () => {
  it('does not publish a successful check while fingerprint registration is pending', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = fingerprints.ensureFingerprintRegistered;
    vi.spyOn(fingerprints, 'ensureFingerprintRegistered').mockImplementation(async (...args) => {
      entered();
      await blocked;
      return real(...args);
    });
    const running = runWatch(h, {
      prober: scriptedProber(okProbe(V114, CONFIRM)),
      now: CONFIRM,
      mailer: null,
    });
    try {
      await started;
      expect((await watchRow(h.owner)).lastCheck).toEqual({ at: iso(NOW), ok: true });
      expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    } finally {
      release();
      await running;
    }
    expect((await watchRow(h.owner)).lastCheck).toEqual({ at: iso(CONFIRM), ok: true });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
  });

  it('publishes persistent registration failure while preserving the candidate for retry', async () => {
    const registration = vi
      .spyOn(fingerprints, 'ensureFingerprintRegistered')
      .mockRejectedValue(new Error('registration refused'));
    await expect(
      runWatch(h, { prober: scriptedProber(okProbe(V114, CONFIRM)), now: CONFIRM, mailer: null }),
    ).rejects.toThrow('registration refused');
    expect((await watchRow(h.owner)).lastCheck).toEqual({
      at: iso(CONFIRM),
      ok: false,
      error: 'fingerprint_registration',
    });
    await expect(
      runWatch(h, { prober: scriptedProber(okProbe(V114, CONFIRM)), now: CONFIRM, mailer: null }),
    ).rejects.toThrow('registration refused');
    expect((await watchRow(h.owner)).lastCheck).toEqual({
      at: iso(CONFIRM),
      ok: false,
      error: 'fingerprint_registration',
    });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V113 });
    expect(await candidateRow(h.owner)).toMatchObject({ model: V114 });
    registration.mockRestore();
    await runWatch(h, {
      prober: scriptedProber(okProbe(V114, CONFIRM)),
      now: CONFIRM,
      mailer: null,
    });
    expect((await watchRow(h.owner)).lastCheck).toEqual({ at: iso(CONFIRM), ok: true });
    expect(await resolutionRow(h.owner)).toMatchObject({ model: V114 });
  });
});
