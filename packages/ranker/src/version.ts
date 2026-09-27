import { isBigIntString } from '@bantoozi/shared';

/**
 * Version of the ranking semantics (spec 06 §7), bumped whenever `rankArticle` would place or
 * explain an unchanged input differently. It is a positive decimal string, never `'0'`:
 * `user_article.score_version` defaults to `'0:0'`, so a row that was never ranked is never current.
 */
export const RANKER_VERSION = '1';

/** `ranker.settings_version` (a JSON int in `settings`), as a number, bigint or decimal string. */
export type SettingsVersion = number | bigint | string;

const POSITIVE_DECIMAL = /^[1-9]\d*$/;

/**
 * `score_version = "<RANKER_VERSION>:<ranker.settings_version>"` (spec 06 §7). Both parts are
 * canonical decimal strings, so the `:` makes the key unambiguous (`'1:10'` and `'11:0'` differ) and
 * stays so after any number of settings changes. Compare keys with text equality only
 * ({@link isRankCurrent}), never by ordering. `rankerVersion` defaults to {@link RANKER_VERSION}; an
 * evaluation of other semantics may pass its own.
 *
 * @throws RangeError for a negative, fractional, non-canonical or out-of-range settings version, or a
 *   ranker version that is not a positive decimal.
 */
export function scoreVersion(
  settingsVersion: SettingsVersion,
  rankerVersion: string = RANKER_VERSION,
): string {
  if (!POSITIVE_DECIMAL.test(rankerVersion)) {
    throw new RangeError('rankerVersion must be a positive decimal string');
  }
  return `${rankerVersion}:${settingsVersionString(settingsVersion)}`;
}

function settingsVersionString(version: SettingsVersion): string {
  if (typeof version === 'number') {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new RangeError('settings version must be a non-negative safe integer');
    }
    return String(version);
  }
  const text = typeof version === 'bigint' ? version.toString() : version;
  if (!isRevision(text)) throw new RangeError('settings version must be a non-negative decimal');
  return text;
}

/** The ranking stamp stored on a `user_article` row. */
export interface RankStamp {
  scoreVersion: string;
  /** `user_article.rank_revision`: a bigint or its decimal string. */
  rankRevision: string | bigint;
}

/** What a current ranking must have been computed with. */
export interface CurrentRankStamp {
  /** {@link scoreVersion} of the current `ranker.settings_version`. */
  currentScoreVersion: string;
  /** `users.rank_revision`: a bigint or its decimal string. */
  userRankRevision: string | bigint;
}

/**
 * Whether a stored ranking is current (spec 06 §7, the API's catch-up check in spec 08 §5.1): its
 * score version equals the current one as text, and its rank revision equals the user's as a bigint.
 * Any difference, in either direction, means outdated: versions are never ordered, and a user-specific
 * invalidation (`users.rank_revision + 1`) makes every older row outdated. A missing row or a
 * malformed revision is not current, so the caller re-ranks rather than trusting it. The rank
 * handler's other dirty conditions (`next_rank_at`, content/media revisions, newer inputs) are
 * separate checks.
 */
export function isRankCurrent(
  stored: RankStamp | null | undefined,
  current: CurrentRankStamp,
): boolean {
  if (stored === null || stored === undefined) return false;
  if (stored.scoreVersion !== current.currentScoreVersion) return false;
  const storedRevision = revisionValue(stored.rankRevision);
  const userRevision = revisionValue(current.userRankRevision);
  return storedRevision !== null && storedRevision === userRevision;
}

function revisionValue(revision: string | bigint): bigint | null {
  const text = typeof revision === 'bigint' ? revision.toString() : revision;
  return isRevision(text) ? BigInt(text) : null;
}

/** A canonical non-negative decimal within PostgreSQL `bigint` range. */
function isRevision(text: string): boolean {
  return isBigIntString(text) && !text.startsWith('-');
}
