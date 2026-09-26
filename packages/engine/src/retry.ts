/**
 * Retry timing of the engine (spec 04 §4): the adapters read a server's `Retry-After` here. The
 * router is the single retry owner and builds its retry policy on the same parser.
 */

/** Upper bound of a server-supplied `Retry-After` delay that the router honours (24 h). */
export const MAX_RETRY_AFTER_MS = 86_400_000;

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '\\d{2}:\\d{2}:\\d{2}';
/** RFC 9110 §5.6.7: IMF-fixdate, the obsolete RFC 850 form and asctime (which carries no zone). */
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} (?: \\d|\\d{2}) ${TIME} \\d{4}$`);

/**
 * Parse an HTTP `Retry-After` value (RFC 9110 §10.2.3): delay-seconds or an HTTP-date. Returns the
 * delay in milliseconds from `nowMs` (0 for a date in the past, at most {@link MAX_RETRY_AFTER_MS}),
 * or `undefined` when the value is absent or invalid. Only the three HTTP-date forms are accepted:
 * a lenient date parser would read values such as `5.5` as a calendar date.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds)
      ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
      : MAX_RETRY_AFTER_MS;
  }
  let at: number;
  if (IMF_FIXDATE.test(text) || RFC850_DATE.test(text)) at = Date.parse(text);
  else if (ASCTIME_DATE.test(text)) at = Date.parse(`${text} GMT`);
  else return undefined;
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}
