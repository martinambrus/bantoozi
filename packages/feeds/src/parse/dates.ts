/**
 * Feed date parsing (spec 03 §6 `published_at`). Deterministic and independent of the process time
 * zone: RFC 3339/ISO 8601 (W3C-DTF, Atom, JSON Feed, `dc:date`) and RFC 822/2822 (RSS `pubDate`)
 * are parsed explicitly; a date-time without a zone is read as UTC. V8's `Date.parse` is used only
 * as a last resort for strings that carry an explicit zone, because it reads zoneless strings in
 * local time (which is also why rss-parser's `isoDate` is not used).
 */

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:(?:t|\s+)(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(z|utc|gmt|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const ISO_YEAR_MONTH = /^(\d{4})(?:-(\d{2}))?$/;

/** `[weekday,] d mon yyyy hh:mm[:ss] [zone]`, tolerating dashes (RFC 850) and missing commas. */
const RFC_2822_DATE =
  /^(?:[^\d\s,]{1,20},?\s*)?(\d{1,2})[\s-]+([a-z]{3,10})\.?[\s-]+(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(.+))?$/i;
/** `weekday mon d [hh:mm[:ss]] yyyy`-like `Date#toString` output: `Mon Oct 05 2026 10:00:00 GMT+0200`. */
const JS_DATE =
  /^[a-z]{3,10},?\s+([a-z]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(.+))?$/i;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Zone abbreviations with a fixed offset in minutes: the RFC 822 set (CST is US Central), plus
 * common unambiguous European, Asian and Australian ones. Ambiguous names (`IST`) are not listed:
 * an unknown zone makes the date unknown rather than wrong.
 */
const ZONES: Readonly<Record<string, number>> = {
  z: 0,
  ut: 0,
  utc: 0,
  gmt: 0,
  wet: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
  akst: -540,
  akdt: -480,
  hst: -600,
  bst: 60,
  west: 60,
  cet: 60,
  cest: 120,
  met: 60,
  mest: 120,
  eet: 120,
  eest: 180,
  msk: 180,
  jst: 540,
  kst: 540,
  awst: 480,
  acst: 570,
  acdt: 630,
  aest: 600,
  aedt: 660,
  nzst: 720,
  nzdt: 780,
};

const MIN_TIME = Date.UTC(1000, 0, 1);
const MAX_TIME = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Offset in minutes of a zone designator, `undefined` when unknown. Military letters are UTC. */
function zoneOffset(zone: string | undefined): number | undefined {
  if (zone === undefined || zone.trim() === '') return 0;
  const value = zone.trim().toLowerCase();
  const named = ZONES[value];
  if (named !== undefined) return named;
  if (/^[a-ik-y]$/.test(value)) return 0; // RFC 5322 §4.3: military zones mean -0000
  // A numeric offset wins over a trailing abbreviation (`+0200 CEST`).
  const numeric = /^(?:gmt|utc|ut)?\s*([+-])(\d{1,2}):?(\d{2})?(?:\s+[a-z]{1,5})?$/.exec(value);
  if (numeric === null) return undefined;
  const hours = Number(numeric[2]);
  const minutes = Number(numeric[3] ?? '0');
  if (hours > 23 || minutes > 59) return undefined;
  return (numeric[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/** Builds a UTC timestamp, rejecting out-of-range fields (e.g. 30 February, 25:00). */
function utcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  offsetMinutes: number,
): number | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  date.setUTCHours(hour, minute, Math.min(second, 59), millisecond);
  const time = date.getTime() - offsetMinutes * 60_000;
  return time >= MIN_TIME && time <= MAX_TIME ? time : null;
}

/** `undefined` when the grammar does not match; `null` when it matches with invalid fields. */
type Parsed = number | null | undefined;

function parseIso(value: string): Parsed {
  const full = ISO_DATE.exec(value);
  if (full !== null) {
    const offset = zoneOffset(full[8]);
    if (offset === undefined) return null;
    const fraction = (full[7] ?? '').padEnd(3, '0').slice(0, 3);
    return utcTime(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] ?? '0'),
      Number(full[5] ?? '0'),
      Number(full[6] ?? '0'),
      Number(fraction),
      offset,
    );
  }
  const partial = ISO_YEAR_MONTH.exec(value);
  if (partial === null) return undefined;
  return utcTime(Number(partial[1]), Number(partial[2] ?? '1') - 1, 1, 0, 0, 0, 0, 0);
}

function rfcYear(digits: string): number {
  const year = Number(digits);
  if (digits.length === 4) return year;
  // RFC 5322 §4.3: 00–49 → 20xx, 50–99 and three digits → 19xx.
  return digits.length === 2 && year < 50 ? 2000 + year : 1900 + year;
}

function parseRfc(value: string): Parsed {
  const rfc = RFC_2822_DATE.exec(value);
  const js = rfc === null ? JS_DATE.exec(value) : null;
  const parts = rfc ?? js;
  if (parts === null) return undefined;
  const [dayText, monthText, yearText] =
    rfc === null ? [parts[2], parts[1], parts[3]] : [parts[1], parts[2], parts[3]];
  const month = MONTHS[(monthText ?? '').slice(0, 3).toLowerCase()];
  if (month === undefined || yearText === undefined) return null;
  const offset = zoneOffset(parts[7]);
  if (offset === undefined) return null;
  return utcTime(
    rfcYear(yearText),
    month,
    Number(dayText),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6] ?? '0'),
    0,
    offset,
  );
}

/** V8 fallback, only for strings with a four-digit year, a time and an explicit zone. */
function parseWithExplicitZone(value: string): number | null {
  if (!/\d{4}/.test(value) || !/\d{1,2}:\d{2}/.test(value)) return null;
  if (!/(?:\b(?:gmt|utc|ut|z)\b|[+-]\d{2}:?\d{2}\b)/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= MIN_TIME && time <= MAX_TIME ? time : null;
}

/**
 * Parses a feed date as a finite instant (spec 03 §6), or `null` when it is malformed. Accepts
 * RFC 3339/ISO 8601 (also `YYYY` and `YYYY-MM`, a space for `T`, and hour-only offsets), RFC 822/
 * 2822 with any weekday name, full or abbreviated English months, two-digit years and common zone
 * abbreviations, and a trailing `(comment)`. Missing zones mean UTC.
 */
export function parseFeedDate(input: string): Date | null {
  const value = input
    .trim()
    .replace(/\s*\([^()]*\)$/, '')
    .replace(/\s+/g, ' ');
  if (value === '' || value.length > 128) return null;
  // The V8 fallback only sees strings that match neither grammar: it would roll invalid fields
  // over (30 February → 2 March) instead of rejecting them.
  let time = parseIso(value);
  if (time === undefined) time = parseRfc(value);
  if (time === undefined) time = parseWithExplicitZone(value);
  return time === null ? null : new Date(time);
}
