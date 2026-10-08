const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, language: string, create: () => T): T {
  let format = cache.get(language);
  if (format === undefined) {
    format = create();
    cache.set(language, format);
  }
  return format;
}

/**
 * "2 hours ago" in the language of the UI. An unparsable date gives an empty string and one in the
 * future (a publisher's clock) counts as now.
 */
export function formatRelativeTime(iso: string, now: number, language: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const format = cached(
    relativeFormats,
    language,
    () => new Intl.RelativeTimeFormat(language, { numeric: 'auto' }),
  );
  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE_MS) return format.format(0, 'second');
  if (elapsed < HOUR_MS) return format.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
  if (elapsed < DAY_MS) return format.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 7) return format.format(-days, 'day');
  if (days < 30) return format.format(-Math.floor(days / 7), 'week');
  if (days < 365) return format.format(-Math.floor(days / 30), 'month');
  return format.format(-Math.floor(days / 365), 'year');
}

/** A probability with two decimals, "0.91" or "0,91" by language. */
export function formatProbability(p: number, language: string): string {
  return cached(
    numberFormats,
    language,
    () => new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ).format(p);
}

/** The day of a timestamp in the language of the UI; an unparsable date gives an empty string. */
export function formatDate(iso: string, language: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return cached(
    dateFormats,
    language,
    () => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }),
  ).format(time);
}
