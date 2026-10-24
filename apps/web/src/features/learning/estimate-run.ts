import type { EstimatesStatus } from '@bantoozi/shared';

/** How long after the last rating the reader waits for the refresh that follows it. */
export const ARM_WINDOW_MS = 60_000;

export interface EstimateNotice {
  up: number;
  down: number;
  at: string;
}

export interface EstimateRunState {
  /** The newest `lastRun.at` seen; null while no estimate model has been seen. */
  lastKnownAt: string | null;
  /** Whether any status has been seen, so a run that was already there is not taken for new. */
  baselined: boolean;
  /** Until when (epoch ms) a run counts as following the reader's ratings; null when not waiting. */
  armedUntil: number | null;
  notice: EstimateNotice | null;
}

export const INITIAL_ESTIMATE_RUN: EstimateRunState = {
  lastKnownAt: null,
  baselined: false,
  armedUntil: null,
  notice: null,
};

export function armEstimateRun(state: EstimateRunState, now: number): EstimateRunState {
  return { ...state, armedUntil: now + ARM_WINDOW_MS };
}

export function expireEstimateRun(state: EstimateRunState, now: number): EstimateRunState {
  if (state.armedUntil === null || now < state.armedUntil) return state;
  return { ...state, armedUntil: null };
}

export function dismissEstimateRun(state: EstimateRunState): EstimateRunState {
  return state.notice === null ? state : { ...state, notice: null };
}

/**
 * Takes one answer of `GET /me/learning` (`estimates` of it). A run is announced when the reader
 * rated shortly before, it followed ratings, it moved at least one row and it is newer than any
 * run seen; any other run leaves the wait as it was.
 */
export function observeEstimateRun(
  state: EstimateRunState,
  estimates: EstimatesStatus | null,
  now: number,
): EstimateRunState {
  const waiting = expireEstimateRun(state, now);
  if (estimates === null) return { ...waiting, baselined: true, lastKnownAt: null };
  const { lastRun } = estimates;
  if (lastRun === null) return { ...waiting, baselined: true };
  const known = waiting.lastKnownAt;
  if (known !== null && lastRun.at <= known) return { ...waiting, baselined: true };
  const next = { ...waiting, baselined: true, lastKnownAt: lastRun.at };
  const qualifies =
    waiting.baselined &&
    waiting.armedUntil !== null &&
    lastRun.fromRatings &&
    lastRun.movedUp + lastRun.movedDown > 0;
  if (!qualifies) return next;
  return {
    ...next,
    armedUntil: null,
    notice: { up: lastRun.movedUp, down: lastRun.movedDown, at: lastRun.at },
  };
}
