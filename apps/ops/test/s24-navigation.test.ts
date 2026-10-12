import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planUserTraffic, runUserTraffic, type LoadProfile } from '../src/load/profile.js';
import { PHASE_NAMES, buildReport, renderMarkdown, type PhaseMeasure } from '../src/load/plan.js';

/**
 * S24 ruler (owner decision 2026-10-11): the realistic profile also issues navigation lists.
 *
 * Contract this file freezes (supersedes the S23 assertions listed in the S24 report):
 * - A navigation list is a `list` event (GET /api/v1/articles: page open, lane switch, back from an
 *   article). Per user, seeded, independent of polling and of actions: the first at t=0 (it IS the
 *   page-load list, so there is exactly one list at t=0) and then one every 30-60 s (uniform).
 * - Interaction with polling (rule): the two streams are independent. The spec 09 poll chain
 *   (5 s list while the last POLL response was pending, else counts after 30 s) is decided only by
 *   the responses of poll requests. A navigation list is an extra request: it never resets, shifts,
 *   restarts or switches the poll schedule, and its own rankingPending is ignored by the poll chain.
 *   Hence: lists(plan) = poll lists (the S23 chain, incl. the t=0 list) + navigation lists (t>0),
 *   counts(plan) and actions(plan) are exactly the S23 ones. A nav list and a poll list may fall
 *   on the same millisecond; both are issued.
 * - stress is unchanged. The report builder gates a sample floor: every realistic phase needs
 *   >= 300 GET /articles samples, else criteria.p95Ok is false, criteria.insufficientSamples names
 *   the phases and the markdown says "insufficient samples". stress is never affected.
 */

const PENDING = () => true;
const IDLE = () => false;
const plan = (profile: LoadProfile, over: Partial<Parameters<typeof planUserTraffic>[0]> = {}) =>
  planUserTraffic({
    profile,
    seed: 7,
    userIndex: 0,
    durationMs: 60_000,
    pendingAt: IDLE,
    ...over,
  });
const times = (
  events: { atMs: number; kind: string }[],
  kind: 'list' | 'counts' | 'action',
): number[] => events.filter((e) => e.kind === kind).map((e) => e.atMs);
const gaps = (ts: number[]): number[] => ts.slice(1).map((t, i) => t - (ts[i] as number));
const HOUR = 3600_000;
/** Idle: the only lists are the navigation lists (the poll chain lists once, at t=0). */
const navTimes = (over: Partial<Parameters<typeof planUserTraffic>[0]> = {}): number[] =>
  times(plan('realistic', { pendingAt: IDLE, ...over }), 'list');
const grid5s = (durationMs: number): number[] =>
  Array.from({ length: Math.ceil(durationMs / 5000) }, (_, i) => i * 5000);

describe('realistic navigation lists', () => {
  it('the first one is at t=0 and is the page-load list (one list at t=0, never two)', () => {
    for (const pendingAt of [PENDING, IDLE]) {
      const lists = times(plan('realistic', { pendingAt }), 'list');
      expect(lists[0]).toBe(0);
      expect(lists.filter((t) => t === 0)).toHaveLength(1);
    }
  });
  it('every gap is within [30 s, 60 s], the gaps vary and average about 45 s', () => {
    const nav = navTimes({ durationMs: 6 * HOUR });
    const g = gaps(nav);
    expect(g.length).toBeGreaterThan(400);
    expect(g.every((x) => x >= 30_000 && x <= 60_000)).toBe(true);
    expect(new Set(g).size).toBeGreaterThan(100);
    const avg = g.reduce((a, b) => a + b, 0) / g.length;
    expect(avg).toBeGreaterThan(43_000);
    expect(avg).toBeLessThan(47_000);
  });
  it('the second navigation list comes 30-60 s after the first, not sooner', () => {
    const second = navTimes({ durationMs: 10 * 60_000 })[1] as number;
    expect(second).toBeGreaterThanOrEqual(30_000);
    expect(second).toBeLessThanOrEqual(60_000);
  });
  it('never at or after the end of the run', () => {
    const nav = navTimes({ durationMs: 10 * 60_000 });
    expect(nav.every((t) => t >= 0 && t < 10 * 60_000)).toBe(true);
  });
  it('is seeded: same seed and user, same times; another seed or user, other times', () => {
    const base = navTimes({ durationMs: 600_000 });
    expect(navTimes({ durationMs: 600_000 })).toEqual(base);
    expect(navTimes({ durationMs: 600_000, seed: 8 })).not.toEqual(base);
    expect(navTimes({ durationMs: 600_000, userIndex: 1 })).not.toEqual(base);
  });
  it('is independent of the pending state: the same navigation times whatever pendingAt says', () => {
    const idle = navTimes({ durationMs: HOUR });
    const pendingPlan = times(plan('realistic', { pendingAt: PENDING, durationMs: HOUR }), 'list');
    const nav = new Set(idle.filter((t) => t > 0));
    const poll = new Set(grid5s(HOUR));
    // every navigation time appears in the pending plan's lists (as an extra beyond the 5 s grid)
    expect(nav.size).toBeGreaterThan(50);
    expect(pendingPlan.length).toBe(grid5s(HOUR).length + nav.size);
    for (const t of nav) expect(pendingPlan).toContain(t);
    expect(poll.has(0)).toBe(true);
  });
  it('is independent of the actions: actions keep their 10-20 s gaps and do not depend on pendingAt', () => {
    const a = times(plan('realistic', { durationMs: 3 * HOUR, pendingAt: PENDING }), 'action');
    const b = times(plan('realistic', { durationMs: 3 * HOUR, pendingAt: IDLE }), 'action');
    expect(a).toEqual(b);
    expect(gaps(a).every((x) => x >= 10_000 && x <= 20_000)).toBe(true);
    expect(a[0]).toBeGreaterThanOrEqual(10_000);
  });
  it('is sorted and returns lists/counts/actions only', () => {
    const events = plan('realistic', { pendingAt: (t) => t % 20_000 < 10_000, durationMs: HOUR });
    expect(events.map((e) => e.atMs)).toEqual([...events.map((e) => e.atMs)].sort((x, y) => x - y));
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(['list', 'counts', 'action']));
  });
  it('gives about 80 GET /articles per user-hour when idle (what the sample floor relies on)', () => {
    const lists = navTimes({ durationMs: HOUR });
    expect(lists.length).toBeGreaterThanOrEqual(70);
    expect(lists.length).toBeLessThanOrEqual(90);
  });
});

describe('navigation lists do not touch the poll schedule', () => {
  const D = 300_000;
  const nav = navTimes({ durationMs: D }).filter((t) => t > 0);
  const notIn = (ts: number[], poll: number[]): number[] => ts.filter((t) => !poll.includes(t));
  it('there are navigation lists in the window used below', () => {
    expect(nav.length).toBeGreaterThanOrEqual(4);
  });
  it('pending: the 5 s grid is intact and the navigation lists are extra', () => {
    const events = plan('realistic', { pendingAt: PENDING, durationMs: D });
    const lists = times(events, 'list');
    expect(nav.length).toBeGreaterThan(0);
    expect(lists).toEqual([...grid5s(D), ...nav].sort((a, b) => a - b));
    expect(lists.length).toBe(60 + nav.length);
    expect(times(events, 'counts')).toEqual([]);
  });
  it('idle: counts stay on the 30 s grid from t=0 (not from the last navigation list)', () => {
    const long = plan('realistic', { durationMs: D, pendingAt: IDLE });
    const c = times(long, 'counts');
    expect(c[0]).toBe(30_000);
    expect(gaps(c).every((g) => g === 30_000)).toBe(true);
    expect(c).toHaveLength(9);
    expect(times(long, 'list')).toEqual([0, ...nav]);
  });
  it('pending then idle: poll lists 0..20 s then counts every 30 s from 50 s, as in S23', () => {
    const events = plan('realistic', { pendingAt: (t) => t < 20_000, durationMs: D });
    const poll = [0, 5000, 10_000, 15_000, 20_000];
    const lists = times(events, 'list');
    for (const t of poll) expect(lists).toContain(t);
    expect(notIn(lists, poll)).toEqual(notIn(nav, poll));
    expect(times(events, 'counts')).toEqual(
      Array.from({ length: 9 }, (_, i) => 50_000 + i * 30_000),
    );
  });
  it('a counts response with rankingPending still switches back to 5 s lists', () => {
    const events = plan('realistic', {
      pendingAt: (t) => t >= 30_000 && t < 45_000,
      durationMs: D,
    });
    const poll = [0, 35_000, 40_000, 45_000];
    expect(nav.length).toBeGreaterThan(0);
    const lists = times(events, 'list');
    for (const t of poll) expect(lists).toContain(t);
    expect(notIn(lists, poll)).toEqual(notIn(nav, poll));
    expect(times(events, 'counts')).toEqual([
      30_000,
      ...Array.from({ length: 8 }, (_, i) => 75_000 + i * 30_000),
    ]);
  });
});

describe('stress is unchanged', () => {
  it('has no navigation list: exactly 1 list/s, no counts, 1 action/s', () => {
    for (const pendingAt of [PENDING, IDLE]) {
      const events = plan('stress', { pendingAt });
      const lists = times(events, 'list');
      expect(lists).toHaveLength(60);
      expect(gaps(lists).every((g) => g === 1000)).toBe(true);
      expect(times(events, 'counts')).toEqual([]);
      const actions = times(events, 'action');
      expect(gaps(actions).every((g) => g === 1000)).toBe(true);
    }
  });
});

describe('runUserTraffic on a fake clock (realistic with navigation)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  const run = async (
    answer: (kind: 'list' | 'counts', at: number) => boolean,
    durationMs: number,
    seed = 3,
    userIndex = 2,
  ) => {
    const listAt: number[] = [];
    const countsAt: number[] = [];
    const actionAt: number[] = [];
    const done = runUserTraffic({
      profile: 'realistic',
      seed,
      userIndex,
      durationMs,
      list: async () => {
        listAt.push(Date.now());
        return { rankingPending: answer('list', Date.now()) };
      },
      counts: async () => {
        countsAt.push(Date.now());
        return { rankingPending: answer('counts', Date.now()) };
      },
      act: async () => {
        actionAt.push(Date.now());
      },
    });
    await vi.advanceTimersByTimeAsync(durationMs);
    await done;
    return { listAt, countsAt, actionAt };
  };

  it('issues the planned navigation lists (idle) and the 30 s counts, on top of the t=0 list', async () => {
    const planned = plan('realistic', { seed: 3, userIndex: 2, durationMs: 300_000 });
    const { listAt, countsAt, actionAt } = await run(() => false, 300_000);
    expect(listAt.length).toBeGreaterThanOrEqual(5);
    expect(listAt).toEqual(times(planned, 'list'));
    expect(countsAt).toEqual(times(planned, 'counts'));
    expect(countsAt[0]).toBe(30_000);
    expect(gaps(countsAt).every((g) => g === 30_000)).toBe(true);
    expect(gaps(listAt).every((g) => g >= 30_000 && g <= 60_000)).toBe(true);
    expect(listAt.filter((t) => t === 0)).toHaveLength(1);
    expect(gaps(actionAt).every((g) => g >= 10_000 && g <= 20_000)).toBe(true);
  });

  it('a navigation list neither shifts the 5 s poll grid nor lets its own pending answer start polling', async () => {
    const nav = new Set(
      times(plan('realistic', { seed: 3, userIndex: 2, durationMs: 200_000 }), 'list').filter(
        (t) => t > 0,
      ),
    );
    expect(nav.size).toBeGreaterThan(0);
    // poll responses are pending only before 20 s; every navigation list answers pending: true
    const { listAt, countsAt } = await run(
      (kind, at) => (kind === 'list' && nav.has(at) ? true : at < 20_000),
      200_000,
    );
    const grid = [0, 5000, 10_000, 15_000, 20_000];
    for (const t of grid) expect(listAt).toContain(t);
    // after the chain went idle at 20 s: counts at 50 s, 80 s, ... (the 30 s grid from the last poll)
    expect(countsAt.slice(0, 3)).toEqual([50_000, 80_000, 110_000]);
    expect(gaps(countsAt).every((g) => g === 30_000)).toBe(true);
    // every list that is not on the pending grid is a planned navigation list, none is a 5 s poll
    const extra = listAt.filter((t) => !grid.includes(t));
    expect(extra.every((t) => nav.has(t))).toBe(true);
    expect(extra.length).toBe([...nav].filter((t) => !grid.includes(t)).length);
  });

  it('while pending, 5 s polls continue regardless of navigation lists', async () => {
    const { listAt } = await run(() => true, 120_000);
    for (const t of grid5s(120_000)) expect(listAt).toContain(t);
  });

  it('stress runs lists once a second and no navigation extras', async () => {
    let lists = 0;
    const done = runUserTraffic({
      profile: 'stress',
      seed: 3,
      userIndex: 0,
      durationMs: 30_000,
      list: async () => {
        lists += 1;
        return { rankingPending: false };
      },
      counts: async () => {
        throw new Error('stress does not poll counts');
      },
      act: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(lists).toBeGreaterThanOrEqual(29);
    expect(lists).toBeLessThanOrEqual(30);
  });
});

function measure(name: PhaseMeasure['name'], samples: number): PhaseMeasure {
  return {
    name,
    startedAt: '2026-10-11T10:00:00.000Z',
    endedAt: '2026-10-11T10:15:00.000Z',
    durationSec: 900,
    articleLatenciesMs: Array.from({ length: samples }, (_, i) => (i % 100) + 1),
    actionRequests: 1200,
    countsRequests: 100,
    errors5xx: 0,
    non2xx: 0,
    cpuSamples: { api: [100, 200] },
    memMaxBytes: { api: 200e6 },
    queueDepthMax: {},
    backlogAlert: false,
    backlogConditions: [],
    inferenceCalls: name === 'all-off' ? 0 : 40,
    providerRequests: name === 'all-off' ? 0 : 40,
    distinctQuestionsAdmitted: 30,
    servedCombinations: 120,
    newArticles: 30,
  };
}

type Criteria = {
  gated: boolean;
  p95Ok: boolean;
  insufficientSamples: string[];
};
const report = (
  profile: LoadProfile,
  samples: (name: PhaseMeasure['name']) => number,
): ReturnType<typeof buildReport> & { criteria: Criteria } =>
  buildReport({
    profile,
    host: { cpus: 8, memTotal: 16e9 },
    durationMin: 60,
    articles: 1000,
    traffic: { listRatePerUser: 1, actionRatePerUser: 1, listPageLimit: 30 },
    measures: PHASE_NAMES.map((n) => measure(n, samples(n))),
    generatedAt: '2026-10-11T11:00:00.000Z',
  } as Parameters<typeof buildReport>[0]) as ReturnType<typeof buildReport> & {
    criteria: Criteria;
  };

describe('sample floor (>= 300 GET /articles samples per realistic phase)', () => {
  it('realistic with exactly 300 samples in every phase passes', () => {
    const r = report('realistic', () => 300);
    expect(r.criteria.p95Ok).toBe(true);
    expect(r.criteria.insufficientSamples).toEqual([]);
  });
  it('realistic with 299 samples in one phase fails p95Ok and names that phase', () => {
    const r = report('realistic', (n) => (n === 'active-feeds' ? 299 : 400));
    expect(r.criteria.p95Ok).toBe(false);
    expect(r.criteria.insufficientSamples).toEqual(['active-feeds']);
    expect(r.criteria.gated).toBe(true);
  });
  it('the S23-era 57 samples in a phase fail, others stay ok', () => {
    const r = report('realistic', (n) => (n === 'all-off' ? 57 : 350));
    expect(r.criteria.p95Ok).toBe(false);
    expect(r.criteria.insufficientSamples).toEqual(['all-off']);
    expect(r.phases.filter((p) => p.name !== 'all-off').every((p) => p.p95ArticlesMs < 300)).toBe(
      true,
    );
  });
  it('lists every phase that is short', () => {
    const r = report('realistic', (n) => (n === 'all-off' || n === 'provider-failing' ? 20 : 500));
    expect([...r.criteria.insufficientSamples].sort()).toEqual(['all-off', 'provider-failing']);
  });
  it('the markdown says "insufficient samples" and names the phase, only when short', () => {
    const short = renderMarkdown(report('realistic', (n) => (n === 'active-feeds' ? 57 : 400)));
    expect(short).toMatch(/insufficient samples/i);
    expect(short).toMatch(/active-feeds/);
    expect(renderMarkdown(report('realistic', () => 400))).not.toMatch(/insufficient samples/i);
  });
  it('degradedReadingOk keeps its own meaning (no 5xx, p95 under the limit), samples aside', () => {
    const r = report('realistic', () => 50) as unknown as {
      criteria: { degradedReadingOk: boolean; backlogOk: boolean };
    };
    expect(r.criteria.degradedReadingOk).toBe(true);
    expect(r.criteria.backlogOk).toBe(true);
  });
  it('stress is never held to the floor: p95Ok follows latency, nothing insufficient', () => {
    const r = report('stress', () => 20);
    expect(r.criteria.gated).toBe(false);
    expect(r.criteria.p95Ok).toBe(true);
    expect(r.criteria.insufficientSamples).toEqual([]);
    expect(renderMarkdown(r)).not.toMatch(/insufficient samples/i);
  });
  it('the measured listRatePerUser counts the navigation lists (all GET /articles samples)', () => {
    const r = report('realistic', () => 360) as unknown as { listRatePerUser: number };
    expect(r.listRatePerUser).toBeCloseTo((4 * 360) / 3600 / 20, 4);
    expect(r.listRatePerUser).toBeGreaterThanOrEqual(0.015);
    expect(r.listRatePerUser).toBeLessThanOrEqual(0.06);
  });
});
