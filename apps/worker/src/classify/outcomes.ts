import { nextUtcDay, type EngineOutcome } from '@bantoozi/engine';

/**
 * What a handler does with an engine outcome that is not ok (spec 05 §5.5 step 7, spec 04 §5):
 * - `no_demand`: a quiet cancellation of the unauthorized work, never a failure attempt;
 * - `invalid`: a permanent invalid request (a question-set bug): retained as exhausted and alerted;
 * - `defer`: service unavailability (budget, no key, open breaker, a `Retry-After` beyond the job
 *   deadline): due again at the next UTC budget day, the known retry time or the recovery interval,
 *   without spending a failure attempt or re-enqueueing a hot loop;
 * - `fail`: actual retry exhaustion: one failure attempt with exponential backoff.
 */

/** Recovery interval of deferred unavailability without a known retry time (spec 05 §5.5 step 7). */
export const RECOVERY_INTERVAL_MS = 10 * 60_000;

export type FailedOutcome = Extract<EngineOutcome, { ok: false }>;

export type FailureDisposition =
  | { kind: 'no_demand' }
  | { kind: 'invalid'; lastError: string }
  | { kind: 'defer'; nextAttemptAt: Date; lastError: string }
  | { kind: 'fail'; lastError: string };

export function failureDisposition(outcome: FailedOutcome, now: Date): FailureDisposition {
  // `last_error` keeps the reason code only: provider details stay in the bounded engine logs.
  const lastError = outcome.reason;
  switch (outcome.reason) {
    case 'no_demand':
      return { kind: 'no_demand' };
    case 'invalid_request':
      return { kind: 'invalid', lastError };
    case 'budget':
      return { kind: 'defer', nextAttemptAt: outcome.retryAt ?? nextUtcDay(now), lastError };
    case 'no_key':
    case 'circuit_open':
      return {
        kind: 'defer',
        nextAttemptAt: outcome.retryAt ?? new Date(now.getTime() + RECOVERY_INTERVAL_MS),
        lastError,
      };
    case 'error':
      return outcome.retryAt === undefined
        ? { kind: 'fail', lastError }
        : { kind: 'defer', nextAttemptAt: outcome.retryAt, lastError };
  }
}
