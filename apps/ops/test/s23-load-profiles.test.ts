import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOAD_PROFILES,
  parseLoadProfile,
  planUserTraffic,
  runUserTraffic,
  type LoadProfile,
} from '../src/load/profile.js';
import { PHASE_NAMES, buildReport, renderMarkdown, type PhaseMeasure } from '../src/load/plan.js';

/**
 * S23 ruler (owner decision 2026-10-11): `load:run --profile realistic|stress`.
 *
 * Contract this file freezes for the implementation:
 * - src/load/profile.ts exports LOAD_PROFILES, parseLoadProfile(value | undefined), planUserTraffic
 *   (pure plan on a virtual clock) and runUserTraffic (live scheduler on setTimeout/Date.now, so
 *   vitest fake timers drive it).
 * - Spec 09 (Refresh and errors): "poll list/counts every 5 seconds only while a visible page has
 *   `rankingPending` ... back off to 30 seconds when idle. The idle 30-second poll refreshes the
 *   counts only; the visible list is reloaded by the 5-second busy poll". realistic: the first
 *   event (page load, t=0) is a list. After any list or counts response (both DTOs carry
 *   rankingPending: ArticleListResponseSchema, ArticleCountsSchema), the next event is a `list`
 *   5 s later if that response had rankingPending true, else a `counts` (GET /api/v1/articles/counts)
 *   30 s later. Event kinds: 'list' | 'counts' | 'action'.
 * - realistic actions (one open-or-rate per user): gap uniform in [10 s, 20 s], seeded.
 * - stress keeps 1 list/s and 1 action/s per user.
 * - src/load/commands.ts: `--profile <name>` (default realistic, anything else rejected) passed to
 *   runLoad as `profile`; ungated (stress) reports never set a failing exit code.
 * - buildReport takes `profile`; report.json has top-level `profile`, `listRatePerUser` and
 *   `countsRatePerUser`, `actionRatePerUser` (measured: total requests / total phase seconds / users;
 *   phases gain `countsRequests`) and
 *   `criteria.gated` (true for realistic, false for stress).
 */

const runLoad = vi.hoisted(() => vi.fn());
vi.mock('../src/load/run.js', () => ({ runLoad }));

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

describe('profile names', () => {
  it('lists exactly realistic and stress', () => {
    expect([...LOAD_PROFILES].sort()).toEqual(['realistic', 'stress']);
  });
  it('defaults to realistic and rejects everything else', () => {
    expect(parseLoadProfile(undefined)).toBe('realistic');
    expect(parseLoadProfile('realistic')).toBe('realistic');
    expect(parseLoadProfile('stress')).toBe('stress');
    for (const bad of ['', 'Stress', 'fast', 'realistic ', 'gated']) {
      expect(() => parseLoadProfile(bad)).toThrow();
    }
  });
});

describe('realistic polling (spec 09: list every 5 s while rankingPending, counts every 30 s idle)', () => {
  it('opens with a list at t=0', () => {
    for (const pendingAt of [PENDING, IDLE]) {
      expect(plan('realistic', { pendingAt }).find((e) => e.kind !== 'action')).toEqual({
        atMs: 0,
        kind: 'list',
      });
    }
  });
  it('lists every 5 s while every response is pending, and never polls counts', () => {
    const events = plan('realistic', { pendingAt: PENDING });
    const lists = times(
      events.filter((e) => !e.nav),
      'list',
    );
    expect(lists[0]).toBe(0);
    expect(gaps(lists).every((g) => g === 5000)).toBe(true);
    expect(lists).toHaveLength(12);
    expect(times(events, 'counts')).toEqual([]);
  });
  it('polls counts (not the list) every 30 s while idle', () => {
    const events = plan('realistic', { pendingAt: IDLE });
    expect(
      times(
        events.filter((e) => !e.nav),
        'list',
      ),
    ).toEqual([0]);
    expect(times(events, 'counts')).toEqual([30_000]);
    const long = plan('realistic', { durationMs: 300_000 });
    expect(
      times(
        long.filter((e) => !e.nav),
        'list',
      ),
    ).toEqual([0]);
    const c = times(long, 'counts');
    expect(c[0]).toBe(30_000);
    expect(gaps(c).every((g) => g === 30_000)).toBe(true);
    expect(c).toHaveLength(9);
  });
  it('the last response decides the next interval (pending then idle)', () => {
    const events = plan('realistic', { pendingAt: (t) => t < 20_000 });
    expect(
      times(
        events.filter((e) => !e.nav),
        'list',
      ),
    ).toEqual([0, 5000, 10_000, 15_000, 20_000]);
    expect(times(events, 'counts')).toEqual([50_000]);
  });
  it('a counts response with rankingPending switches back to 5 s lists (idle then pending)', () => {
    const events = plan('realistic', { pendingAt: (t) => t >= 30_000 && t < 45_000 });
    expect(times(events, 'counts')).toEqual([30_000]);
    expect(
      times(
        events.filter((e) => !e.nav),
        'list',
      ),
    ).toEqual([0, 35_000, 40_000, 45_000]);
    // the list at 45 s was idle, so the next poll is counts 30 s later (outside the 60 s run)
  });
  it('never schedules at or after the end of the run', () => {
    const events = plan('realistic', { pendingAt: PENDING, durationMs: 60_000 });
    expect(events.every((e) => e.atMs >= 0 && e.atMs < 60_000)).toBe(true);
    expect(events.map((e) => e.atMs)).toEqual([...events.map((e) => e.atMs)].sort((a, b) => a - b));
  });
});

describe('realistic actions (one open-or-rate every 10-20 s, seeded)', () => {
  const long = (over = {}) => plan('realistic', { durationMs: 3 * 3600_000, ...over });
  it('every gap is within [10 s, 20 s] and the gaps vary', () => {
    const g = gaps(times(long(), 'action'));
    expect(g.length).toBeGreaterThan(500);
    expect(g.every((x) => x >= 10_000 && x <= 20_000)).toBe(true);
    expect(new Set(g).size).toBeGreaterThan(50);
    const avg = g.reduce((a, b) => a + b, 0) / g.length;
    expect(avg).toBeGreaterThan(14_000);
    expect(avg).toBeLessThan(16_000);
  });
  it('the first action comes 10-20 s in, not at once', () => {
    const first = times(plan('realistic'), 'action')[0] as number;
    expect(first).toBeGreaterThanOrEqual(10_000);
    expect(first).toBeLessThanOrEqual(20_000);
  });
  it('does not depend on the list polling state', () => {
    expect(times(long({ pendingAt: PENDING }), 'action')).toEqual(
      times(long({ pendingAt: IDLE }), 'action'),
    );
  });
});

describe('seeded determinism', () => {
  it('the same seed and user give the same plan', () => {
    expect(plan('realistic', { pendingAt: PENDING })).toEqual(
      plan('realistic', { pendingAt: PENDING }),
    );
  });
  it('another seed or another user gives other action times', () => {
    const base = times(plan('realistic', { durationMs: 600_000 }), 'action');
    expect(times(plan('realistic', { durationMs: 600_000, seed: 8 }), 'action')).not.toEqual(base);
    expect(times(plan('realistic', { durationMs: 600_000, userIndex: 1 }), 'action')).not.toEqual(
      base,
    );
  });
});

describe("stress keeps today's 1 list/s and 1 action/s", () => {
  it('lists once a second whatever the pending state', () => {
    for (const pendingAt of [PENDING, IDLE]) {
      const lists = times(plan('stress', { pendingAt }), 'list');
      expect(gaps(lists).every((g) => g === 1000)).toBe(true);
      expect(lists.length).toBeGreaterThanOrEqual(59);
      expect(lists.length).toBeLessThanOrEqual(60);
    }
  });
  it('has no counts polling', () => {
    expect(times(plan('stress'), 'counts')).toEqual([]);
  });
  it('acts once a second', () => {
    const actions = times(plan('stress'), 'action');
    expect(gaps(actions).every((g) => g === 1000)).toBe(true);
    expect(actions.length).toBeGreaterThanOrEqual(59);
    expect(actions.length).toBeLessThanOrEqual(60);
  });
});

describe('runUserTraffic on a fake clock', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('lists at 5 s while pending, counts at 30 s once idle, and acts every 10-20 s', async () => {
    const listAt: number[] = [];
    const countsAt: number[] = [];
    const actionAt: number[] = [];
    let responses = 0;
    const answer = () => {
      responses += 1;
      return { rankingPending: responses <= 3 };
    };
    const done = runUserTraffic({
      profile: 'realistic',
      seed: 3,
      userIndex: 2,
      durationMs: 100_000,
      list: async () => {
        listAt.push(Date.now());
        return answer();
      },
      counts: async () => {
        countsAt.push(Date.now());
        return answer();
      },
      act: async () => {
        actionAt.push(Date.now());
      },
    });
    await vi.advanceTimersByTimeAsync(100_000);
    await done;
    const nav = new Set(
      planUserTraffic({
        profile: 'realistic',
        seed: 3,
        userIndex: 2,
        durationMs: 100_000,
        pendingAt: () => false,
      })
        .filter((e) => e.nav)
        .map((e) => e.atMs),
    );
    expect(listAt.filter((t) => !nav.has(t))).toEqual([0, 5000, 10_000, 15_000]);
    expect(countsAt).toEqual([45_000, 75_000]);
    expect(actionAt.length).toBeGreaterThanOrEqual(5);
    expect(actionAt.length).toBeLessThanOrEqual(10);
    expect(gaps(actionAt).every((g) => g >= 10_000 && g <= 20_000)).toBe(true);
    expect(actionAt[0]).toBeGreaterThanOrEqual(10_000);
  });

  it('stress runs both once a second', async () => {
    let lists = 0;
    let acts = 0;
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
      act: async () => {
        acts += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(lists).toBeGreaterThanOrEqual(29);
    expect(lists).toBeLessThanOrEqual(30);
    expect(acts).toBeGreaterThanOrEqual(29);
    expect(acts).toBeLessThanOrEqual(30);
  });
});

function measure(name: PhaseMeasure['name'], overrides: Partial<PhaseMeasure> = {}): PhaseMeasure {
  return {
    name,
    startedAt: '2026-10-11T10:00:00.000Z',
    endedAt: '2026-10-11T10:01:00.000Z',
    durationSec: 60,
    // 200 list, 16 counts and 80 action requests per 60 s phase for 20 users.
    articleLatenciesMs: Array.from({ length: 200 }, (_, i) => (i % 100) + 1),
    actionRequests: 80,
    countsRequests: 16,
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
    ...overrides,
  };
}

const report = (profile: LoadProfile, measures = PHASE_NAMES.map((n) => measure(n))) =>
  buildReport({
    profile,
    host: { cpus: 8, memTotal: 16e9 },
    durationMin: 4,
    articles: 1000,
    traffic: { listRatePerUser: 1, actionRatePerUser: 1, listPageLimit: 30 },
    measures,
    generatedAt: '2026-10-11T10:05:00.000Z',
  } as Parameters<typeof buildReport>[0]) as ReturnType<typeof buildReport> & {
    profile: string;
    listRatePerUser: number;
    countsRatePerUser: number;
    actionRatePerUser: number;
    criteria: { gated: boolean };
  };

describe('report builder', () => {
  it('records the profile and the measured per-user rates', () => {
    const r = report('realistic');
    expect(r.profile).toBe('realistic');
    // 800 list requests / 240 s / 20 users and 320 actions / 240 s / 20 users.
    expect(r.listRatePerUser).toBeCloseTo(800 / 240 / 20, 3);
    expect(r.countsRatePerUser).toBeCloseTo(64 / 240 / 20, 3);
    expect(r.actionRatePerUser).toBeCloseTo(320 / 240 / 20, 3);
    expect(
      r.phases.every((ph) => (ph as unknown as { countsRequests: number }).countsRequests === 16),
    ).toBe(true);
  });
  it('measures from the requests actually made, not from the plan', () => {
    const slow = PHASE_NAMES.map((n) =>
      measure(n, {
        articleLatenciesMs: Array.from({ length: 2400 }, () => 5),
        actionRequests: 960,
        countsRequests: 160,
      }),
    );
    const r = report('stress', slow);
    expect(r.listRatePerUser).toBeCloseTo(9600 / 240 / 20, 3);
    expect(r.countsRatePerUser).toBeCloseTo(640 / 240 / 20, 3);
    expect(r.actionRatePerUser).toBeCloseTo(3840 / 240 / 20, 3);
  });
  it('realistic is gated, stress is not', () => {
    expect(report('realistic').criteria.gated).toBe(true);
    expect(report('stress').criteria.gated).toBe(false);
  });
  it('stress still reports the criteria values it measured (over 300 ms shows as not ok)', () => {
    const slow = PHASE_NAMES.map((n) =>
      measure(n, { articleLatenciesMs: Array.from({ length: 100 }, () => 450) }),
    );
    const r = report('stress', slow);
    expect(r.criteria.gated).toBe(false);
    expect(r.criteria.p95Ok).toBe(false);
  });
  it('counts requests never enter the GET /articles latency sample', () => {
    const r = report('realistic');
    expect(r.phases.every((ph) => ph.requests === 200)).toBe(true);
  });
  it('keeps the T8 fields', () => {
    expect(report('realistic')).toMatchObject({
      users: 20,
      feedsPerUser: 50,
      cardsPerUser: 10,
      criteria: { cpuGated: false },
    });
  });
  it('the markdown names the profile and marks stress as not gated', () => {
    expect(renderMarkdown(report('stress'))).toMatch(/profile.{0,20}stress/i);
    expect(renderMarkdown(report('stress'))).toMatch(/not gated|ungated/i);
    expect(renderMarkdown(report('realistic'))).toMatch(/profile.{0,20}realistic/i);
    expect(renderMarkdown(report('realistic'))).not.toMatch(/not gated|ungated/i);
  });
});

describe('load:run CLI', () => {
  async function invoke(args: string[], criteria: Record<string, unknown>) {
    const { registerLoadCommands } = await import('../src/load/commands.js');
    runLoad.mockReset();
    runLoad.mockResolvedValue({ criteria });
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerLoadCommands(program);
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await program.parseAsync([
        'node',
        'cli',
        'load:run',
        '--duration',
        '2',
        '--out',
        '/x',
        ...args,
      ]);
    } finally {
      logSpy.mockRestore();
    }
  }
  const good = { p95Ok: true, backlogOk: true, allOffZeroInference: true, degradedReadingOk: true };
  const bad = { ...good, p95Ok: false };
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('defaults to realistic', async () => {
    await invoke([], { ...good, gated: true });
    expect(runLoad).toHaveBeenCalledWith(expect.objectContaining({ profile: 'realistic' }));
  });
  it('accepts --profile stress and --profile realistic', async () => {
    await invoke(['--profile', 'stress'], { ...good, gated: false });
    expect(runLoad).toHaveBeenCalledWith(expect.objectContaining({ profile: 'stress' }));
    await invoke(['--profile', 'realistic'], { ...good, gated: true });
    expect(runLoad).toHaveBeenCalledWith(expect.objectContaining({ profile: 'realistic' }));
  });
  it('rejects any other profile before running anything', async () => {
    await expect(invoke(['--profile', 'turbo'], good)).rejects.toThrow();
    expect(runLoad).not.toHaveBeenCalled();
  });
  it('a failed gated (realistic) run exits 1', async () => {
    await invoke([], { ...bad, gated: true });
    expect(process.exitCode).toBe(1);
  });
  it('a stress run never fails the command, even over 300 ms', async () => {
    await invoke(['--profile', 'stress'], { ...bad, gated: false });
    expect(process.exitCode).not.toBe(1);
  });
});
