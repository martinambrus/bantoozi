import type { ExtractResult } from '@bantoozi/feeds';
import { describe, expect, it } from 'vitest';

import {
  hasRetriesLeft,
  isTransientPageFailure,
  TransientPageError,
} from '../src/handlers/transient.js';

function failed(error: string | null, overrides: Partial<ExtractResult> = {}): ExtractResult {
  return {
    status: 'failed',
    resolvedUrl: null,
    httpStatus: null,
    bodyText: null,
    bodyHtml: null,
    bodyLead: null,
    wordCount: null,
    completeness: 'partial',
    completenessReason: 'fetch_failed',
    canonicalUrl: null,
    error,
    deferUntil: null,
    ...overrides,
  } as ExtractResult;
}

describe('transient page failures (spec 03 §2.1, §8.5 step 3)', () => {
  it.each([
    'FEED_TIMEOUT',
    'FEED_DNS_ERROR',
    'FEED_CONNECTION_ERROR',
    'FEED_HTTP_500',
    'FEED_HTTP_502',
  ])('%s is transient', (code) => {
    expect(isTransientPageFailure(failed(code))).toBe(true);
  });

  it('an unreachable robots.txt is transient', () => {
    expect(isTransientPageFailure(failed('robots_unreachable', { status: 'blocked' }))).toBe(true);
  });

  it.each([
    'FEED_HTTP_404',
    'FEED_HTTP_410',
    'FEED_TLS_ERROR',
    'FEED_TOO_LARGE',
    'no_content',
    'robots_disallowed',
  ])('%s is a definite answer', (code) => {
    expect(isTransientPageFailure(failed(code))).toBe(false);
  });

  it('a success or a deferred cooldown is not a transient failure', () => {
    expect(isTransientPageFailure(failed(null, { status: 'ok' }))).toBe(false);
    expect(
      isTransientPageFailure(
        failed('FEED_HTTP_503', { deferUntil: new Date(Date.now() + 60_000) }),
      ),
    ).toBe(false);
  });

  it('retries remain only while pg-boss reports fewer retries than its limit', () => {
    expect(hasRetriesLeft({ queue: 'article.extract', jobId: 'j' })).toBe(false);
    expect(
      hasRetriesLeft({ queue: 'article.extract', jobId: 'j', retry: { count: 0, limit: 2 } }),
    ).toBe(true);
    expect(
      hasRetriesLeft({ queue: 'article.extract', jobId: 'j', retry: { count: 2, limit: 2 } }),
    ).toBe(false);
    expect(new TransientPageError('FEED_TIMEOUT').name).toBe('TransientPageError');
  });
});
