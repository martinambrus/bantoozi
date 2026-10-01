import { AppError, mergeRankerConfig, type RankerConfig } from '@bantoozi/shared';

import { scoreVersion } from './version.js';

/**
 * The persisted ranking settings (spec 06 §7, §11): `settings['ranker.thresholds']` overriding the
 * shared defaults, and `settings['ranker.settings_version']`, which makes the composite score
 * version. The rank handler and the API read the two rows and resolve them here, so both validate
 * them the same way.
 */
export interface StoredRankerSettings {
  /** The stored `ranker.thresholds` value; `undefined` when the row is missing. */
  thresholds: unknown;
  /** The stored `ranker.settings_version` value; `undefined` when the row is missing. */
  settingsVersion: unknown;
}

/** The validated settings a rank run uses. */
export interface RankerSettings {
  /** The fully merged and validated config (defaults plus the override). */
  config: RankerConfig;
  /** `ranker.settings_version` as a canonical decimal string (`'0'` when never written). */
  settingsVersion: string;
  /** `scoreVersion(settingsVersion)`: `"<RANKER_VERSION>:<settings_version>"`. */
  scoreVersion: string;
}

/**
 * A persisted ranking setting that does not validate. Ranking stops with this error instead of
 * falling back to the defaults, so a broken override never silently changes every reader's lanes
 * (spec 06 §11); an operator fixes the row.
 */
export class RankerSettingsError extends AppError {
  constructor(key: 'ranker.thresholds' | 'ranker.settings_version', cause: unknown) {
    super('INTERNAL', `Stored setting ${key} is invalid; ranking is stopped until it is fixed`, {
      details: { key },
      cause,
    });
    this.name = 'RankerSettingsError';
  }
}

/**
 * Resolves the stored ranking settings (spec 06 §7, §11). A missing row means its default: no
 * override, settings version 0. A present row must validate: the override through the strict
 * shared schema (unknown keys such as `windowDays` are rejected, the window is the fixed
 * `RANK_WINDOW_DAYS`), then the merged config as a whole; the version as a non-negative safe
 * integer. Anything else throws {@link RankerSettingsError}.
 */
export function resolveRankerSettings(stored: StoredRankerSettings): RankerSettings {
  let config: RankerConfig;
  try {
    // `mergeRankerConfig` reads null as "no override"; a stored JSON null is malformed instead.
    if (stored.thresholds === null) throw new TypeError('ranker.thresholds must be an object');
    config = mergeRankerConfig(stored.thresholds === undefined ? {} : stored.thresholds);
  } catch (error) {
    throw new RankerSettingsError('ranker.thresholds', error);
  }
  const version = stored.settingsVersion === undefined ? 0 : stored.settingsVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new RankerSettingsError(
      'ranker.settings_version',
      new RangeError('settings version must be a non-negative safe integer'),
    );
  }
  return { config, settingsVersion: String(version), scoreVersion: scoreVersion(version) };
}
