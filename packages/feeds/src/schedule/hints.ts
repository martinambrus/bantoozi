/**
 * Publisher schedule hints for the adaptive fetch interval (spec 03 §9): RSS `<ttl>`, the RSS 1.0
 * syndication module (`sy:updatePeriod` / `sy:updateFrequency`) and `Cache-Control: max-age`.
 * Hints only ever lengthen the interval; a missing or invalid hint counts as 0.
 */
export interface ScheduleHints {
  /** RSS `<ttl>`, in minutes; a non-finite, zero or negative value is ignored. */
  ttlMinutes?: number | null | undefined;
  /** `sy:updatePeriod`: `hourly`, `daily`, `weekly`, `monthly` or `yearly`. */
  syUpdatePeriod?: string | null | undefined;
  /** `sy:updateFrequency`: updates per period; absent means 1 (see {@link syPeriodSeconds}). */
  syUpdateFrequency?: number | null | undefined;
  /** `max-age` of the fetch response's `Cache-Control`, in seconds ({@link parseCacheMaxAge}). */
  cacheMaxAgeS?: number | null | undefined;
}

/** `Cache-Control: max-age` counts for at most 6 hours (spec 03 §9). */
const CACHE_HINT_CAP_S = 21_600;

/** RFC 9111 §1.2.2: a larger delta-seconds value is treated as 2^31. */
const DELTA_SECONDS_MAX = 2 ** 31;

/** Period durations; a month is 30 days and a year 365 days. */
const SY_PERIOD_S: ReadonlyMap<string, number> = new Map([
  ['hourly', 3_600],
  ['daily', 86_400],
  ['weekly', 604_800],
  ['monthly', 2_592_000],
  ['yearly', 31_536_000],
]);

/**
 * `sy_period_s` (spec 03 §9): the `sy:updatePeriod` duration divided by `sy:updateFrequency`, in
 * seconds. The period is matched case-insensitively after trimming. A missing frequency means 1,
 * the syndication module's default; a frequency that is present must be a finite number > 0
 * (a fractional one is taken as given). A missing or unknown period, or an invalid frequency,
 * gives `null` (no hint): the module's `daily` default for a missing period would turn a lone
 * frequency into a hint that slows the feed down, so it is not assumed.
 */
export function syPeriodSeconds(
  period: string | null | undefined,
  frequency: number | null | undefined,
): number | null {
  if (typeof period !== 'string') return null;
  const periodS = SY_PERIOD_S.get(period.trim().toLowerCase());
  if (periodS === undefined) return null;
  const perPeriod = frequency ?? 1;
  if (!Number.isFinite(perPeriod) || perPeriod <= 0) return null;
  return periodS / perPeriod;
}

/**
 * The `max-age` directive of a `Cache-Control` header value, in seconds (spec 03 §9). Directive
 * names are case-insensitive and quoted strings are respected (RFC 9111 §5.2). The value must be
 * delta-seconds (digits, optionally quoted); values beyond 2^31 count as 2^31. Returns `null` when
 * the header is absent, has no `max-age`, or the value is invalid (negative, fractional, empty).
 * Repeated `max-age` directives must agree; conflicting ones give `null` (RFC 9111 §4.2.1 lets a
 * cache treat the response as stale).
 */
export function parseCacheMaxAge(cacheControl: string | null | undefined): number | null {
  if (typeof cacheControl !== 'string') return null;
  let found = false;
  let result: number | null = null;
  for (const directive of splitDirectives(cacheControl)) {
    if (/^\s*([^\s=]+)/.exec(directive)?.[1]?.toLowerCase() !== 'max-age') continue;
    const match = /^\s*max-age\s*=\s*(?:(\d+)|"(\d+)")\s*$/i.exec(directive);
    const digits = match?.[1] ?? match?.[2];
    const seconds = digits === undefined ? null : Math.min(Number(digits), DELTA_SECONDS_MAX);
    if (found && seconds !== result) return null;
    found = true;
    result = seconds;
  }
  return result;
}

/** Splits a header value at commas outside quoted strings (backslash escapes honoured). */
function splitDirectives(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const c = header.charAt(i);
    if (quoted && c === '\\') {
      current += c + header.charAt(i + 1);
      i += 1;
    } else if (c === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      if (c === '"') quoted = !quoted;
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * `hint = min(MAX, max(ttl_s, sy_period_s, min(cache_max_age_s, 21_600)))` (spec 03 §9). Missing,
 * non-finite, zero and negative hints count as 0.
 */
export function scheduleHintS(hints: ScheduleHints | undefined, maxS: number): number {
  if (hints === undefined) return 0;
  const ttlS = positiveOrZero(hints.ttlMinutes) * 60;
  const syS = syPeriodSeconds(hints.syUpdatePeriod, hints.syUpdateFrequency) ?? 0;
  const cacheS = Math.min(positiveOrZero(hints.cacheMaxAgeS), CACHE_HINT_CAP_S);
  return Math.min(maxS, Math.max(ttlS, syS, cacheS));
}

function positiveOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
