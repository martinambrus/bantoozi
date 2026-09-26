/** Adaptive fetch interval (spec 03 §9) — M1-T4. */
export { parseCacheMaxAge, syPeriodSeconds } from './hints.js';
export type { ScheduleHints } from './hints.js';
export { scheduleJitter } from './jitter.js';
export { nextSchedule } from './next-schedule.js';
export type { FeedStatus, FetchOutcome, ScheduleFeed, ScheduleUpdate } from './next-schedule.js';
export { recentGapsS } from './publish-gaps.js';
