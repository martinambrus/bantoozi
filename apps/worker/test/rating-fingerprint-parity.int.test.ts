import {
  readCurrentRatingFingerprint,
  readRatingFingerprint,
  readRatingFingerprintState,
  type RatingDefaults,
} from '@bantoozi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadClassificationConfig, ratingDefaults } from '../src/classify/config.js';
import { ClassifyHarness } from './support/classify.js';

/**
 * The rating fingerprint (spec 06 §8.1) hashes the effective settings. The API stamps it with
 * defaults built from its environment (`ratingDefaultsFor` in apps/api/src/services/analysis.ts);
 * the worker computes it from its classification config. Both must agree for the same settings.
 */
let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);

afterAll(async () => {
  await h?.close();
});

const PRIMARY = () => h.deps.classification!.primaryModel;

/** The API side: the defaults `ratingDefaultsFor` derives from its config. */
const apiDefaults = () => ({
  model: PRIMARY(),
  languageModes: h.settingsEnv.languageModes,
  cardTextMode: 'as_written' as const,
});

async function workerDefaults() {
  return ratingDefaults(
    await loadClassificationConfig(h.db, h.settingsEnv),
    h.deps.classification!.primaryModel,
  );
}

describe('rating fingerprint parity between API and worker', () => {
  it('agrees for the seeded settings and with a stored model pin or card text mode', async () => {
    expect(await readRatingFingerprint(h.db, await workerDefaults())).toBe(
      await readRatingFingerprint(h.db, apiDefaults()),
    );
    await h.owner.query(`DELETE FROM settings WHERE key IN ('language_modes', 'card_text_mode')`);
    expect(await readRatingFingerprint(h.db, await workerDefaults())).toBe(
      await readRatingFingerprint(h.db, apiDefaults()),
    );
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ('engine.model_pin', '{"model": "pinned-1"}')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    expect(await readRatingFingerprint(h.db, await workerDefaults())).toBe(
      await readRatingFingerprint(h.db, apiDefaults()),
    );
  });

  it('changes when only the default model, language modes or card text mode changes', async () => {
    await h.owner.query(
      `DELETE FROM settings WHERE key IN ('engine.model_pin', 'language_modes', 'card_text_mode')`,
    );
    const defaults = apiDefaults();
    const base = await readRatingFingerprint(h.db, defaults);
    expect(await readRatingFingerprint(h.db, { ...defaults, model: 'other-model' })).not.toBe(base);
    expect(
      await readRatingFingerprint(h.db, { ...defaults, languageModes: { de: 'translate' } }),
    ).not.toBe(base);
    expect(
      await readRatingFingerprint(h.db, { ...defaults, cardTextMode: 'english' as const }),
    ).not.toBe(base);
  });
});

const LAYA = { checkpointSha: 'a'.repeat(64), calibrationVersion: 'cal-1' } as const;

async function setPin(value: unknown): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('engine.model_pin', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

/** Both sides' view of the current state: exact sha and family sha from the same defaults. */
async function bothSides() {
  const api = apiDefaults();
  const worker = await workerDefaults();
  return {
    api: await readCurrentRatingFingerprint(h.db, api),
    worker: await readCurrentRatingFingerprint(h.db, worker),
    state: await readRatingFingerprintState(h.db, worker),
    exact: await readRatingFingerprint(h.db, worker),
  };
}

describe('family fingerprint parity between API and worker', () => {
  it('agrees for the seeded settings, with and without a stored pin or card text mode, and the exact sha stays the exact sha', async () => {
    await h.owner.query(
      `DELETE FROM settings WHERE key IN ('engine.model_pin', 'engine.rating_fingerprints')`,
    );
    for (const pin of [undefined, { model: 'jev-1.13.0', since: '2026-10-01T00:00:00.000Z' }]) {
      if (pin !== undefined) await setPin(pin);
      const seen = await bothSides();
      expect(seen.api.familySha).toBe(seen.worker.familySha);
      expect(seen.api.sha).toBe(seen.worker.sha);
      expect(seen.api.sha).toBe(seen.exact);
      expect(seen.state.sha).toBe(seen.exact);
      expect(seen.state.familySha).toBe(seen.worker.familySha);
      expect(seen.state.familySha).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.state.familySha).not.toBe(seen.exact);
    }
    await h.owner.query(`DELETE FROM settings WHERE key IN ('language_modes', 'card_text_mode')`);
    const seen = await bothSides();
    expect(seen.api.familySha).toBe(seen.worker.familySha);
  });

  it('changes the family sha with the pin family, laya, language modes and card text mode, not with the release, alias, since or llm', async () => {
    await h.owner.query(
      `DELETE FROM settings WHERE key IN ('engine.model_pin', 'engine.rating_fingerprints', 'language_modes', 'card_text_mode')`,
    );
    const defaults = apiDefaults();
    const familyOf = async (d: RatingDefaults = defaults) =>
      (await readCurrentRatingFingerprint(h.db, d)).familySha;
    const shaOf = async (d = defaults) => readRatingFingerprint(h.db, d);

    await setPin({ model: 'jev-1.13.0', since: '2026-10-01T00:00:00.000Z' });
    const family = await familyOf();
    const exact = await shaOf();

    await setPin({ model: 'jev-1.14.0', since: '2026-10-02T00:00:00.000Z' });
    expect(await familyOf()).toBe(family);
    expect(await shaOf()).not.toBe(exact);
    await setPin({ model: 'jev-1.14.0', alias: 'jev-latest', since: '2026-10-03T00:00:00.000Z' });
    expect(await familyOf()).toBe(family);
    await setPin({
      model: 'jev-1.13.0',
      llm: { fast: 'glm-fast', strong: 'glm-strong' },
      since: '2026-10-03T00:00:00.000Z',
    });
    expect(await familyOf()).toBe(family);
    expect(await shaOf()).toBe(exact);

    await setPin({ model: 'jev-2.0.0', since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf()).not.toBe(family);
    await setPin({ model: 'jev-latest', since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf()).not.toBe(family);
    await setPin({ model: 'jev-1', since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf()).not.toBe(family);

    await setPin({ model: 'jev-1.13.0', laya: LAYA, since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf()).not.toBe(family);
    const withLaya = await familyOf();
    await setPin({ model: 'jev-1.14.0', laya: LAYA, since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf()).toBe(withLaya);

    await setPin({ model: 'jev-1.13.0', since: '2026-10-01T00:00:00.000Z' });
    expect(await familyOf({ ...defaults, languageModes: { de: 'translate' } })).not.toBe(family);
    expect(await familyOf({ ...defaults, cardTextMode: 'english' as const })).not.toBe(family);
    const worker = await workerDefaults();
    expect((await readCurrentRatingFingerprint(h.db, worker)).familySha).toBe(await familyOf());
  });
});
