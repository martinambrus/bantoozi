import { readRatingFingerprintState, registerRatingFingerprint, type Database } from '@bantoozi/db';

import {
  loadClassificationConfig,
  ratingDefaults,
  type ClassificationEnv,
} from '../classify/config.js';

/** Register the current rating fingerprint in the registry when it is not there yet. */
export async function ensureFingerprintRegistered(
  db: Database,
  deps: { settingsEnv: ClassificationEnv; primaryModel: string },
  now: Date,
): Promise<{ registered: boolean; evicted: number }> {
  const config = await loadClassificationConfig(db, deps.settingsEnv);
  const state = await readRatingFingerprintState(db, ratingDefaults(config, deps.primaryModel));
  if (state.registered) return { registered: false, evicted: 0 };
  return registerRatingFingerprint(
    db,
    { sha: state.sha, familySha: state.familySha, settings: state.settings },
    now,
  );
}
