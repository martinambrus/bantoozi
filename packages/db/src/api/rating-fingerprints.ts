import {
  readerSchema,
  RATING_FINGERPRINTS_KEY,
  RATING_FINGERPRINTS_MAX,
  RatingFingerprintEntrySchema,
  type RatingFingerprintEntry,
} from '@bantoozi/shared';

import type { Database, Executor } from '../client.js';
import { retryTransaction } from '../ingest/retry.js';
import { readStoredSettings, updateSettingLocked } from '../settings.js';
import {
  RATING_FINGERPRINT_SETTINGS,
  ratingFingerprintOf,
  type RatingDefaults,
  type RatingFingerprint,
} from './article-actions.js';

/** The four fingerprint settings plus the registry: what a reader of the registry state selects. */
export const RATING_FINGERPRINT_STATE_KEYS = [
  ...RATING_FINGERPRINT_SETTINGS,
  RATING_FINGERPRINTS_KEY,
] as const;

/** The current fingerprint with the registered exact-sha to family-sha map. */
export interface RatingFingerprintState extends RatingFingerprint {
  families: Record<string, string>;
  registered: boolean;
}

const SHA = /^[0-9a-f]{64}$/;

const validEntries = (value: unknown): Map<string, RatingFingerprintEntry> => {
  const entries = new Map<string, RatingFingerprintEntry>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return entries;
  for (const [sha, raw] of Object.entries(value)) {
    if (!SHA.test(sha)) continue;
    const parsed = readerSchema(RatingFingerprintEntrySchema).safeParse(raw);
    if (parsed.success) entries.set(sha, parsed.data);
  }
  return entries;
};

/** The current fingerprint, reading only the four fingerprint settings. */
export async function readCurrentRatingFingerprint(
  executor: Executor,
  defaults: RatingDefaults,
): Promise<RatingFingerprint> {
  return ratingFingerprintOf(
    await readStoredSettings(executor, RATING_FINGERPRINT_SETTINGS),
    defaults,
  );
}

/** The state of already-read stored settings (the state keys); invalid registry entries are ignored. */
export function ratingFingerprintStateOf(
  stored: ReadonlyMap<string, unknown>,
  defaults: RatingDefaults,
): RatingFingerprintState {
  const fingerprint = ratingFingerprintOf(stored, defaults);
  const entries = validEntries(stored.get(RATING_FINGERPRINTS_KEY));
  const families: Record<string, string> = {};
  for (const [sha, entry] of entries) families[sha] = entry.family;
  families[fingerprint.sha] = fingerprint.familySha;
  return { ...fingerprint, families, registered: entries.has(fingerprint.sha) };
}

/** The fingerprint state in one read of the state keys. */
export async function readRatingFingerprintState(
  executor: Executor,
  defaults: RatingDefaults,
): Promise<RatingFingerprintState> {
  return ratingFingerprintStateOf(
    await readStoredSettings(executor, RATING_FINGERPRINT_STATE_KEYS),
    defaults,
  );
}

/**
 * Add the fingerprint to the registry under its row lock (worker only). A present sha is not
 * rewritten; invalid entries are dropped; above the cap other families go first, oldest first.
 */
export async function registerRatingFingerprint(
  db: Database,
  fp: RatingFingerprint,
  now: Date,
): Promise<{ registered: boolean; evicted: number }> {
  return retryTransaction(db, async (tx) => {
    let registered = false;
    let evicted = 0;
    await updateSettingLocked<Record<string, RatingFingerprintEntry>>(
      tx,
      RATING_FINGERPRINTS_KEY,
      {},
      (current) => {
        registered = false;
        evicted = 0;
        const entries = validEntries(current);
        if (!entries.has(fp.sha)) {
          registered = true;
          entries.set(fp.sha, {
            family: fp.familySha,
            settings: fp.settings as RatingFingerprintEntry['settings'],
            firstSeenAt: now.toISOString(),
          });
          const oldestFirst = (
            a: [string, RatingFingerprintEntry],
            b: [string, RatingFingerprintEntry],
          ) =>
            a[1].firstSeenAt < b[1].firstSeenAt
              ? -1
              : a[1].firstSeenAt > b[1].firstSeenAt
                ? 1
                : a[0] < b[0]
                  ? -1
                  : a[0] > b[0]
                    ? 1
                    : 0;
          const candidates = [...entries].filter(([sha]) => sha !== fp.sha).sort(oldestFirst);
          const queue = [
            ...candidates.filter(([, entry]) => entry.family !== fp.familySha),
            ...candidates.filter(([, entry]) => entry.family === fp.familySha),
          ];
          while (entries.size > RATING_FINGERPRINTS_MAX && queue.length > 0) {
            entries.delete(queue.shift()![0]);
            evicted += 1;
          }
        }
        return Object.fromEntries(entries);
      },
    );
    return { registered, evicted };
  });
}
