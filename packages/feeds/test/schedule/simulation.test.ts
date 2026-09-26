import { describe, expect, it } from 'vitest';

import type { SimulatedFetch } from './simulator.js';
import {
  BROKEN_FROM_DAY,
  BROKEN_UNTIL_DAY,
  brokenFeed,
  busyNewsSite,
  dailyBlog,
  dayOf,
  dormantBlog,
  simulate,
  weeklyPodcast,
} from './simulator.js';

/** PLAN.md §6 M1-T4: 60-day simulations assert `fetch_interval_s` before jitter. */
const DAYS = 60;

function last(log: readonly SimulatedFetch[]): SimulatedFetch {
  const fetch = log.at(-1);
  if (fetch === undefined) throw new Error('the simulation made no fetch');
  return fetch;
}

function intervalsFrom(log: readonly SimulatedFetch[], fromDay: number): number[] {
  return log.filter((fetch) => dayOf(fetch.at) >= fromDay).map((f) => f.update.fetchIntervalS);
}

/** The longest time between two consecutive fetches from `fromDay` on, in seconds. */
function longestPauseS(log: readonly SimulatedFetch[], fromDay = 0): number {
  let longest = 0;
  for (let i = 1; i < log.length; i += 1) {
    const [previous, current] = [log[i - 1], log[i]];
    if (previous === undefined || current === undefined || dayOf(previous.at) < fromDay) continue;
    longest = Math.max(longest, (current.at.getTime() - previous.at.getTime()) / 1000);
  }
  return longest;
}

describe('60-day schedule simulations (spec 03 §9)', () => {
  it('keeps a busy news site at ≤ 1,800 s', () => {
    const log = simulate(busyNewsSite(), DAYS);
    expect(last(log).update.fetchIntervalS).toBeLessThanOrEqual(1800);
    expect(Math.max(...intervalsFrom(log, 0))).toBeLessThanOrEqual(1800);
    expect(log.every((fetch) => fetch.update.status === 'active')).toBe(true);
    expect(log.length).toBeGreaterThan(DAYS * 48);
  });

  it('keeps a daily blog at ≤ 43,200 s without polling it every 15 minutes', () => {
    const log = simulate(dailyBlog(), DAYS);
    const final = last(log).update.fetchIntervalS;
    expect(final).toBeLessThanOrEqual(43_200);
    expect(final).toBeGreaterThan(3600);
    expect(Math.max(...intervalsFrom(log, 7))).toBeLessThanOrEqual(43_200);
    // A post is never more than 12 h (+ 10 % jitter, + the scheduler's minute) from being fetched.
    expect(longestPauseS(log)).toBeLessThanOrEqual(43_200 * 1.1 + 60);
    expect(log.length).toBeLessThan(DAYS * 4);
  });

  it('lets a weekly podcast reach ≥ 86,400 s and stay there', () => {
    const log = simulate(weeklyPodcast(), DAYS);
    expect(last(log).update.fetchIntervalS).toBeGreaterThanOrEqual(86_400);
    const reached = log.findIndex((fetch) => fetch.update.fetchIntervalS >= 86_400);
    expect(dayOf(log[reached]?.at ?? new Date(Number.NaN))).toBeLessThan(7);
    expect(Math.min(...log.slice(reached).map((f) => f.update.fetchIntervalS))).toBe(86_400);
    // MAX is 24 h while episodes keep coming, jitter included.
    expect(longestPauseS(log)).toBeLessThanOrEqual(86_400 + 60);
  });

  it('quarantines a feed that serves invalid XML, and returns it to active after the fix', () => {
    const log = simulate(brokenFeed(), DAYS);
    const firstError = log.findIndex((fetch) => fetch.outcome === 'error');
    const lastGood = log[firstError - 1];
    const quarantined = log.findIndex((fetch) => fetch.update.status === 'quarantined');
    const recovered = log.findIndex((f, i) => i > quarantined && f.update.status === 'active');
    const recovery = log[recovered];
    if (lastGood === undefined || quarantined < 0 || recovery === undefined) {
      throw new Error('the broken feed was not quarantined and recovered');
    }

    // Until a new item changes the ETag, the origin answers 304 even while broken; the ETag the
    // streak keeps is the one of the last parsed 200, from before the break.
    const lastParsed = log.slice(0, firstError).findLast((f) => f.outcome === 'success');
    expect(dayOf(lastParsed?.at ?? lastGood.at)).toBeLessThan(BROKEN_FROM_DAY);
    expect(lastGood.update.etag).toBe(lastParsed?.update.etag);
    expect(dayOf(log[firstError]?.at ?? lastGood.at)).toBeGreaterThanOrEqual(BROKEN_FROM_DAY);
    // Every fetch of the broken period fails (a stale ETag never turns into a 304), and the 10th
    // consecutive error starts the quarantine.
    expect(log.slice(firstError, recovered).every((f) => f.outcome === 'error')).toBe(true);
    expect(quarantined).toBe(firstError + 9);
    expect(log[quarantined]?.update).toMatchObject({ consecutiveErrors: 10, quarantineCount: 1 });
    // The broken bodies never install their validators.
    for (const fetch of log.slice(firstError, recovered)) {
      expect(fetch.sentEtag).toBe(lastGood.update.etag);
      expect(fetch.update.etag).toBe(lastGood.update.etag);
    }
    // Quarantines last 2, 4, then 8 days; the fix is picked up at the end of the current one.
    const quarantineDays = log
      .slice(quarantined, recovered)
      .map((f) => ((f.update.quarantinedUntil?.getTime() ?? 0) - f.at.getTime()) / 86_400_000);
    expect(quarantineDays).toEqual([2, 4, 8]);
    expect(dayOf(recovery.at)).toBeGreaterThanOrEqual(BROKEN_UNTIL_DAY);
    expect(dayOf(recovery.at)).toBeLessThanOrEqual(BROKEN_UNTIL_DAY + 16);
    expect(recovery.outcome).toBe('success');
    expect(recovery.nNew).toBeGreaterThan(0);
    expect(recovery.update).toMatchObject({
      status: 'active',
      consecutiveErrors: 0,
      firstErrorAt: null,
      quarantineCount: 0,
      quarantinedUntil: null,
    });
    expect(recovery.update.etag).not.toBe(lastGood.update.etag);
    expect(log.some((fetch) => fetch.update.status === 'dead')).toBe(false);
    // Back to its 3-hour rhythm (half the median gap) by the end.
    expect(last(log).update).toMatchObject({ status: 'active', fetchIntervalS: 5400 });
  });

  it('lets a feed drift past 24 h only after 30 quiet days, and never past 10 days', () => {
    const log = simulate(dormantBlog(), DAYS);
    // The backlog arrives with the first fetch (day 0); nothing is published after it.
    expect(log.filter((f) => f.nNew > 0).map((f) => dayOf(f.at))).toEqual([0]);
    const quietFrom = 30;
    expect(
      Math.max(...log.filter((f) => dayOf(f.at) < quietFrom).map((f) => f.update.fetchIntervalS)),
    ).toBe(86_400);
    const drifting = intervalsFrom(log, quietFrom);
    expect(drifting[0]).toBeGreaterThan(86_400);
    expect(Math.max(...drifting)).toBeLessThanOrEqual(864_000);
    expect(longestPauseS(log)).toBeLessThanOrEqual(864_000 + 60);
  });
});
