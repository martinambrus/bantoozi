import type { CallStatus, EngineName } from '@bantoozi/shared';

/**
 * Retry policy of the engine router (spec 04 §4). The router is the single retry owner: adapters
 * make exactly one wire attempt and report whether it may be retried; the router decides whether
 * and when the next attempt of the same logical (sub)request is sent. All functions are pure except
 * {@link sleep}, which is timer based (fake-timer testable) and cancellable.
 */

/** Wire attempts per logical request (per subpack of a split LLM request), spec 04 §4. */
export const MAX_ATTEMPTS: Readonly<Record<EngineName, number>> = Object.freeze({
  typesafe: 4,
  llm: 2,
  laya: 1,
});

/** Base of the exponential backoff: the delay before attempt 2. */
export const RETRY_BASE_DELAY_MS = 500;
/** Symmetric jitter share of the backoff (±20 %). */
export const RETRY_JITTER = 0.2;
/** A logical (sub)request is retried after at most this many `invalid_response` attempts. */
export const MAX_INVALID_RESPONSE_RETRIES = 1;
/** Upper bound of a server-supplied `Retry-After` delay that the router honours (24 h). */
export const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * Delay before attempt `attempt` (n ≥ 2): `500 ms × 2^(n−2)` with ±20 % jitter drawn from `random`
 * (a uniform value in [0, 1); 0.5 means no jitter).
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 2) {
    throw new RangeError('attempt must be an integer of at least 2');
  }
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 2);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(base * (1 + (2 * r - 1) * RETRY_JITTER));
}

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

/** Final attempt statuses that are transient: 429, 5xx/network errors, timeouts, bad answers. */
export function isTransientStatus(status: Exclude<CallStatus, 'ok'>): boolean {
  return (
    status === 'error' ||
    status === 'timeout' ||
    status === 'rate_limited' ||
    status === 'invalid_response'
  );
}

export interface FailedAttemptInfo {
  engine: EngineName;
  /** Ordinal of the attempt that just failed within this logical (sub)request (1-based). */
  attempt: number;
  status: Exclude<CallStatus, 'ok'>;
  /** The adapter's verdict: false for permanent failures such as an unsupported model (404). */
  retryable: boolean;
  /** A valid server delay (`Retry-After`), already parsed by the adapter. */
  retryAfterMs?: number;
  /** `invalid_response` attempts already retried in this logical (sub)request. */
  invalidResponseRetries: number;
}

export type RetryDecision =
  { retry: true; delayMs: number } | { retry: false; reason: 'not_retryable' | 'exhausted' };

/**
 * Whether a failed attempt is followed by another one, and after which delay (spec 04 §4): retry
 * 429, 5xx, network errors and timeouts, and at most one `invalid_response`; never auth errors,
 * invalid requests or permanent failures. The delay is the jittered backoff before the next
 * attempt, but never sooner than a valid server delay. Cancellation is the caller's concern.
 */
export function decideRetry(info: FailedAttemptInfo, random: () => number): RetryDecision {
  if (!info.retryable || !isTransientStatus(info.status)) {
    return { retry: false, reason: 'not_retryable' };
  }
  if (
    info.status === 'invalid_response' &&
    info.invalidResponseRetries >= MAX_INVALID_RESPONSE_RETRIES
  ) {
    return { retry: false, reason: 'not_retryable' };
  }
  if (info.attempt >= MAX_ATTEMPTS[info.engine]) return { retry: false, reason: 'exhausted' };
  const backoff = backoffDelayMs(info.attempt + 1, random);
  const server =
    info.retryAfterMs !== undefined && Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0
      ? Math.min(info.retryAfterMs, MAX_RETRY_AFTER_MS)
      : 0;
  return { retry: true, delayMs: Math.max(backoff, server) };
}

/**
 * Wait `ms` milliseconds with `setTimeout` (so fake timers control it). Resolves `true` when the
 * time elapsed and `false` as soon as `signal` aborts (also when it was already aborted); the timer
 * and the abort listener are always removed.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
