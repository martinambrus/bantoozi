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

export const fingerprintCounters = { evicted: 0, failed: 0 };

export async function guardedRegistration<T extends { evicted: number }>(
  run: () => Promise<T>,
  logger: { warn(obj: object, msg: string): void },
  options?: { rethrow?: boolean },
): Promise<T | null> {
  try {
    const result = await run();
    if (result.evicted > 0) {
      fingerprintCounters.evicted += result.evicted;
      logger.warn({ evicted: result.evicted }, 'rating fingerprint registry evicted entries');
    }
    return result;
  } catch (err) {
    fingerprintCounters.failed += 1;
    logger.warn({ err }, 'rating fingerprint registration failed');
    if (options?.rethrow === true) throw err;
    return null;
  }
}
