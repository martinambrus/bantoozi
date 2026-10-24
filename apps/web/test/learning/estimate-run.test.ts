import type { EstimatesStatus } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  ARM_WINDOW_MS,
  INITIAL_ESTIMATE_RUN,
  armEstimateRun,
  dismissEstimateRun,
  expireEstimateRun,
  observeEstimateRun,
  type EstimateRunState,
} from '../../src/features/learning/estimate-run.js';
import { makeEstimates } from './fixtures.js';

const T0 = 1_000_000;
const A1 = '2026-10-23T08:00:00.000Z';
const A2 = '2026-10-23T09:00:00.000Z';

const withRun = (at: string, movedUp: number, movedDown: number, fromRatings = true) =>
  makeEstimates({ lastRun: { at, movedUp, movedDown, fromRatings } });
const refreshing = (): EstimatesStatus => makeEstimates({ lastRun: null });

const baselined = (over: Partial<EstimateRunState> = {}): EstimateRunState => ({
  ...INITIAL_ESTIMATE_RUN,
  baselined: true,
  lastKnownAt: A1,
  ...over,
});
const armed = (over: Partial<EstimateRunState> = {}) => baselined({ armedUntil: T0, ...over });

describe('observeEstimateRun', () => {
  it.each([
    { name: 'a run that followed ratings', state: armed(), est: withRun(A2, 3, 4), shown: true },
    { name: 'only up', state: armed(), est: withRun(A2, 3, 0), shown: true },
    { name: 'not from ratings', state: armed(), est: withRun(A2, 3, 4, false), shown: false },
    { name: 'nothing moved', state: armed(), est: withRun(A2, 0, 0), shown: false },
    { name: 'the run already known', state: armed(), est: withRun(A1, 3, 4), shown: false },
    {
      name: 'an older run',
      state: armed(),
      est: withRun('2026-10-23T07:00:00.000Z', 3, 4),
      shown: false,
    },
    { name: 'not armed', state: baselined(), est: withRun(A2, 3, 4), shown: false },
    {
      name: 'no status seen before',
      state: { ...armed(), baselined: false, lastKnownAt: null },
      est: withRun(A2, 3, 4),
      shown: false,
    },
  ])('$name: shown $shown', ({ state, est, shown }) => {
    const next = observeEstimateRun(state, est, T0 - 1);
    expect(next.notice).toEqual(
      shown ? { up: est.lastRun?.movedUp, down: est.lastRun?.movedDown, at: A2 } : null,
    );
    expect(next.armedUntil).toBe(shown ? null : state.armedUntil);
    expect(next.baselined).toBe(true);
  });

  it('remembers the newest run seen and keeps waiting after one that does not count', () => {
    const next = observeEstimateRun(armed(), withRun(A2, 3, 4, false), T0 - 1);
    expect(next.lastKnownAt).toBe(A2);
    expect(next.armedUntil).toBe(T0);
  });

  it('keeps what it knows while the run is being refreshed, forgets it without a model', () => {
    expect(observeEstimateRun(armed(), refreshing(), T0 - 1).lastKnownAt).toBe(A1);
    expect(observeEstimateRun(armed(), null, T0 - 1).lastKnownAt).toBeNull();
  });

  it('does not show a run after the window has passed', () => {
    const next = observeEstimateRun(armed(), withRun(A2, 3, 4), T0);
    expect(next.notice).toBeNull();
    expect(next.armedUntil).toBeNull();
  });

  it('replaces a shown notice with a newer one, and never shows the same run twice', () => {
    const first = observeEstimateRun(armed(), withRun(A2, 3, 4), T0 - 1);
    const again = observeEstimateRun(armEstimateRun(first, T0), withRun(A2, 3, 4), T0 + 1);
    expect(again.notice).toEqual(first.notice);
    const newer = observeEstimateRun(
      armEstimateRun(first, T0),
      withRun('2026-10-23T10:00:00.000Z', 1, 0),
      T0 + 1,
    );
    expect(newer.notice).toEqual({ up: 1, down: 0, at: '2026-10-23T10:00:00.000Z' });
  });

  it('does not bring a dismissed run back', () => {
    const shown = observeEstimateRun(armed(), withRun(A2, 3, 4), T0 - 1);
    const dismissed = dismissEstimateRun(shown);
    expect(dismissed.notice).toBeNull();
    const again = observeEstimateRun(
      observeEstimateRun(armEstimateRun(dismissed, T0), refreshing(), T0 + 1),
      withRun(A2, 3, 4),
      T0 + 2,
    );
    expect(again.notice).toBeNull();
  });
});

describe('arm and expire', () => {
  it('arms for 60 s after the last rating', () => {
    expect(armEstimateRun(INITIAL_ESTIMATE_RUN, T0).armedUntil).toBe(T0 + ARM_WINDOW_MS);
    expect(armEstimateRun(armEstimateRun(INITIAL_ESTIMATE_RUN, T0), T0 + 5000).armedUntil).toBe(
      T0 + 5000 + ARM_WINDOW_MS,
    );
  });

  it.each([
    { now: T0 - 1, until: T0 },
    { now: T0, until: null },
    { now: T0 + 1, until: null },
  ])('expires at $now', ({ now, until }) => {
    expect(expireEstimateRun(armed(), now).armedUntil).toBe(until);
  });
});
