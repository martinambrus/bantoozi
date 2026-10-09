/** The wait after the first failure; it doubles after each further one. */
const FIRST_MS = 2_000;
/** The longest wait the doubling reaches. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** A timer set for longer than this fires at once, so no wait is longer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long the page waits before it tries again, by itself, what the server refused for now while
 * the browser stays online (spec 09 §1): 2 s after the first failure, twice as long after each
 * further one up to five minutes, and never shorter than the server's Retry-After.
 */
export function retryLaterMs(failures: number, retryAfterMs: number | null | undefined): number {
  const backoff = Math.min(FIRST_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), MAX_TIMER_MS);
}
