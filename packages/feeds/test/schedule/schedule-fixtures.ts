import type { ScheduleFeed, ScheduleUpdate } from '../../src/schedule/index.js';
import { scheduleJitter } from '../../src/schedule/index.js';

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The fixed "now" of the unit tests. */
export const NOW = new Date('2026-03-10T12:00:00.000Z');

export function ago(ms: number, from: Date = NOW): Date {
  return new Date(from.getTime() - ms);
}

export function later(ms: number, from: Date = NOW): Date {
  return new Date(from.getTime() + ms);
}

/**
 * An established, healthy feed row (created 90 days ago, a new item 2 hours ago) with the
 * spec 02 defaults `fetch_interval_s = 900` and `min_interval_s = 900`.
 */
export function feedRow(overrides: Partial<ScheduleFeed> = {}): ScheduleFeed {
  return {
    id: '42',
    createdAt: ago(90 * DAY_MS),
    status: 'active',
    fetchIntervalS: 900,
    minIntervalS: 900,
    consecutiveErrors: 0,
    consecutiveEmpty: 0,
    quarantineCount: 0,
    totalFetches: 100,
    totalErrors: 3,
    totalEmpty: 40,
    lastNewItemAt: ago(2 * HOUR_MS),
    firstErrorAt: null,
    quarantinedUntil: null,
    lastSuccessAt: ago(15 * MINUTE_MS),
    lastErrorCode: 'HTTP_503',
    lastError: 'HTTP 503 Service Unavailable',
    lastErrorAt: ago(20 * DAY_MS),
    etag: '"e0"',
    lastModified: 'Tue, 10 Mar 2026 10:00:00 GMT',
    recentGapsS: [],
    ...overrides,
  };
}

/** Seconds from `now` to `update.nextFetchAt`. */
export function delayS(update: ScheduleUpdate, now: Date = NOW): number {
  return (update.nextFetchAt.getTime() - now.getTime()) / SECOND_MS;
}

/** The first feed ID (`'1'`, `'2'`, …) whose jitter on the UTC day of `now` satisfies `accept`. */
export function feedIdWithJitter(accept: (jitter: number) => boolean, now: Date = NOW): string {
  for (let id = 1; id <= 100_000; id += 1) {
    if (accept(scheduleJitter(String(id), now))) return String(id);
  }
  throw new Error('no feed ID with the requested jitter');
}
