import { DEFAULT_MIN_INTERVAL_S } from '@bantoozi/shared';

import { scheduleHintS } from './hints.js';
import type { ScheduleHints } from './hints.js';
import { scheduleJitter } from './jitter.js';
import { median } from './publish-gaps.js';

/** `feeds.status` (spec 02): only `active` and `quarantined` feeds are scheduled (spec 03 §3). */
export type FeedStatus = 'active' | 'quarantined' | 'dead' | 'paused';

/**
 * The `feeds` columns that {@link nextSchedule} reads (spec 02 `feeds`): the row as stored before
 * this fetch, except for `recentGapsS`.
 */
export interface ScheduleFeed {
  /** `feeds.id` as a decimal string; it seeds the jitter ({@link scheduleJitter}). */
  id: string;
  createdAt: Date;
  status: FeedStatus;
  /** The stored interval, before jitter (`fetch_interval_s`, default 900). */
  fetchIntervalS: number;
  /** `MIN`: the lowest plan interval among the subscribers (spec 08 §6; default 900). */
  minIntervalS: number;
  consecutiveErrors: number;
  consecutiveEmpty: number;
  quarantineCount: number;
  totalFetches: number;
  totalErrors: number;
  totalEmpty: number;
  lastNewItemAt: Date | null;
  /** Start of the current error streak. */
  firstErrorAt: Date | null;
  quarantinedUntil: Date | null;
  lastSuccessAt: Date | null;
  /**
   * The last error, kept unchanged by a success so that clients can compare it with
   * `lastSuccessAt` (spec 08 `FeedInfo`).
   */
  lastErrorCode: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  etag: string | null;
  lastModified: string | null;
  /**
   * `publish_stats.recent_gaps_s` **after** this fetch's update (spec 03 §7), as computed by
   * `recentGapsS()`. Non-finite, zero and negative entries are ignored.
   */
  recentGapsS: readonly number[];
}

/** What one `feed.fetch` observed (spec 03 §9 inputs). */
export type FetchOutcome =
  | {
      /** A successfully parsed HTTP 200; a valid zero-item feed is a success (spec 03 §6). */
      kind: 'success';
      /** New feed-item associations, not revisions (spec 03 §7). */
      nNew: number;
      /** The validators the 200 returned; `null` or empty when absent (they replace the stored ones). */
      etag: string | null;
      lastModified: string | null;
    }
  | {
      /** A valid conditional 304; no body is parsed or ingested. */
      kind: 'not_modified';
      /** Only the validators the 304 returned; an absent, `null` or empty one keeps the stored one. */
      etag?: string | null | undefined;
      lastModified?: string | null | undefined;
    }
  | {
      /** Any failure, including a 200 whose body does not parse (`FEED_PARSE_ERROR`). */
      kind: 'error';
      /** Stable error code for `feeds.last_error_code`. */
      code: string;
      message: string;
      /** HTTP status of the final response, when there was one; 410 kills the feed. */
      httpStatus?: number | undefined;
      /** Parsed `Retry-After`, in seconds from now; a negative or NaN value is ignored. */
      retryAfterS?: number | undefined;
    };

/** The new values of the `feeds` columns that {@link nextSchedule} owns. */
export interface ScheduleUpdate {
  status: FeedStatus;
  /** The stored interval, **before** jitter. */
  fetchIntervalS: number;
  nextFetchAt: Date;
  consecutiveErrors: number;
  consecutiveEmpty: number;
  quarantineCount: number;
  quarantinedUntil: Date | null;
  totalFetches: number;
  totalErrors: number;
  totalEmpty: number;
  lastFetchAt: Date;
  lastSuccessAt: Date | null;
  lastNewItemAt: Date | null;
  firstErrorAt: Date | null;
  /** Set by an error; a success leaves the last error unchanged. */
  lastErrorCode: string | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  etag: string | null;
  lastModified: string | null;
}

const SECOND_MS = 1000;
const DAY_S = 86_400;

/** `MIN` is never below 5 minutes (spec 03 §9). */
const MIN_FLOOR_S = 300;
/** `MAX` while a new item arrived in the last 30 days or the feed is younger than 30 days. */
const MAX_ACTIVE_S = DAY_S;
/** `MAX` once the feed has been quiet for 30 days. */
const MAX_QUIET_S = 10 * DAY_S;
const QUIET_AFTER_S = 30 * DAY_S;

/** New-item speed-up: `n_new ≥ 5` halves the interval, `n_new ≥ 2` takes a quarter off. */
const MANY_NEW = 5;
const SOME_NEW = 2;
/** Each empty fetch (including a 304) adds 20 %, at least 5 minutes. */
const EMPTY_GROWTH = 0.2;
const EMPTY_GROWTH_MIN_S = 300;

/** The median-gap cap needs ≥ 5 gaps and a new item within the last 7 days. */
const GAP_CAP_MIN_GAPS = 5;
const GAP_CAP_FRESH_S = 7 * DAY_S;

const ERROR_BACKOFF_MAX_DOUBLINGS = 16;
/** Error backoff and the honoured part of `Retry-After` are capped at 24 h. */
const ERROR_BACKOFF_CAP_S = DAY_S;
const GONE = 410;
const QUARANTINE_AFTER_ERRORS = 10;
const QUARANTINE_BASE_S = 2 * DAY_S;
const QUARANTINE_MAX_DOUBLINGS = 3;
const QUARANTINE_CAP_S = 16 * DAY_S;
/** An error streak this long kills the feed. */
const DEAD_AFTER_S = 30 * DAY_S;

type SuccessOutcome = Exclude<FetchOutcome, { kind: 'error' }>;
type ErrorOutcome = Extract<FetchOutcome, { kind: 'error' }>;

/**
 * The adaptive fetch schedule (spec 03 §9): the feed row's new scheduling columns after one fetch
 * outcome. Pure and deterministic: time comes only from `now`, and the ±10 % jitter from
 * {@link scheduleJitter}`(feed.id, now)`.
 *
 * - `MIN = max(300, min_interval_s)`. `MAX` is 24 h while `last_new_item_at` (as updated by this
 *   fetch, so a feed that resumes publishing is capped at 24 h at once) is less than 30 days old or
 *   the feed is younger than 30 days, else 10 days: it switches after exactly 30 days of quiet, also
 *   for a feed that never had a new item (spec 03 §9 last paragraph). A `min_interval_s` above
 *   `MAX`, which no plan allows (spec 08 §6), is capped by `MAX`.
 * - **Success** (`success` or `not_modified`): resets the error streak and quarantine and sets
 *   `status = 'active'`. New items shrink the interval (×0.5 for ≥ 5, ×0.75 for ≥ 2, ×1 for 1); an
 *   empty fetch, including a 304, grows it by `max(300, round(20 %))`. While ≥ 5 publication gaps
 *   are known and the last new item is less than 7 days old, the interval is capped at
 *   `max(MIN, median gap / 2)`, so a daily feed stays at ≤ ~12 h. The publisher hint
 *   ({@link ScheduleHints}) is a floor. The stored interval is `clamp(round_to_60(max(interval,
 *   hint)), MIN, MAX)`; the next fetch is `now + min(MAX, max(MIN, hint, interval × (1 +
 *   jitter)))`, clamped after jitter, so jitter never fetches before `MIN` or the hint, nor later
 *   than `MAX` (spec 03 §13).
 * - **Error**: records the error and backs off `min(MIN × 2^min(errors − 1, 16), 24 h)`, never
 *   shorter than `Retry-After` (itself honoured up to 24 h); no jitter is applied. HTTP 410 marks
 *   the feed `dead` at once. From the 10th consecutive error the feed is `quarantined` until `now +
 *   min(2 days × 2^min(quarantine_count − 1, 3), 16 days)` (2, 4, 8, then 16 days), and the next
 *   fetch is `quarantined_until` (spec 03 §3). An error streak of ≥ 30 days marks it `dead`. The
 *   stored interval is kept for the recovery.
 * - **Always**: `total_fetches + 1`, `last_fetch_at = now`. A parsed 200 replaces both validators,
 *   clearing absent ones; a 304 keeps the ones it did not return; an error, including a parse
 *   error, never installs validators, so a broken body cannot hide behind 304 responses.
 *
 * `dead` and `paused` feeds are never scheduled (spec 03 §3). If called for one anyway, the
 * counters, timestamps, validators and next fetch time are updated as usual, but the status is kept
 * and the feed is never quarantined: only an explicit reset (subscribe, admin reset; spec 02, spec
 * 08) revives a feed, a 410 stays dead (spec 03 §13), and a merged feed must stay dead (spec 02
 * `feeds` CHECK). For a 410 or another error of a dead feed, `nextFetchAt` is the ordinary error
 * backoff, so a revival that keeps it does not refetch in a tight loop.
 *
 * Retrying a 304 that arrived without established validators (spec 03 §9) is the caller's job:
 * pass `not_modified` only for a valid conditional 304.
 *
 * @throws RangeError when `now` is an invalid `Date`.
 */
export function nextSchedule(
  feed: ScheduleFeed,
  outcome: FetchOutcome,
  now: Date,
  hints?: ScheduleHints,
): ScheduleUpdate {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('nextSchedule: now must be a valid Date');
  }
  return outcome.kind === 'error'
    ? afterError(feed, outcome, now)
    : afterSuccess(feed, outcome, now, hints);
}

function afterSuccess(
  feed: ScheduleFeed,
  outcome: SuccessOutcome,
  now: Date,
  hints: ScheduleHints | undefined,
): ScheduleUpdate {
  const nowMs = now.getTime();
  const minS = minIntervalS(feed);
  const nNew = outcome.kind === 'success' ? outcome.nNew : 0;
  const hasNew = nNew > 0;
  const lastNewItemAt = hasNew ? now : feed.lastNewItemAt;
  const maxS =
    youngerThan(lastNewItemAt, QUIET_AFTER_S, nowMs) ||
    youngerThan(feed.createdAt, QUIET_AFTER_S, nowMs)
      ? MAX_ACTIVE_S
      : MAX_QUIET_S;

  let interval =
    Number.isFinite(feed.fetchIntervalS) && feed.fetchIntervalS > 0 ? feed.fetchIntervalS : minS;
  if (hasNew) {
    interval *= nNew >= MANY_NEW ? 0.5 : nNew >= SOME_NEW ? 0.75 : 1;
  } else {
    interval += Math.max(EMPTY_GROWTH_MIN_S, Math.round(interval * EMPTY_GROWTH));
  }

  const hint = scheduleHintS(hints, maxS);
  const gaps = feed.recentGapsS.filter((gap) => Number.isFinite(gap) && gap > 0);
  if (gaps.length >= GAP_CAP_MIN_GAPS && youngerThan(lastNewItemAt, GAP_CAP_FRESH_S, nowMs)) {
    interval = Math.min(interval, Math.max(minS, median(gaps) / 2));
  }
  const fetchIntervalS = clamp(roundTo60(Math.max(interval, hint)), minS, maxS);
  const jittered = fetchIntervalS * (1 + scheduleJitter(feed.id, now));
  const delayS = Math.min(maxS, Math.max(minS, hint, jittered));

  const validators =
    outcome.kind === 'success'
      ? { etag: validator(outcome.etag), lastModified: validator(outcome.lastModified) }
      : {
          etag: validator(outcome.etag) ?? feed.etag,
          lastModified: validator(outcome.lastModified) ?? feed.lastModified,
        };

  return {
    status: keepsStatus(feed.status) ? feed.status : 'active',
    fetchIntervalS,
    nextFetchAt: new Date(nowMs + Math.round(delayS * SECOND_MS)),
    consecutiveErrors: 0,
    consecutiveEmpty: hasNew ? 0 : feed.consecutiveEmpty + 1,
    quarantineCount: 0,
    quarantinedUntil: null,
    totalFetches: feed.totalFetches + 1,
    totalErrors: feed.totalErrors,
    totalEmpty: hasNew ? feed.totalEmpty : feed.totalEmpty + 1,
    lastFetchAt: now,
    lastSuccessAt: now,
    lastNewItemAt,
    firstErrorAt: null,
    lastErrorCode: feed.lastErrorCode,
    lastError: feed.lastError,
    lastErrorAt: feed.lastErrorAt,
    ...validators,
  };
}

function afterError(feed: ScheduleFeed, outcome: ErrorOutcome, now: Date): ScheduleUpdate {
  const nowMs = now.getTime();
  const minS = minIntervalS(feed);
  const consecutiveErrors = feed.consecutiveErrors + 1;
  const firstErrorAt = feed.firstErrorAt ?? now;

  let backoffS = Math.min(
    minS * 2 ** Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MAX_DOUBLINGS),
    ERROR_BACKOFF_CAP_S,
  );
  const retryAfterS = outcome.retryAfterS;
  if (retryAfterS !== undefined && retryAfterS >= 0) {
    backoffS = Math.max(backoffS, Math.min(retryAfterS, ERROR_BACKOFF_CAP_S));
  }

  let status = feed.status;
  let quarantineCount = feed.quarantineCount;
  let quarantinedUntil = feed.quarantinedUntil;
  let nextFetchAt = new Date(nowMs + Math.round(backoffS * SECOND_MS));
  if (!keepsStatus(feed.status)) {
    if (outcome.httpStatus === GONE) {
      status = 'dead';
    } else {
      if (consecutiveErrors >= QUARANTINE_AFTER_ERRORS) {
        quarantineCount += 1;
        status = 'quarantined';
        const quarantineS = Math.min(
          QUARANTINE_BASE_S * 2 ** Math.min(quarantineCount - 1, QUARANTINE_MAX_DOUBLINGS),
          QUARANTINE_CAP_S,
        );
        quarantinedUntil = new Date(nowMs + quarantineS * SECOND_MS);
        nextFetchAt = quarantinedUntil;
      }
      if (nowMs - firstErrorAt.getTime() >= DEAD_AFTER_S * SECOND_MS) status = 'dead';
    }
  }

  return {
    status,
    fetchIntervalS: feed.fetchIntervalS,
    nextFetchAt,
    consecutiveErrors,
    consecutiveEmpty: feed.consecutiveEmpty,
    quarantineCount,
    quarantinedUntil,
    totalFetches: feed.totalFetches + 1,
    totalErrors: feed.totalErrors + 1,
    totalEmpty: feed.totalEmpty,
    lastFetchAt: now,
    lastSuccessAt: feed.lastSuccessAt,
    lastNewItemAt: feed.lastNewItemAt,
    firstErrorAt,
    lastErrorCode: outcome.code,
    lastError: outcome.message,
    lastErrorAt: now,
    etag: feed.etag,
    lastModified: feed.lastModified,
  };
}

/** A returned validator; an empty or blank header value counts as absent. */
function validator(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

/** `dead` and `paused` are changed only by an explicit reset, never by a fetch outcome. */
function keepsStatus(status: FeedStatus): boolean {
  return status === 'dead' || status === 'paused';
}

/** `MIN` (spec 03 §9): at least 300 s; a non-finite value falls back to the plan default. */
function minIntervalS(feed: ScheduleFeed): number {
  return Number.isFinite(feed.minIntervalS)
    ? Math.max(MIN_FLOOR_S, Math.ceil(feed.minIntervalS))
    : DEFAULT_MIN_INTERVAL_S;
}

/** Whether `at` is less than `seconds` before `nowMs` ("within"; a future instant counts). */
function youngerThan(at: Date | null, seconds: number, nowMs: number): boolean {
  return at !== null && nowMs - at.getTime() < seconds * SECOND_MS;
}

function roundTo60(seconds: number): number {
  return Math.round(seconds / 60) * 60;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
