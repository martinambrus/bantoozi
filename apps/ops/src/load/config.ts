/** Fixed parameters of the load sanity test (spec 11 §9, M8-T8). */

export const LOAD_PROJECT = 'bantoozi-load';
/** Host ports (loopback): the API, and the control API of the `load-sim` container. */
export const LOAD_API_PORT = 18281;
export const LOAD_CONTROL_PORT = 18644;

export const LOAD_USERS = 20;
export const LOAD_FEEDS_PER_USER = 50;
export const LOAD_CARDS_PER_USER = 10;
export const LOAD_FEED_COUNT = 1000;
export const LOAD_ITEMS_PER_FEED_PER_HOUR = 5;
export const LOAD_PROVIDER_LATENCY_MS = 300;

/** Origins of the generated feeds: `http://load-sim:<base + feed % count>` (see infra/load). */
export const SIM_HOST = 'load-sim';
export const SIM_FEED_PORT_BASE = 8100;
export const SIM_FEED_PORT_COUNT = 50;

/** Feed `index` (0-based) as the worker inside the load network reaches it. */
export function loadFeedUrl(index: number): string {
  return `http://${SIM_HOST}:${SIM_FEED_PORT_BASE + (index % SIM_FEED_PORT_COUNT)}/feed/${index}.xml`;
}

/**
 * The feeds of user `user`: 50 consecutive feeds starting at `user × 30`, so neighbouring users share
 * 20 feeds and the 20 users cover 620 of the 1,000 feeds. Shared feeds mean shared articles, which
 * is what lets the cache of spec 05 answer the second subscriber for free.
 */
export function userFeedIndexes(user: number): number[] {
  return Array.from({ length: LOAD_FEEDS_PER_USER }, (_, k) => (user * 30 + k) % LOAD_FEED_COUNT);
}

/** Reader traffic of one phase: requests per second per user, one connection per user. */
export const LIST_RATE_PER_USER = 1;
export const ACTION_RATE_PER_USER = 1;
export const LIST_PAGE_LIMIT = 30;

/**
 * The pool limits the running processes use (spec 11 §2). `pool.test.ts` compares them with the
 * constants in apps/worker/src/health-server.ts and apps/api/src/main.ts, so a change there fails
 * the unit test instead of silently making the report wrong.
 */
export const LOAD_POOL = { workerQuery: 10, workerFeedLocks: 14, apiMax: 10 } as const;
