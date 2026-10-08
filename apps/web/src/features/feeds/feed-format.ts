import { FEED_ERROR_CODES, type FeedInfo } from '@bantoozi/shared';
import type { TFunction } from 'i18next';

const FEED_HTTP_CODE = /^FEED_HTTP_(\d{3})$/;

/** The sentence for a fetch error code, with a generic one for codes this version does not know. */
export function feedErrorReason(t: TFunction, code: string | null): string {
  if (code !== null) {
    const status = FEED_HTTP_CODE.exec(code)?.[1];
    if (status !== undefined) return t('common:errors.FEED_HTTP', { status });
    if ((FEED_ERROR_CODES as readonly string[]).includes(code)) return t(`common:errors.${code}`);
  }
  return t('feeds:errors.unknown');
}

/**
 * Whether the row shows the feed's last error. A success leaves the error fields as they were, so
 * a feed that works again shows an old error only until the next success is newer than it.
 */
export function showsLastError(feed: FeedInfo): boolean {
  if (feed.lastErrorCode === null) return false;
  if (feed.status === 'quarantined' || feed.status === 'dead') return true;
  if (feed.lastErrorAt === null) return false;
  return (
    feed.lastSuccessAt === null || Date.parse(feed.lastErrorAt) > Date.parse(feed.lastSuccessAt)
  );
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** "3 hours ago": the largest whole unit, rounded down; a time ahead of `now` counts as now. */
export function relativeTime(iso: string, language: string, now: number): string {
  const seconds = Math.min(0, Math.round((Date.parse(iso) - now) / 1000));
  const [unit, size] = UNITS.find(([, floor]) => -seconds >= floor) ?? (['second', 1] as const);
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(
    Math.trunc(seconds / size),
    unit,
  );
}

/** A calendar date in the reader's language and time zone, e.g. "Oct 1, 2026". */
export function formatDate(iso: string, language: string, timeZone: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
  }
}
