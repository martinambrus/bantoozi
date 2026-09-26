import type { ExtractResult } from '@bantoozi/feeds';

import type { JobContext } from './index.js';

/** Safe-client failures that a later attempt may not repeat (spec 03 §4 item 8). */
const TRANSIENT_FETCH_CODES: ReadonlySet<string> = new Set([
  'FEED_TIMEOUT',
  'FEED_DNS_ERROR',
  'FEED_CONNECTION_ERROR',
]);

/**
 * Whether a page extraction failed for a reason a later attempt may not repeat: a timeout, a DNS or
 * connection failure, a 5xx response, or an unreachable robots.txt. While the queue has retries
 * left, the handler throws instead of storing a terminal outcome, so pg-boss retries with its
 * backoff (spec 03 §2.1; bounded transient retries, §8.5 step 3); the last attempt stores the
 * terminal result. A cooling-down origin is deferred instead (`deferUntil`, §8.2), and definite
 * answers (4xx, non-HTML, a robots disallow, no readable content) are terminal at once.
 */
export function isTransientPageFailure(result: ExtractResult): boolean {
  if (result.deferUntil !== null || result.error === null) return false;
  if (TRANSIENT_FETCH_CODES.has(result.error) || result.error === 'robots_unreachable') return true;
  const http = /^FEED_HTTP_(\d{3})$/.exec(result.error);
  return http !== null && Number(http[1]) >= 500;
}

/** Thrown to make pg-boss retry a job after a transient page failure. */
export class TransientPageError extends Error {
  constructor(code: string) {
    super(`transient page failure (${code}); the queue retries the job`);
    this.name = 'TransientPageError';
  }
}

/** Whether pg-boss runs this job again if the handler throws now (absent retry data: never). */
export function hasRetriesLeft(context: JobContext): boolean {
  return context.retry !== undefined && context.retry.count < context.retry.limit;
}
