/** A server-requested delay is honoured for at most 24 hours (spec 03 §8.2, §9). */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// RFC 9110 §5.6.7: IMF-fixdate, plus the obsolete RFC 850 and asctime formats recipients accept.
const IMF_FIXDATE =
  /^(?:mon|tue|wed|thu|fri|sat|sun), (\d{2}) ([a-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) gmt$/i;
const RFC850_DATE =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday), (\d{2})-([a-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) gmt$/i;
const ASCTIME_DATE =
  /^(?:mon|tue|wed|thu|fri|sat|sun) ([a-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;

function utcMillis(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month === -1 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  const at = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
  // Reject impossible dates such as 31 Feb instead of letting Date roll them over.
  return new Date(at).getUTCDate() === day ? at : undefined;
}

/** Parses an HTTP-date (RFC 9110 §5.6.7) to epoch ms; undefined when it is not one. */
function parseHttpDate(value: string, nowMs: number): number | undefined {
  let match = IMF_FIXDATE.exec(value);
  if (match !== null) {
    const [day = '', month = '', year = '', hour = '', minute = '', second = ''] = match.slice(1);
    return utcMillis(
      Number(year),
      month,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }
  match = RFC850_DATE.exec(value);
  if (match !== null) {
    const [day = '', month = '', shortYear = '', hour = '', minute = '', second = ''] =
      match.slice(1);
    // A two-digit year more than 50 years ahead means the previous century (RFC 9110 §5.6.7).
    let year = 2000 + Number(shortYear);
    if (year > new Date(nowMs).getUTCFullYear() + 50) year -= 100;
    return utcMillis(year, month, Number(day), Number(hour), Number(minute), Number(second));
  }
  match = ASCTIME_DATE.exec(value);
  if (match !== null) {
    const [month = '', day = '', hour = '', minute = '', second = '', year = ''] = match.slice(1);
    return utcMillis(
      Number(year),
      month,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }
  return undefined;
}

/**
 * The instant a `Retry-After` header asks the client to wait for (spec 03 §8.2): delta-seconds or
 * an HTTP-date. Invalid values (negative, fractional, garbage, impossible dates) give undefined;
 * callers then apply their own default (at least 60 s for 429/503). The result is clamped to
 * `[now, now + 24 h]`: a date in the past means "now".
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): Date | undefined {
  if (value === undefined || !Number.isFinite(nowMs)) return undefined;
  const trimmed = value.trim();
  let at: number | undefined;
  if (/^\d+$/.test(trimmed)) {
    at = nowMs + Number(trimmed) * 1000;
  } else {
    at = parseHttpDate(trimmed, nowMs);
  }
  if (at === undefined || Number.isNaN(at)) return undefined;
  return new Date(Math.min(Math.max(at, nowMs), nowMs + MAX_RETRY_AFTER_MS));
}
