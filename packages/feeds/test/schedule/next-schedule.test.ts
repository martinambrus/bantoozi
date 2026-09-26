import { describe, expect, it } from 'vitest';

import type {
  FetchOutcome,
  ScheduleFeed,
  ScheduleHints,
  ScheduleUpdate,
} from '../../src/schedule/index.js';
import { nextSchedule, scheduleJitter } from '../../src/schedule/index.js';
import {
  DAY_MS,
  HOUR_MS,
  NOW,
  ago,
  delayS,
  feedIdWithJitter,
  feedRow,
  later,
} from './schedule-fixtures.js';

type ErrorOutcome = Extract<FetchOutcome, { kind: 'error' }>;

function success(nNew: number, etag: string | null = '"e1"', lastModified: string | null = null) {
  return { kind: 'success', nNew, etag, lastModified } satisfies FetchOutcome;
}

const NOT_MODIFIED = { kind: 'not_modified' } satisfies FetchOutcome;

function failure(extra: Partial<Omit<ErrorOutcome, 'kind'>> = {}): ErrorOutcome {
  return { kind: 'error', code: 'HTTP_503', message: 'HTTP 503 Service Unavailable', ...extra };
}

function schedule(
  overrides: Partial<ScheduleFeed>,
  outcome: FetchOutcome,
  hints?: ScheduleHints,
): ScheduleUpdate {
  return nextSchedule(feedRow(overrides), outcome, NOW, hints);
}

/** Jitter well away from zero on the UTC day of `NOW`, so clamping after jitter is visible. */
const JITTER_DOWN_ID = feedIdWithJitter((j) => j < -0.05);
const JITTER_UP_ID = feedIdWithJitter((j) => j > 0.05);

describe('nextSchedule after new items (spec 03 §9)', () => {
  it.each([
    [1, 3600],
    [2, 2700],
    [4, 2700],
    [5, 1800],
    [200, 1800],
  ])('n_new = %i turns a 3,600 s interval into %i s', (nNew, expected) => {
    expect(schedule({ fetchIntervalS: 3600 }, success(nNew)).fetchIntervalS).toBe(expected);
  });

  it('resets the empty streak and records the new item', () => {
    const update = schedule({ consecutiveEmpty: 7, totalEmpty: 40 }, success(3));
    expect(update).toMatchObject({ consecutiveEmpty: 0, totalEmpty: 40, lastNewItemAt: NOW });
  });

  it('rounds the interval to whole minutes', () => {
    const feed = { minIntervalS: 300, fetchIntervalS: 1000 };
    expect(schedule(feed, success(1)).fetchIntervalS).toBe(1020);
    expect(schedule(feed, success(2)).fetchIntervalS).toBe(780);
    expect(schedule(feed, success(5)).fetchIntervalS).toBe(480);
  });

  it('never goes below MIN (min_interval_s)', () => {
    expect(schedule({ fetchIntervalS: 900 }, success(50)).fetchIntervalS).toBe(900);
    expect(schedule({ minIntervalS: 1800, fetchIntervalS: 1800 }, success(9)).fetchIntervalS).toBe(
      1800,
    );
  });

  it('never goes below 300 s, whatever min_interval_s says', () => {
    const feed = { id: JITTER_DOWN_ID, minIntervalS: 60, fetchIntervalS: 300 };
    const update = schedule(feed, success(5));
    expect(update.fetchIntervalS).toBe(300);
    expect(delayS(update)).toBe(300);
  });
});

describe('nextSchedule after an empty fetch (spec 03 §9)', () => {
  it.each([
    [900, 1200],
    [1500, 1800],
    [1510, 1800],
    [3000, 3600],
    [10_000, 12_000],
  ])('grows %i s by max(300, 20 %%) to %i s', (fetchIntervalS, expected) => {
    expect(schedule({ fetchIntervalS }, success(0)).fetchIntervalS).toBe(expected);
  });

  it('counts the empty fetch and keeps the last new item', () => {
    const lastNewItemAt = ago(3 * HOUR_MS);
    const update = schedule({ consecutiveEmpty: 2, totalEmpty: 40, lastNewItemAt }, success(0));
    expect(update).toMatchObject({ consecutiveEmpty: 3, totalEmpty: 41, lastNewItemAt });
  });

  it('treats a valid 304 as an empty success', () => {
    const update = schedule({ consecutiveEmpty: 2, totalEmpty: 40 }, NOT_MODIFIED);
    expect(update).toMatchObject({
      status: 'active',
      fetchIntervalS: 1200,
      consecutiveEmpty: 3,
      totalEmpty: 41,
      lastSuccessAt: NOW,
    });
  });

  it('never goes above MAX = 24 h while the feed is active', () => {
    const update = schedule({ id: JITTER_UP_ID, fetchIntervalS: 80_000 }, NOT_MODIFIED);
    expect(update.fetchIntervalS).toBe(86_400);
    expect(delayS(update)).toBe(86_400);
  });
});

describe('nextSchedule publisher hints (spec 03 §9)', () => {
  it.each<[string, ScheduleHints, number]>([
    ['a TTL', { ttlMinutes: 120 }, 7200],
    ['sy:updatePeriod/Frequency', { syUpdatePeriod: 'daily', syUpdateFrequency: 2 }, 43_200],
    ['sy:updatePeriod without a frequency', { syUpdatePeriod: 'hourly' }, 3600],
    ['Cache-Control max-age', { cacheMaxAgeS: 3600 }, 3600],
    ['max-age capped at 6 hours', { cacheMaxAgeS: 100_000 }, 21_600],
    [
      'the largest hint',
      { ttlMinutes: 90, syUpdatePeriod: 'hourly', cacheMaxAgeS: 30_000 },
      21_600,
    ],
    ['a TTL above the max-age cap', { ttlMinutes: 600, cacheMaxAgeS: 30_000 }, 36_000],
  ])('uses %s as a floor', (_label, hints, expected) => {
    const update = schedule({}, NOT_MODIFIED, hints);
    expect(update.fetchIntervalS).toBe(expected);
    expect(delayS(update)).toBeGreaterThanOrEqual(expected);
  });

  it.each<[string, ScheduleHints]>([
    ['no hints', {}],
    ['a negative TTL', { ttlMinutes: -5 }],
    ['a zero TTL', { ttlMinutes: 0 }],
    ['a NaN TTL', { ttlMinutes: Number.NaN }],
    ['an infinite TTL', { ttlMinutes: Number.POSITIVE_INFINITY }],
    ['null hints', { ttlMinutes: null, syUpdatePeriod: null, cacheMaxAgeS: null }],
    ['an unknown period', { syUpdatePeriod: 'fortnightly', syUpdateFrequency: 1 }],
    ['a zero frequency', { syUpdatePeriod: 'daily', syUpdateFrequency: 0 }],
    ['a negative frequency', { syUpdatePeriod: 'daily', syUpdateFrequency: -2 }],
    ['a NaN frequency', { syUpdatePeriod: 'daily', syUpdateFrequency: Number.NaN }],
    ['a frequency without a period', { syUpdateFrequency: 1 }],
    ['a negative max-age', { cacheMaxAgeS: -1 }],
    ['a NaN max-age', { cacheMaxAgeS: Number.NaN }],
  ])('ignores %s', (_label, hints) => {
    expect(schedule({}, NOT_MODIFIED, hints).fetchIntervalS).toBe(1200);
  });

  it('is a floor, not a cap', () => {
    expect(
      schedule({ fetchIntervalS: 20_000 }, NOT_MODIFIED, { ttlMinutes: 60 }).fetchIntervalS,
    ).toBe(24_000);
  });

  it('is capped by MAX', () => {
    const update = schedule({}, NOT_MODIFIED, { ttlMinutes: 2880 });
    expect(update.fetchIntervalS).toBe(86_400);
    expect(delayS(update)).toBe(86_400);
    const quiet = { lastNewItemAt: ago(40 * DAY_MS) };
    expect(schedule(quiet, NOT_MODIFIED, { ttlMinutes: 2880 }).fetchIntervalS).toBe(172_800);
    expect(schedule(quiet, NOT_MODIFIED, { syUpdatePeriod: 'yearly' }).fetchIntervalS).toBe(
      864_000,
    );
  });

  it('is a floor for the jittered delay too', () => {
    const hints = { ttlMinutes: 120 };
    const down = schedule({ id: JITTER_DOWN_ID }, NOT_MODIFIED, hints);
    expect(down.fetchIntervalS).toBe(7200);
    expect(delayS(down)).toBe(7200);
    const up = schedule({ id: JITTER_UP_ID }, NOT_MODIFIED, hints);
    expect(delayS(up)).toBeGreaterThan(7200);
    expect(delayS(up)).toBeLessThanOrEqual(7920);
  });
});

describe('nextSchedule median publication gap cap (spec 03 §9)', () => {
  const DAILY_GAPS = [86_400, 86_400, 86_400, 86_400, 86_400];

  it('caps the interval at half the median gap while the last new item is recent', () => {
    expect(
      schedule({ fetchIntervalS: 40_000, recentGapsS: DAILY_GAPS }, NOT_MODIFIED),
    ).toMatchObject({ fetchIntervalS: 43_200 });
  });

  it('needs at least 5 gaps', () => {
    const recentGapsS = DAILY_GAPS.slice(0, 4);
    expect(schedule({ fetchIntervalS: 40_000, recentGapsS }, NOT_MODIFIED).fetchIntervalS).toBe(
      48_000,
    );
  });

  it('ignores zero, negative and non-finite gaps', () => {
    const invalid = [0, -5, Number.NaN, Number.POSITIVE_INFINITY];
    const fourValid = {
      fetchIntervalS: 40_000,
      recentGapsS: [...DAILY_GAPS.slice(0, 4), ...invalid],
    };
    expect(schedule(fourValid, NOT_MODIFIED).fetchIntervalS).toBe(48_000);
    const fiveValid = { fetchIntervalS: 40_000, recentGapsS: [...invalid, ...DAILY_GAPS] };
    expect(schedule(fiveValid, NOT_MODIFIED).fetchIntervalS).toBe(43_200);
  });

  it('applies only while the last new item is less than 7 days old', () => {
    const feed = { fetchIntervalS: 40_000, recentGapsS: DAILY_GAPS };
    const fresh = { ...feed, lastNewItemAt: ago(7 * DAY_MS - 1) };
    expect(schedule(fresh, NOT_MODIFIED).fetchIntervalS).toBe(43_200);
    const stale = { ...feed, lastNewItemAt: ago(7 * DAY_MS) };
    expect(schedule(stale, NOT_MODIFIED).fetchIntervalS).toBe(48_000);
    const never = { ...feed, lastNewItemAt: null };
    expect(schedule(never, NOT_MODIFIED).fetchIntervalS).toBe(48_000);
  });

  it('counts a new item of this fetch as recent', () => {
    const feed = {
      fetchIntervalS: 60_000,
      recentGapsS: DAILY_GAPS,
      lastNewItemAt: ago(10 * DAY_MS),
    };
    expect(schedule(feed, success(1)).fetchIntervalS).toBe(43_200);
    expect(schedule(feed, NOT_MODIFIED).fetchIntervalS).toBe(72_000);
  });

  it('uses the median of an odd count, in any order', () => {
    const recentGapsS = [7200, 600, 3600, 1800, 5400];
    expect(schedule({ fetchIntervalS: 10_000, recentGapsS }, NOT_MODIFIED).fetchIntervalS).toBe(
      1800,
    );
  });

  it('uses the mean of the middle pair for an even count', () => {
    const recentGapsS = [4000, 1000, 6000, 3000, 2000, 5000];
    // median 3,500 → cap 1,750 → rounded to 1,740
    expect(schedule({ fetchIntervalS: 10_000, recentGapsS }, NOT_MODIFIED).fetchIntervalS).toBe(
      1740,
    );
  });

  it('never caps below MIN', () => {
    const recentGapsS = [600, 600, 600, 600, 600];
    expect(schedule({ fetchIntervalS: 10_000, recentGapsS }, NOT_MODIFIED).fetchIntervalS).toBe(
      900,
    );
  });

  it('never raises the interval', () => {
    expect(schedule({ recentGapsS: DAILY_GAPS }, NOT_MODIFIED).fetchIntervalS).toBe(1200);
  });

  it('yields to a publisher hint', () => {
    const recentGapsS = [600, 600, 600, 600, 600];
    expect(
      schedule({ fetchIntervalS: 10_000, recentGapsS }, NOT_MODIFIED, { ttlMinutes: 60 })
        .fetchIntervalS,
    ).toBe(3600);
  });
});

describe('nextSchedule MAX (spec 03 §9)', () => {
  const QUIET_EDGE = 30 * DAY_MS;

  it('switches from 24 h to 10 days after exactly 30 days without a new item', () => {
    const feed = { fetchIntervalS: 800_000 };
    const recent = { ...feed, lastNewItemAt: ago(QUIET_EDGE - 1) };
    expect(schedule(recent, NOT_MODIFIED).fetchIntervalS).toBe(86_400);
    const quiet = { ...feed, lastNewItemAt: ago(QUIET_EDGE) };
    expect(schedule(quiet, NOT_MODIFIED).fetchIntervalS).toBe(864_000);
  });

  it('keeps 24 h for a feed without new items until it is 30 days old', () => {
    const feed = { fetchIntervalS: 800_000, lastNewItemAt: null };
    const young = { ...feed, createdAt: ago(QUIET_EDGE - 1) };
    expect(schedule(young, NOT_MODIFIED).fetchIntervalS).toBe(86_400);
    const old = { ...feed, createdAt: ago(QUIET_EDGE) };
    expect(schedule(old, NOT_MODIFIED).fetchIntervalS).toBe(864_000);
  });

  it('keeps 24 h for a young feed whatever its last new item', () => {
    const feed = {
      fetchIntervalS: 800_000,
      createdAt: ago(DAY_MS),
      lastNewItemAt: ago(60 * DAY_MS),
    };
    expect(schedule(feed, NOT_MODIFIED).fetchIntervalS).toBe(86_400);
  });

  it('returns to 24 h as soon as a quiet feed publishes again', () => {
    const feed = { fetchIntervalS: 864_000, lastNewItemAt: ago(40 * DAY_MS) };
    const update = schedule(feed, success(1));
    expect(update.fetchIntervalS).toBe(86_400);
    expect(delayS(update)).toBeLessThanOrEqual(86_400);
  });

  it('is never exceeded by jitter', () => {
    const quiet = { id: JITTER_UP_ID, fetchIntervalS: 864_000, lastNewItemAt: ago(40 * DAY_MS) };
    expect(delayS(schedule(quiet, NOT_MODIFIED))).toBe(864_000);
    const active = { id: JITTER_UP_ID, fetchIntervalS: 86_400 };
    expect(delayS(schedule(active, NOT_MODIFIED))).toBe(86_400);
  });

  it('wins over a min_interval_s above it (no plan allows one)', () => {
    const update = schedule({ id: JITTER_UP_ID, minIntervalS: 100_000 }, success(1));
    expect(update.fetchIntervalS).toBe(86_400);
    expect(delayS(update)).toBe(86_400);
  });
});

describe('nextSchedule jitter (spec 03 §9, §13)', () => {
  it('stores the interval before jitter', () => {
    const down = schedule({ id: JITTER_DOWN_ID, fetchIntervalS: 3600 }, success(1));
    const up = schedule({ id: JITTER_UP_ID, fetchIntervalS: 3600 }, success(1));
    expect(down.fetchIntervalS).toBe(3600);
    expect(up.fetchIntervalS).toBe(3600);
    const jitterDown = scheduleJitter(JITTER_DOWN_ID, NOW);
    const jitterUp = scheduleJitter(JITTER_UP_ID, NOW);
    expect(delayS(down)).toBeCloseTo(3600 * (1 + jitterDown), 2);
    expect(delayS(up)).toBeCloseTo(3600 * (1 + jitterUp), 2);
    expect(delayS(down)).toBeLessThan(3600);
    expect(delayS(up)).toBeGreaterThan(3600);
  });

  it('never schedules before MIN', () => {
    const update = schedule({ id: JITTER_DOWN_ID }, success(10));
    expect(update.fetchIntervalS).toBe(900);
    expect(delayS(update)).toBe(900);
  });

  it('keeps every delay within [max(MIN, hint), MAX] and ±10 % of the stored interval', () => {
    const cases: [Partial<ScheduleFeed>, FetchOutcome, ScheduleHints | undefined][] = [
      [{}, success(10), undefined],
      [{ fetchIntervalS: 5000 }, success(1), undefined],
      [{ fetchIntervalS: 86_400 }, NOT_MODIFIED, undefined],
      [{}, NOT_MODIFIED, { ttlMinutes: 120 }],
      [{ minIntervalS: 300, fetchIntervalS: 300 }, success(1), { cacheMaxAgeS: 400 }],
      [{ fetchIntervalS: 800_000, lastNewItemAt: ago(45 * DAY_MS) }, NOT_MODIFIED, undefined],
    ];
    for (let id = 1; id <= 200; id += 1) {
      for (const [overrides, outcome, hints] of cases) {
        const feed = feedRow({ ...overrides, id: String(id) });
        const update = nextSchedule(feed, outcome, NOW, hints);
        const min = Math.max(
          feed.minIntervalS,
          (hints?.ttlMinutes ?? 0) * 60,
          hints?.cacheMaxAgeS ?? 0,
        );
        const max =
          feed.lastNewItemAt !== null && feed.lastNewItemAt < ago(30 * DAY_MS) ? 864_000 : 86_400;
        const delay = delayS(update);
        expect(delay).toBeGreaterThanOrEqual(min);
        expect(delay).toBeLessThanOrEqual(max);
        expect(Math.abs(delay - update.fetchIntervalS)).toBeLessThanOrEqual(
          update.fetchIntervalS * 0.1 + 0.001,
        );
      }
    }
  });

  it('does not change the stored interval between feeds', () => {
    const a = schedule({ id: JITTER_DOWN_ID, fetchIntervalS: 5000 }, NOT_MODIFIED);
    const b = schedule({ id: JITTER_UP_ID, fetchIntervalS: 5000 }, NOT_MODIFIED);
    expect(a.fetchIntervalS).toBe(b.fetchIntervalS);
    expect(a.nextFetchAt.getTime()).not.toBe(b.nextFetchAt.getTime());
  });
});

describe('nextSchedule input guards', () => {
  it('falls back to the 900 s default for a non-finite min_interval_s', () => {
    expect(schedule({ minIntervalS: Number.NaN }, success(10)).fetchIntervalS).toBe(900);
  });

  it('rounds a fractional min_interval_s up to whole seconds', () => {
    expect(schedule({ minIntervalS: 1000.5 }, success(10)).fetchIntervalS).toBe(1001);
  });

  it.each([0, -5, Number.NaN])(
    'restarts from MIN for a stored interval of %s',
    (fetchIntervalS) => {
      expect(schedule({ fetchIntervalS }, NOT_MODIFIED).fetchIntervalS).toBe(1200);
    },
  );

  it('rejects an invalid now', () => {
    expect(() => nextSchedule(feedRow(), NOT_MODIFIED, new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('nextSchedule success bookkeeping (spec 03 §9)', () => {
  const QUARANTINED: Partial<ScheduleFeed> = {
    status: 'quarantined',
    consecutiveErrors: 12,
    firstErrorAt: ago(10 * DAY_MS),
    quarantineCount: 3,
    quarantinedUntil: NOW,
    lastSuccessAt: ago(10 * DAY_MS),
    lastErrorCode: 'FEED_PARSE_ERROR',
    lastError: 'invalid XML',
    lastErrorAt: ago(8 * DAY_MS),
  };

  it.each<[string, FetchOutcome]>([
    ['a parsed 200', success(2)],
    ['a valid 304', NOT_MODIFIED],
  ])('%s ends the error streak and the quarantine', (_label, outcome) => {
    const update = schedule(QUARANTINED, outcome);
    expect(update).toMatchObject({
      status: 'active',
      consecutiveErrors: 0,
      firstErrorAt: null,
      quarantineCount: 0,
      quarantinedUntil: null,
      lastSuccessAt: NOW,
      totalErrors: 3,
      totalFetches: 101,
      lastFetchAt: NOW,
    });
  });

  it('keeps the last error for comparison with last_success_at', () => {
    expect(schedule(QUARANTINED, success(2))).toMatchObject({
      lastErrorCode: 'FEED_PARSE_ERROR',
      lastError: 'invalid XML',
      lastErrorAt: QUARANTINED.lastErrorAt,
    });
  });
});

describe('nextSchedule validators (spec 03 §9)', () => {
  const STORED = { etag: '"e0"', lastModified: 'Mon, 09 Mar 2026 10:00:00 GMT' };
  const LM1 = 'Tue, 10 Mar 2026 11:00:00 GMT';

  it.each<[string, FetchOutcome, { etag: string | null; lastModified: string | null }]>([
    ['a parsed 200 replaces both', success(1, '"e1"', LM1), { etag: '"e1"', lastModified: LM1 }],
    [
      'a parsed 200 clears an absent Last-Modified',
      success(0, '"e1"'),
      { etag: '"e1"', lastModified: null },
    ],
    [
      'a parsed 200 clears an absent ETag',
      success(0, null, LM1),
      { etag: null, lastModified: LM1 },
    ],
    [
      'a parsed 200 without validators clears both',
      success(0, null),
      { etag: null, lastModified: null },
    ],
    ['a 304 without validators keeps both', NOT_MODIFIED, STORED],
    [
      'a parsed 200 treats empty validators as absent',
      success(0, '', ' '),
      { etag: null, lastModified: null },
    ],
    [
      'a 304 keeps null validators',
      { kind: 'not_modified', etag: null, lastModified: null },
      STORED,
    ],
    [
      'a 304 keeps empty validators',
      { kind: 'not_modified', etag: '', lastModified: '  ' },
      STORED,
    ],
    [
      'a 304 updates a returned ETag',
      { kind: 'not_modified', etag: '"e1"' },
      { etag: '"e1"', lastModified: STORED.lastModified },
    ],
    [
      'a 304 updates a returned Last-Modified',
      { kind: 'not_modified', lastModified: LM1 },
      { etag: STORED.etag, lastModified: LM1 },
    ],
    [
      'a parse error of a 200 never installs validators',
      failure({ code: 'FEED_PARSE_ERROR', message: 'invalid XML', httpStatus: 200 }),
      STORED,
    ],
    ['an HTTP error keeps both', failure({ httpStatus: 500 }), STORED],
  ])('%s', (_label, outcome, expected) => {
    expect(schedule(STORED, outcome)).toMatchObject(expected);
  });
});

describe('nextSchedule error backoff (spec 03 §9)', () => {
  it.each([
    [0, 900],
    [1, 1800],
    [2, 3600],
    [3, 7200],
    [4, 14_400],
    [5, 28_800],
    [6, 57_600],
    [7, 86_400],
    [8, 86_400],
  ])('after %i earlier errors backs off %i s', (consecutiveErrors, expected) => {
    const update = schedule({ consecutiveErrors, firstErrorAt: ago(HOUR_MS) }, failure());
    expect(update.consecutiveErrors).toBe(consecutiveErrors + 1);
    expect(update.status).toBe('active');
    expect(delayS(update)).toBe(expected);
  });

  it('doubles from MIN', () => {
    expect(delayS(schedule({ minIntervalS: 300 }, failure()))).toBe(300);
    expect(delayS(schedule({ minIntervalS: 300, consecutiveErrors: 8 }, failure()))).toBe(76_800);
  });

  it('applies no jitter', () => {
    const down = schedule({ id: JITTER_DOWN_ID, consecutiveErrors: 3 }, failure());
    const up = schedule({ id: JITTER_UP_ID, consecutiveErrors: 3 }, failure());
    expect(delayS(down)).toBe(7200);
    expect(delayS(up)).toBe(7200);
  });

  it('stays finite and capped for a very long streak', () => {
    const update = schedule({ status: 'paused', consecutiveErrors: 5000 }, failure());
    expect(delayS(update)).toBe(86_400);
  });

  it.each([
    [3600, 3600],
    [600, 900],
    [0, 900],
    [200_000, 86_400],
    [Number.POSITIVE_INFINITY, 86_400],
    [-30, 900],
    [Number.NaN, 900],
  ])('with Retry-After %s s on the first error waits %i s', (retryAfterS, expected) => {
    expect(delayS(schedule({}, failure({ httpStatus: 429, retryAfterS })))).toBe(expected);
  });

  it('never lets Retry-After shorten the backoff', () => {
    expect(delayS(schedule({ consecutiveErrors: 5 }, failure({ retryAfterS: 3600 })))).toBe(28_800);
    expect(delayS(schedule({ consecutiveErrors: 8 }, failure({ retryAfterS: 100_000 })))).toBe(
      86_400,
    );
  });

  it('records the error without touching the success state', () => {
    const lastSuccessAt = ago(2 * HOUR_MS);
    const lastNewItemAt = ago(3 * HOUR_MS);
    const feed = {
      fetchIntervalS: 123_456,
      consecutiveEmpty: 4,
      totalEmpty: 40,
      lastSuccessAt,
      lastNewItemAt,
    };
    const update = schedule(
      feed,
      failure({ code: 'HTTP_500', message: 'HTTP 500', httpStatus: 500 }),
    );
    expect(update).toMatchObject({
      status: 'active',
      fetchIntervalS: 123_456,
      consecutiveErrors: 1,
      consecutiveEmpty: 4,
      totalEmpty: 40,
      totalErrors: 4,
      totalFetches: 101,
      lastFetchAt: NOW,
      lastSuccessAt,
      lastNewItemAt,
      firstErrorAt: NOW,
      lastErrorCode: 'HTTP_500',
      lastError: 'HTTP 500',
      lastErrorAt: NOW,
      quarantineCount: 0,
      quarantinedUntil: null,
    });
  });

  it('keeps the start of an ongoing error streak', () => {
    const firstErrorAt = ago(5 * HOUR_MS);
    expect(schedule({ consecutiveErrors: 4, firstErrorAt }, failure()).firstErrorAt).toBe(
      firstErrorAt,
    );
  });
});

describe('nextSchedule 410 Gone (spec 03 §9, §13)', () => {
  const GONE = failure({ code: 'HTTP_410', message: 'HTTP 410 Gone', httpStatus: 410 });

  it('marks the feed dead at once', () => {
    const update = schedule({}, GONE);
    expect(update).toMatchObject({
      status: 'dead',
      consecutiveErrors: 1,
      totalErrors: 4,
      lastErrorCode: 'HTTP_410',
      quarantineCount: 0,
      quarantinedUntil: null,
    });
    expect(delayS(update)).toBe(900);
  });

  it('is never overwritten with quarantined', () => {
    const update = schedule({ consecutiveErrors: 9, firstErrorAt: ago(4 * DAY_MS) }, GONE);
    expect(update).toMatchObject({ status: 'dead', quarantineCount: 0, quarantinedUntil: null });
  });

  it('kills a quarantined feed without extending its quarantine', () => {
    const quarantinedUntil = later(DAY_MS);
    const feed = {
      status: 'quarantined' as const,
      consecutiveErrors: 11,
      quarantineCount: 2,
      quarantinedUntil,
    };
    expect(schedule(feed, GONE)).toMatchObject({
      status: 'dead',
      quarantineCount: 2,
      quarantinedUntil,
    });
  });

  it('stays dead whatever comes next', () => {
    const dead = { status: 'dead' as const, consecutiveErrors: 12, firstErrorAt: ago(5 * DAY_MS) };
    expect(schedule(dead, GONE).status).toBe('dead');
    expect(schedule(dead, failure())).toMatchObject({ status: 'dead', quarantineCount: 0 });
    expect(schedule(dead, success(3)).status).toBe('dead');
    expect(schedule(dead, NOT_MODIFIED).status).toBe('dead');
  });
});

describe('nextSchedule paused feeds (spec 03 §3)', () => {
  it('keeps them paused and never quarantines them', () => {
    const paused = {
      status: 'paused' as const,
      consecutiveErrors: 20,
      firstErrorAt: ago(40 * DAY_MS),
    };
    expect(schedule(paused, failure())).toMatchObject({ status: 'paused', quarantineCount: 0 });
    expect(schedule(paused, failure({ httpStatus: 410 })).status).toBe('paused');
    expect(schedule(paused, success(1))).toMatchObject({ status: 'paused', consecutiveErrors: 0 });
  });
});

describe('nextSchedule quarantine (spec 03 §9, §3)', () => {
  it('waits for the 10th consecutive error', () => {
    const update = schedule({ consecutiveErrors: 8, firstErrorAt: ago(2 * DAY_MS) }, failure());
    expect(update).toMatchObject({ status: 'active', consecutiveErrors: 9, quarantineCount: 0 });
    expect(delayS(update)).toBe(86_400);
  });

  it('quarantines at the 10th consecutive error and fetches again at quarantined_until', () => {
    const update = schedule({ consecutiveErrors: 9, firstErrorAt: ago(3 * DAY_MS) }, failure());
    expect(update).toMatchObject({
      status: 'quarantined',
      consecutiveErrors: 10,
      quarantineCount: 1,
      quarantinedUntil: later(2 * DAY_MS),
      nextFetchAt: later(2 * DAY_MS),
    });
  });

  it('is not shortened or extended by Retry-After', () => {
    const feed = { consecutiveErrors: 9, firstErrorAt: ago(3 * DAY_MS) };
    const update = schedule(feed, failure({ httpStatus: 503, retryAfterS: 3600 }));
    expect(update.nextFetchAt).toEqual(later(2 * DAY_MS));
  });

  it.each([
    [0, 2],
    [1, 4],
    [2, 8],
    [3, 16],
    [4, 16],
    [50, 16],
  ])('after %i quarantines lasts %i days (capped at 16)', (quarantineCount, days) => {
    const feed = {
      status: 'quarantined' as const,
      consecutiveErrors: 10 + quarantineCount,
      quarantineCount,
      firstErrorAt: ago(3 * DAY_MS),
    };
    const update = schedule(feed, failure());
    expect(update).toMatchObject({
      status: 'quarantined',
      quarantineCount: quarantineCount + 1,
      quarantinedUntil: later(days * DAY_MS),
      nextFetchAt: later(days * DAY_MS),
    });
  });
});

describe('nextSchedule 30-day error streak (spec 03 §9)', () => {
  it('marks the feed dead after exactly 30 days of errors', () => {
    const feed = { status: 'quarantined' as const, consecutiveErrors: 13, quarantineCount: 3 };
    const dying = schedule({ ...feed, firstErrorAt: ago(30 * DAY_MS) }, failure());
    expect(dying.status).toBe('dead');
    const alive = schedule({ ...feed, firstErrorAt: ago(30 * DAY_MS - 1) }, failure());
    expect(alive).toMatchObject({ status: 'quarantined', quarantineCount: 4 });
  });

  it('applies to any error count', () => {
    expect(
      schedule({ consecutiveErrors: 3, firstErrorAt: ago(31 * DAY_MS) }, failure()).status,
    ).toBe('dead');
  });
});

describe('nextSchedule always (spec 03 §9)', () => {
  it.each<[string, FetchOutcome]>([
    ['a success', success(1)],
    ['a 304', NOT_MODIFIED],
    ['an error', failure()],
  ])('counts %s as a fetch', (_label, outcome) => {
    expect(schedule({ totalFetches: 7 }, outcome)).toMatchObject({
      totalFetches: 8,
      lastFetchAt: NOW,
    });
  });

  it('is pure and deterministic', () => {
    const feed = feedRow({ recentGapsS: Object.freeze([3600, 3600, 3600, 3600, 3600]) });
    const snapshot = structuredClone(feed);
    Object.freeze(feed);
    const outcomes: FetchOutcome[] = [success(3), NOT_MODIFIED, failure({ retryAfterS: 60 })];
    for (const outcome of outcomes) {
      const first = nextSchedule(feed, outcome, NOW, { ttlMinutes: 30 });
      expect(nextSchedule(feed, outcome, new Date(NOW), { ttlMinutes: 30 })).toEqual(first);
    }
    expect(feed).toEqual(snapshot);
  });
});

/**
 * spec 03 §13: "A feed returns invalid XML with an ETag, then recovers; stale validators do not
 * trap recovery." The origin's ETag names its item set, so fixing the markup keeps the ETag: had
 * the broken response's ETag been installed, the fixed body would be answered with 304s and never
 * parsed.
 */
describe('a feed that serves invalid XML with an ETag, then recovers', () => {
  interface Origin {
    etag: string;
    valid: boolean;
  }

  function respond(origin: Origin, ifNoneMatch: string | null): FetchOutcome {
    if (ifNoneMatch === origin.etag) return { kind: 'not_modified', etag: origin.etag };
    if (!origin.valid) {
      return { kind: 'error', code: 'FEED_PARSE_ERROR', message: 'invalid XML', httpStatus: 200 };
    }
    return { kind: 'success', nNew: 1, etag: origin.etag, lastModified: null };
  }

  it('keeps the last good validators until a parsed 200 replaces them', () => {
    const origin: Origin = { etag: '"items-1"', valid: true };
    let feed = feedRow({ etag: '"items-1"', lastModified: null });
    let now = NOW;
    const sent: (string | null)[] = [];
    const kinds: FetchOutcome['kind'][] = [];
    const fetchOnce = (): ScheduleUpdate => {
      sent.push(feed.etag);
      const outcome = respond(origin, feed.etag);
      kinds.push(outcome.kind);
      const update = nextSchedule(feed, outcome, now);
      feed = { ...feed, ...update };
      now = update.nextFetchAt;
      return update;
    };

    fetchOnce(); // in sync: 304
    origin.etag = '"items-2"'; // a new item is published, and the markup breaks
    origin.valid = false;
    expect(fetchOnce()).toMatchObject({ consecutiveErrors: 1, etag: '"items-1"' });
    expect(fetchOnce()).toMatchObject({ consecutiveErrors: 2, etag: '"items-1"' });
    origin.valid = true; // fixed; same items, same ETag
    // The trap: a request carrying the broken response's ETag would now be answered with 304.
    expect(respond(origin, '"items-2"').kind).toBe('not_modified');
    const recovery = fetchOnce();
    expect(recovery).toMatchObject({ status: 'active', consecutiveErrors: 0, etag: '"items-2"' });
    expect(recovery.lastNewItemAt).toEqual(recovery.lastFetchAt);
    expect(fetchOnce().etag).toBe('"items-2"');

    expect(kinds).toEqual(['not_modified', 'error', 'error', 'success', 'not_modified']);
    expect(sent).toEqual(['"items-1"', '"items-1"', '"items-1"', '"items-1"', '"items-2"']);
  });
});
