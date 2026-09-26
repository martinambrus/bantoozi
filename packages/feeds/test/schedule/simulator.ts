import type {
  FetchOutcome,
  ScheduleFeed,
  ScheduleHints,
  ScheduleUpdate,
} from '../../src/schedule/index.js';
import { nextSchedule, recentGapsS } from '../../src/schedule/index.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './schedule-fixtures.js';

/** A publisher as the simulated `feed.fetch` sees it. */
export interface Archetype {
  feedId: string;
  /** Publication instants in ascending order, including a backlog from before the subscription. */
  publications: readonly Date[];
  /** How many of the newest items the feed document lists. */
  windowSize: number;
  /** Whether the origin serves an unparsable body (still with an ETag) at an instant. */
  brokenAt?: (at: Date) => boolean;
  hints?: ScheduleHints;
}

export interface SimulatedFetch {
  at: Date;
  outcome: FetchOutcome['kind'];
  nNew: number;
  /** The `If-None-Match` the request carried. */
  sentEtag: string | null;
  update: ScheduleUpdate;
}

/** A Monday; the feed is subscribed (created) at this instant. */
export const SIMULATION_START = new Date('2026-03-02T00:00:00.000Z');

export function dayOf(at: Date, start: Date = SIMULATION_START): number {
  return (at.getTime() - start.getTime()) / DAY_MS;
}

/** A feed row as subscribing creates it, with the spec 02 defaults. */
export function newFeed(id: string, createdAt: Date): ScheduleFeed {
  return {
    id,
    createdAt,
    status: 'active',
    fetchIntervalS: 900,
    minIntervalS: 900,
    consecutiveErrors: 0,
    consecutiveEmpty: 0,
    quarantineCount: 0,
    totalFetches: 0,
    totalErrors: 0,
    totalEmpty: 0,
    lastNewItemAt: null,
    firstErrorAt: null,
    quarantinedUntil: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastError: null,
    lastErrorAt: null,
    etag: null,
    lastModified: null,
    recentGapsS: [],
  };
}

/**
 * Runs `feed.schedule` and `feed.fetch` for `days` days, fetch by fetch. The scheduler picks the
 * feed up at the first whole minute at or after `next_fetch_at` (spec 03 §3). The origin's ETag
 * names its item set: a conditional request carrying it gets a 304; otherwise a broken origin
 * fails to parse, and a working one yields the window's unseen items, whose dates update
 * `recent_gaps_s` (spec 03 §7). Each {@link nextSchedule} result is the next fetch's state.
 */
export function simulate(
  archetype: Archetype,
  days: number,
  start: Date = SIMULATION_START,
): SimulatedFetch[] {
  const { publications, windowSize } = archetype;
  const endMs = start.getTime() + days * DAY_MS;
  let feed = newFeed(archetype.feedId, start);
  let dueMs = start.getTime();
  let published = 0;
  let passed = 0;
  let seen: Date[] = [];
  const log: SimulatedFetch[] = [];

  while (dueMs < endMs) {
    const now = new Date(Math.ceil(dueMs / MINUTE_MS) * MINUTE_MS);
    while ((publications[published]?.getTime() ?? Number.POSITIVE_INFINITY) <= now.getTime()) {
      published += 1;
    }
    const originEtag = `"items-${published}"`;
    const sentEtag = feed.etag;
    let outcome: FetchOutcome;
    let recentGaps = feed.recentGapsS;
    if (sentEtag === originEtag) {
      outcome = { kind: 'not_modified', etag: originEtag };
    } else if (archetype.brokenAt?.(now) === true) {
      outcome = {
        kind: 'error',
        code: 'FEED_PARSE_ERROR',
        message: 'invalid XML',
        httpStatus: 200,
      };
    } else {
      const firstUnseen = Math.max(passed, published - windowSize);
      const nNew = published - firstUnseen;
      if (nNew > 0) {
        seen = [...seen, ...publications.slice(firstUnseen, published)].slice(-20);
        recentGaps = recentGapsS(seen);
      }
      passed = published;
      outcome = { kind: 'success', nNew, etag: originEtag, lastModified: null };
    }

    const update = nextSchedule(
      { ...feed, recentGapsS: recentGaps },
      outcome,
      now,
      archetype.hints,
    );
    log.push({
      at: now,
      outcome: outcome.kind,
      nNew: outcome.kind === 'success' ? outcome.nNew : 0,
      sentEtag,
      update,
    });
    const { nextFetchAt, lastFetchAt: _lastFetchAt, ...columns } = update;
    feed = { ...feed, ...columns, recentGapsS: recentGaps };
    dueMs = nextFetchAt.getTime();
  }
  return log;
}

/** mulberry32: a small seeded PRNG, so every run publishes the same items. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Instants from `fromDay` to `toDay` (days relative to the start), every `stepMs`, plus `offsetMs`. */
function every(stepMs: number, fromDay: number, toDay: number, offsetMs = 0): Date[] {
  const dates: Date[] = [];
  const startMs = SIMULATION_START.getTime();
  for (let t = startMs + fromDay * DAY_MS + offsetMs; t < startMs + toDay * DAY_MS; t += stepMs) {
    dates.push(new Date(t));
  }
  return dates;
}

/**
 * A busy news site: a post every 5–40 minutes from 06:00 to 22:00 UTC and every 45–135 minutes at
 * night (about 48 a day), 50 items per document, `Cache-Control: max-age=300` from its CDN.
 */
export function busyNewsSite(): Archetype {
  const random = mulberry32(20_260_302);
  const publications: Date[] = [];
  const endMs = SIMULATION_START.getTime() + 61 * DAY_MS;
  for (let t = SIMULATION_START.getTime() - 2 * DAY_MS; t < endMs;) {
    const hour = new Date(t).getUTCHours();
    t += Math.round((hour >= 6 && hour < 22 ? 5 + 35 * random() : 45 + 90 * random()) * MINUTE_MS);
    publications.push(new Date(t));
  }
  return { feedId: '101', publications, windowSize: 50, hints: { cacheMaxAgeS: 300 } };
}

/** A blog posting every day at 07:00 UTC, with WordPress's default `sy:updatePeriod` of hourly. */
export function dailyBlog(): Archetype {
  return {
    feedId: '202',
    publications: every(DAY_MS, -30, 61, 7 * HOUR_MS),
    windowSize: 10,
    hints: { syUpdatePeriod: 'hourly', syUpdateFrequency: 1 },
  };
}

/** A podcast publishing every Monday at 05:00 UTC, listing all episodes, with `<ttl>60</ttl>`. */
export function weeklyPodcast(): Archetype {
  return {
    feedId: '303',
    publications: every(7 * DAY_MS, -140, 61, 5 * HOUR_MS),
    windowSize: 300,
    hints: { ttlMinutes: 60 },
  };
}

/** Days 20–32 of {@link brokenFeed}: its CMS emits invalid XML, still with an ETag. */
export const BROKEN_FROM_DAY = 20;
export const BROKEN_UNTIL_DAY = 32;

/** A regional news site posting every 3 hours, broken from day 20 to day 32. */
export function brokenFeed(): Archetype {
  const fromMs = SIMULATION_START.getTime() + BROKEN_FROM_DAY * DAY_MS;
  const untilMs = SIMULATION_START.getTime() + BROKEN_UNTIL_DAY * DAY_MS;
  return {
    feedId: '404',
    publications: every(3 * HOUR_MS, -3, 61, 90 * MINUTE_MS),
    windowSize: 30,
    brokenAt: (at) => at.getTime() >= fromMs && at.getTime() < untilMs,
  };
}

/** A blog that posted every 3 days until the day before the subscription, then went silent. */
export function dormantBlog(): Archetype {
  return { feedId: '505', publications: every(3 * DAY_MS, -60, -1, 10 * HOUR_MS), windowSize: 20 };
}
