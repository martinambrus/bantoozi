import { randomUUID } from 'node:crypto';

import type { OriginLimiter, OriginReservation } from '@bantoozi/shared';

/** At most this many live request leases per origin (spec 03 §8.2). */
export const ORIGIN_MAX_CONCURRENT = 2;

/** Minimum time between two request starts at one origin (spec 03 §8.2). */
export const ORIGIN_START_SPACING_MS = 1000;

/** Cooldowns are clamped to this horizon (spec 03 §8.2). */
export const ORIGIN_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** How soon a caller that found both leases taken should ask again (no release time is known). */
export const ORIGIN_FULL_POLL_MS = 250;

/** Idle origin rows are forgotten once the map grows past this many origins. */
const PURGE_THRESHOLD = 10_000;

interface OriginState {
  nextStartAt: number;
  blockedUntil: number;
  leases: Array<{ token: string; expiresAt: number }>;
}

export interface MemoryOriginLimiterOptions {
  /** Clock in epoch ms (spec 01 §5: time is injected). Defaults to `Date.now`. */
  now?: () => number;
  /** Live leases allowed per origin; defaults to {@link ORIGIN_MAX_CONCURRENT}. */
  maxConcurrent?: number;
  /** Minimum gap between request starts per origin; defaults to {@link ORIGIN_START_SPACING_MS}. */
  spacingMs?: number;
  /** Retry delay suggested while every lease is held; defaults to {@link ORIGIN_FULL_POLL_MS}. */
  fullPollMs?: number;
}

/**
 * An in-memory {@link OriginLimiter} with the semantics of the PostgreSQL `origin_fetch_state`
 * implementation (spec 03 §4, §8.2), for tests and single-process tools. Per origin:
 * - a persisted cooldown (`block`) answers `blocked` until it ends; a later, shorter `block` never
 *   shortens it, and every cooldown is clamped to 24 h;
 * - expired leases are reclaimed on every reservation, so a crashed holder cannot starve the origin;
 * - with `maxConcurrent` live leases the answer is `wait` (retry after `fullPollMs`, or when the
 *   earliest lease expires if that is sooner, and never before the next start slot);
 * - otherwise a start earlier than `spacingMs` after the previous one is `wait` until that slot;
 * - a grant records a lease that lives `leaseMs` and moves the next start slot `spacingMs` ahead.
 *
 * It never waits itself: callers such as `safeFetch` sleep until `retryAt` and reserve again, and
 * release their exact token when the request ends.
 */
export function createMemoryOriginLimiter(options: MemoryOriginLimiterOptions = {}): OriginLimiter {
  const now = options.now ?? Date.now;
  const maxConcurrent = options.maxConcurrent ?? ORIGIN_MAX_CONCURRENT;
  const spacingMs = options.spacingMs ?? ORIGIN_START_SPACING_MS;
  const fullPollMs = options.fullPollMs ?? ORIGIN_FULL_POLL_MS;
  const origins = new Map<string, OriginState>();

  const stateOf = (origin: string, at: number): OriginState => {
    let state = origins.get(origin);
    if (state === undefined) {
      if (origins.size >= PURGE_THRESHOLD) purgeIdle(origins, at);
      state = { nextStartAt: at, blockedUntil: 0, leases: [] };
      origins.set(origin, state);
    }
    state.leases = state.leases.filter((lease) => lease.expiresAt > at);
    return state;
  };

  return {
    reserve(origin, { leaseMs }): Promise<OriginReservation> {
      const at = now();
      const state = stateOf(origin, at);
      if (state.blockedUntil > at) {
        return Promise.resolve({ status: 'blocked', until: new Date(state.blockedUntil) });
      }
      if (state.leases.length >= maxConcurrent) {
        const earliestExpiry = Math.min(...state.leases.map((lease) => lease.expiresAt));
        const retryAt = Math.max(Math.min(at + fullPollMs, earliestExpiry), state.nextStartAt);
        return Promise.resolve({ status: 'wait', retryAt: new Date(retryAt) });
      }
      if (state.nextStartAt > at) {
        return Promise.resolve({ status: 'wait', retryAt: new Date(state.nextStartAt) });
      }
      const token = randomUUID();
      state.leases.push({ token, expiresAt: at + Math.max(0, leaseMs) });
      state.nextStartAt = at + spacingMs;
      return Promise.resolve({ status: 'granted', token });
    },

    release(origin, token): Promise<void> {
      const state = origins.get(origin);
      if (state !== undefined) state.leases = state.leases.filter((lease) => lease.token !== token);
      return Promise.resolve();
    },

    block(origin, until): Promise<void> {
      const at = now();
      const state = stateOf(origin, at);
      const clamped = Math.min(until.getTime(), at + ORIGIN_MAX_COOLDOWN_MS);
      if (Number.isFinite(clamped)) state.blockedUntil = Math.max(state.blockedUntil, clamped);
      return Promise.resolve();
    },
  };
}

/** Forgets origins with no live lease, no pending start slot and no cooldown. */
function purgeIdle(origins: Map<string, OriginState>, at: number): void {
  for (const [origin, state] of origins) {
    const idle =
      state.blockedUntil <= at &&
      state.nextStartAt <= at &&
      state.leases.every((lease) => lease.expiresAt <= at);
    if (idle) origins.delete(origin);
  }
}
