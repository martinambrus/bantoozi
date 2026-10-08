import { QueryClient } from '@tanstack/react-query';

import { isApiError, isRetryable } from './errors.js';

const MAX_RETRIES = 2;
const BACKOFF_MS = 1000;
/** A longer Retry-After is not waited out in the background; the error reaches the screen. */
const MAX_RETRY_AFTER_MS = 30_000;

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || !isRetryable(error)) return false;
  return !isApiError(error) || (error.retryAfterMs ?? 0) <= MAX_RETRY_AFTER_MS;
}

/** Exponential backoff that never retries sooner than the server asked. */
function retryDelay(failureCount: number, error: unknown): number {
  const retryAfterMs = isApiError(error) ? (error.retryAfterMs ?? 0) : 0;
  return Math.max(BACKOFF_MS * 2 ** failureCount, retryAfterMs);
}

/**
 * Spec 09 §1: queries retry network failures, 5xx and 429 up to twice and nothing else; a mutation
 * is never retried automatically, because only its user knows whether the intent still stands. A
 * mutation does not wait for the connection either: without one it fails at once, where the
 * person sees it, instead of staying paused out of sight.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, retryDelay },
      mutations: { retry: false, networkMode: 'always' },
    },
  });
}
