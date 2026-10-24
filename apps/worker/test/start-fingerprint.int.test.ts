import * as db from '@bantoozi/db';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as fingerprints from '../src/learn/fingerprints.js';
import { loadClassificationConfig, ratingDefaults } from '../src/classify/config.js';
import {
  ClassifyHarness,
  OLD_MODEL,
  NEW_MODEL,
  baseConfig,
  recorder,
  resetWorld,
  startRuntime,
  pinRow,
  type WorkerRuntimeLike,
} from './support/m8b-t5-world.js';
let h: ClassifyHarness;
const runtimes: WorkerRuntimeLike[] = [];
beforeAll(async () => {
  h = await ClassifyHarness.start();
}, 240_000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await h?.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetWorld(h);
});
async function boot(model = OLD_MODEL) {
  const runtime = await startRuntime({
    db: h.db,
    config: baseConfig('production', { typesafeModel: model }),
    recorder: recorder(),
    selfRestart: false,
  });
  runtimes.push(runtime);
  return runtime;
}
it('registers the outgoing fingerprint on start before moving the pin without an earlier learn run', async () => {
  await h.owner.query("DELETE FROM settings WHERE key = 'engine.rating_fingerprints'");
  const config = await loadClassificationConfig(h.db, h.settingsEnv);
  const before = await db.readRatingFingerprintState(h.db, ratingDefaults(config, OLD_MODEL));
  expect(before.registered).toBe(false);
  await boot(NEW_MODEL);
  const stored = await db.readStoredSetting(h.db, 'engine.rating_fingerprints');
  expect(stored).toHaveProperty(before.sha);
  expect(await pinRow(h.owner)).toMatchObject({ model: NEW_MODEL });
});

it('keeps the outgoing pin when its fingerprint cannot be registered', async () => {
  const before = await pinRow(h.owner);
  vi.spyOn(fingerprints, 'ensureFingerprintRegistered').mockRejectedValueOnce(
    new Error('registry unavailable'),
  );
  await expect(boot(NEW_MODEL)).rejects.toThrow('registry unavailable');
  expect(await pinRow(h.owner)).toEqual(before);
});
