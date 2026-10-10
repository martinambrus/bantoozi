import { readRatingFingerprint } from '@bantoozi/db';
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
