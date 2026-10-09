// The one place the web app formats moments: in the account's time zone (spec 02 §1).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Moment = string | number;
type Kind = 'dateTime' | 'date' | 'time';

const OPTIONS: Record<Kind, Intl.DateTimeFormatOptions> = {
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
  date: { dateStyle: 'medium' },
  time: { timeStyle: 'short' },
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  let format = cache.get(key);
  if (format === undefined) {
    format = create();
    cache.set(key, format);
  }
  return format;
}

function print(kind: Kind, value: Moment, language: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return cached(dateFormats, `${kind}|${language}|${timeZone}`, () => {
    try {
      return new Intl.DateTimeFormat(language, { ...OPTIONS[kind], timeZone });
    } catch {
      // A time zone this browser does not know: the device's own is better than a broken page.
      return new Intl.DateTimeFormat(language, OPTIONS[kind]);
    }
  }).format(date);
}

/** "Oct 8, 2026, 11:00 AM" for an ISO string or milliseconds; '' when it does not parse. */
export function formatDateTime(value: Moment, language: string, timeZone: string): string {
  return print('dateTime', value, language, timeZone);
}

/** "Oct 8, 2026"; '' when the moment does not parse. */
export function formatDate(value: Moment, language: string, timeZone: string): string {
  return print('date', value, language, timeZone);
}

/** "11:00 AM"; '' when the moment does not parse. */
export function formatTime(value: Moment, language: string, timeZone: string): string {
  return print('time', value, language, timeZone);
}

/** "2 hours ago"; '' for a date that does not parse, and a date in the future counts as now. */
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
