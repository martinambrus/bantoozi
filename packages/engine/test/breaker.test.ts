import { systemClock, type BreakerState, type EngineCircuit } from '@bantoozi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireProbe,
  applyReset,
  completeProbe,
  createBreakerCoordinator,
  createMemoryCircuitStore,
  DEFAULT_BREAKER_PARAMS,
  defaultCircuit,
  enterAuthMode,
  evaluateBreaker,
  FailureWindow,
  openDurationMs,
  releaseProbe,
  renewProbe,
  tripBreaker,
  type BreakerCoordinator,
  type CircuitStore,
} from '../src/breaker.js';
import { captureLogger } from './support/router-fixtures.js';

const P = DEFAULT_BREAKER_PARAMS;
const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();
const MIN = 60_000;

describe('breaker transitions (pure, spec 04 §5)', () => {
  it('opens for 2 minutes, doubling per consecutive re-open, capped at 30 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => openDurationMs(n, P) / MIN)).toEqual([
      2, 4, 8, 16, 30, 30, 30,
    ]);
  });

  it('trips only a closed breaker', () => {
    const open = tripBreaker({ state: 'closed', reopenCount: 0 }, at(0), P);
    expect(open).toEqual({
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 0,
    });
    expect(tripBreaker(open!, at(1), P)).toBeNull();
  });

  it('grants one probe lease after openUntil, reclaimable once expired', () => {
    const open: BreakerState = {
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 0,
    };
    expect(acquireProbe(open, at(MIN), 'a', P)).toBeNull();
    const half = acquireProbe(open, at(2 * MIN), 'a', P)!;
    expect(half).toMatchObject({
      state: 'half_open',
      probeToken: 'a',
      probeUntil: iso(2 * MIN + P.probeLeaseMs),
    });
    expect(acquireProbe(half, at(2 * MIN + 1_000), 'b', P)).toBeNull();
    expect(acquireProbe(half, at(2 * MIN + P.probeLeaseMs), 'b', P)).toMatchObject({
      probeToken: 'b',
    });
    expect(acquireProbe({ state: 'closed', reopenCount: 0 }, at(0), 'x', P)).toBeNull();
  });

  it('lets only the lease holder complete the probe', () => {
    const half: BreakerState = {
      state: 'half_open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 1,
      probeToken: 'a',
      probeUntil: iso(5 * MIN),
    };
    expect(completeProbe(half, 'b', true, at(3 * MIN), P)).toBeNull();
    expect(completeProbe(half, 'a', true, at(3 * MIN), P)).toEqual({
      state: 'closed',
      reopenCount: 0,
    });
    expect(completeProbe(half, 'a', false, at(3 * MIN), P)).toEqual({
      state: 'open',
      openedAt: iso(3 * MIN),
      openUntil: iso(3 * MIN + 8 * MIN),
      reopenCount: 2,
    });
    expect(releaseProbe(half, 'b')).toBeNull();
    expect(releaseProbe(half, 'a')).toEqual({
      state: 'half_open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 1,
    });
  });

  it("renews only the lease holder's probe lease", () => {
    const half: BreakerState = {
      state: 'half_open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 1,
      probeToken: 'a',
      probeUntil: iso(2 * MIN + P.probeLeaseMs),
    };
    expect(renewProbe(half, 'a', at(4 * MIN), P)).toEqual({
      ...half,
      probeUntil: iso(4 * MIN + P.probeLeaseMs),
    });
    expect(renewProbe(half, 'b', at(4 * MIN), P)).toBeNull();
    expect(renewProbe(releaseProbe(half, 'a')!, 'a', at(4 * MIN), P)).toBeNull();
    expect(renewProbe({ state: 'closed', reopenCount: 0 }, 'a', at(4 * MIN), P)).toBeNull();
  });

  it('enters auth mode from any other state', () => {
    expect(enterAuthMode({ state: 'closed', reopenCount: 2 }, at(0))).toEqual({
      state: 'auth',
      openedAt: iso(0),
      reopenCount: 2,
    });
    expect(enterAuthMode({ state: 'auth', openedAt: iso(0), reopenCount: 0 }, at(1))).toBeNull();
  });

  it('resets only an incident that began before the reset request', () => {
    const auth: BreakerState = { state: 'auth', openedAt: iso(0), reopenCount: 3 };
    expect(applyReset(auth, at(1))).toEqual({ state: 'closed', reopenCount: 0 });
    expect(applyReset(auth, at(-1))).toBeNull();
    expect(applyReset({ state: 'closed', reopenCount: 0 }, at(1))).toBeNull();
    expect(applyReset({ state: 'closed', reopenCount: 2 }, at(1))).toEqual({
      state: 'closed',
      reopenCount: 0,
    });
  });

  it('evaluates admission for every state', () => {
    expect(evaluateBreaker({ state: 'closed', reopenCount: 0 }, at(0))).toEqual({
      admit: 'closed',
    });
    expect(evaluateBreaker({ state: 'auth', reopenCount: 0 }, at(0))).toEqual({
      admit: 'deny',
      auth: true,
    });
    const open: BreakerState = {
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(MIN),
      reopenCount: 0,
    };
    expect(evaluateBreaker(open, at(0))).toEqual({ admit: 'deny', auth: false, retryAt: at(MIN) });
    expect(evaluateBreaker(open, at(MIN))).toEqual({ admit: 'probe' });
    const leased: BreakerState = {
      state: 'half_open',
      reopenCount: 0,
      probeToken: 'a',
      probeUntil: iso(MIN),
    };
    expect(evaluateBreaker(leased, at(0))).toEqual({
      admit: 'deny',
      auth: false,
      retryAt: at(MIN),
    });
    expect(evaluateBreaker(leased, at(MIN))).toEqual({ admit: 'probe' });
    expect(evaluateBreaker({ state: 'half_open', reopenCount: 0 }, at(0))).toEqual({
      admit: 'probe',
    });
  });
});

describe('FailureWindow', () => {
  it('needs 20 requests and more than 20 % failures within 5 minutes', () => {
    const window = new FailureWindow();
    for (let i = 0; i < 15; i += 1) window.record(T0, false);
    for (let i = 0; i < 4; i += 1) window.record(T0, true);
    expect(window.shouldTrip(T0, P)).toBe(false); // 21 % but only 19 requests
    window.record(T0, true);
    expect(window.shouldTrip(T0, P)).toBe(true); // 5 of 20
  });

  it('does not trip at exactly 20 % and forgets entries older than the window', () => {
    const window = new FailureWindow();
    for (let i = 0; i < 20; i += 1) window.record(T0, i < 4);
    expect(window.shouldTrip(T0, P)).toBe(false);
    window.record(T0 + 1, true);
    expect(window.shouldTrip(T0 + 1, P)).toBe(true);
    expect(window.shouldTrip(T0 + 5 * MIN + 1, P)).toBe(false);
    expect(window.counts()).toEqual({ requests: 1, failures: 1 });
  });
});

describe('createBreakerCoordinator (shared state, spec 04 §5)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function coordinator(store: CircuitStore, logger = captureLogger()): BreakerCoordinator {
    return createBreakerCoordinator({ store, clock: systemClock, logger });
  }

  async function fail(
    c: BreakerCoordinator,
    engine: 'typesafe' | 'llm',
    failures: number,
    successes = 0,
  ) {
    for (let i = 0; i < successes; i += 1) await c.record(engine, 'success');
    for (let i = 0; i < failures; i += 1) await c.record(engine, 'failure');
  }

  it('opens the shared state after the window trips, and logs it', async () => {
    const store = createMemoryCircuitStore();
    const logger = captureLogger();
    const c = coordinator(store, logger);
    await fail(c, 'typesafe', 5, 15);
    expect((await store.readCircuit()).typesafe).toEqual({
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 0,
    });
    expect(await c.admit('typesafe')).toEqual({ ok: false, auth: false, retryAt: at(2 * MIN) });
    expect(logger.entries.map((e) => e.msg)).toContain('engine breaker opened');
  });

  it('ignores neutral outcomes', async () => {
    const store = createMemoryCircuitStore();
    const c = coordinator(store);
    for (let i = 0; i < 50; i += 1) await c.record('typesafe', 'neutral');
    await fail(c, 'typesafe', 4, 16);
    expect((await store.readCircuit()).typesafe.state).toBe('closed');
  });

  it('doubles the open duration per failed probe up to 30 minutes, and resets on success', async () => {
    const store = createMemoryCircuitStore();
    const c = coordinator(store);
    await fail(c, 'llm', 5, 15);
    const durations: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const state = (await store.readCircuit()).llm;
      const until = Date.parse(state.openUntil!);
      durations.push((until - Date.parse(state.openedAt!)) / MIN);
      vi.setSystemTime(until);
      const admission = await c.admit('llm');
      expect(admission).toMatchObject({ ok: true });
      await c.record('llm', 'failure', admission.ok ? admission.probeToken : undefined);
    }
    expect(durations).toEqual([2, 4, 8, 16, 30]);
    vi.setSystemTime(Date.parse((await store.readCircuit()).llm.openUntil!));
    const probe = await c.admit('llm');
    await c.record('llm', 'success', probe.ok ? probe.probeToken : undefined);
    expect((await store.readCircuit()).llm).toEqual({ state: 'closed', reopenCount: 0 });
  });

  it('grants the half-open probe to one router only', async () => {
    const store = createMemoryCircuitStore();
    const a = coordinator(store);
    const b = coordinator(store);
    await fail(a, 'typesafe', 5, 15);
    vi.setSystemTime(T0 + 2 * MIN);
    const probe = await a.admit('typesafe');
    expect(probe.ok && probe.probeToken).toBeTruthy();
    expect(await b.admit('typesafe')).toEqual({
      ok: false,
      auth: false,
      retryAt: at(2 * MIN + P.probeLeaseMs),
    });
    await a.record('typesafe', 'success', probe.ok ? probe.probeToken : undefined);
    vi.setSystemTime(T0 + 2 * MIN + P.pollMs);
    expect(await b.admit('typesafe')).toEqual({ ok: true });
  });

  it('lets another router reclaim an expired probe lease; the late holder changes nothing', async () => {
    const store = createMemoryCircuitStore();
    const a = coordinator(store);
    const b = coordinator(store);
    await fail(a, 'typesafe', 5, 15);
    vi.setSystemTime(T0 + 2 * MIN);
    const crashed = await a.admit('typesafe');
    vi.setSystemTime(T0 + 2 * MIN + P.probeLeaseMs);
    const reclaimed = await b.admit('typesafe');
    expect(reclaimed.ok && reclaimed.probeToken).toBeTruthy();
    await b.record('typesafe', 'success', reclaimed.ok ? reclaimed.probeToken : undefined);
    await a.record('typesafe', 'failure', crashed.ok ? crashed.probeToken : undefined);
    expect((await store.readCircuit()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
  });

  it('keeps a renewed probe lease from another router; a reclaimed one cannot be renewed', async () => {
    const store = createMemoryCircuitStore();
    const a = coordinator(store);
    const b = coordinator(store);
    await fail(a, 'typesafe', 5, 15);
    vi.setSystemTime(T0 + 2 * MIN);
    const probe = await a.admit('typesafe');
    const token = probe.ok ? probe.probeToken! : '';
    vi.setSystemTime(T0 + 2 * MIN + P.probeLeaseMs - 1_000);
    expect(await a.renew('typesafe', token)).toBe(true);
    vi.setSystemTime(T0 + 2 * MIN + P.probeLeaseMs + 1_000);
    expect(await b.admit('typesafe')).toMatchObject({ ok: false, auth: false });
    // Once the renewed lease expires too, another router reclaims it and the old holder's renewal
    // fails, so it never sends a second concurrent probe.
    vi.setSystemTime(T0 + 2 * MIN + 2 * P.probeLeaseMs);
    const reclaimed = await b.admit('typesafe');
    expect(reclaimed.ok && reclaimed.probeToken).toBeTruthy();
    expect(await a.renew('typesafe', token)).toBe(false);
  });

  it('releases the probe lease for a neutral outcome', async () => {
    const store = createMemoryCircuitStore();
    const c = coordinator(store);
    await fail(c, 'typesafe', 5, 15);
    vi.setSystemTime(T0 + 2 * MIN);
    const probe = await c.admit('typesafe');
    await c.record('typesafe', 'neutral', probe.ok ? probe.probeToken : undefined);
    const state = (await store.readCircuit()).typesafe;
    expect(state.state).toBe('half_open');
    expect(state.probeToken).toBeUndefined();
    expect(await coordinator(store).admit('typesafe')).toMatchObject({ ok: true });
  });

  it('enters auth mode only for the active credential version', async () => {
    const store = createMemoryCircuitStore();
    const c = coordinator(store);
    store.setActiveCredential('typesafe', '8');
    await c.authFailure('typesafe', { provider: 'typesafe', version: '7' });
    expect((await store.readCircuit()).typesafe.state).toBe('closed');
    await c.authFailure('typesafe', { provider: 'typesafe', version: '8' });
    expect((await store.readCircuit()).typesafe.state).toBe('auth');
    expect(await c.admit('typesafe')).toEqual({ ok: false, auth: true });
    // An environment key (no DB version) counts while no DB row exists.
    store.setActiveCredential('ollama', null);
    await c.authFailure('llm', { provider: 'ollama', version: null });
    expect((await store.readCircuit()).llm.state).toBe('auth');
  });

  it('applies a reset request within one poll, once', async () => {
    const store = createMemoryCircuitStore();
    const a = coordinator(store);
    store.setActiveCredential('typesafe', '1');
    await a.authFailure('typesafe', { provider: 'typesafe', version: '1' });
    const b = coordinator(store);
    expect(await b.admit('typesafe')).toMatchObject({ ok: false, auth: true });
    vi.setSystemTime(T0 + 1_000);
    store.write({ ...(await store.readCircuit()), resetRequested: { typesafe: iso(1_000) } });
    vi.setSystemTime(T0 + 1_000 + P.pollMs);
    expect(await b.admit('typesafe')).toEqual({ ok: true });
    expect((await store.readCircuit()).typesafe).toEqual({ state: 'closed', reopenCount: 0 });
    // A new incident after the reset is not cleared by the same (already seen) request.
    await a.authFailure('typesafe', { provider: 'typesafe', version: '1' });
    vi.setSystemTime(T0 + 1_000 + 3 * P.pollMs);
    expect(await b.admit('typesafe')).toMatchObject({ ok: false, auth: true });
    expect((await store.readCircuit()).resetRequested.typesafe).toBe(iso(1_000));
  });

  it('never loses another engine’s update when two routers write from stale caches', async () => {
    const store = createMemoryCircuitStore();
    const a = coordinator(store);
    const b = coordinator(store);
    // Both routers cache the all-closed state.
    await a.states();
    await b.states();
    await fail(a, 'typesafe', 5, 15);
    await fail(b, 'llm', 5, 15);
    const circuit = await store.readCircuit();
    expect(circuit.typesafe.state).toBe('open');
    expect(circuit.llm.state).toBe('open');
  });

  it('re-reads the shared state at most once per poll interval', async () => {
    const store = createMemoryCircuitStore();
    const reads = vi.spyOn(store, 'readCircuit');
    const c = coordinator(store);
    await Promise.all([c.admit('typesafe'), c.admit('llm'), c.states()]);
    await c.admit('typesafe');
    expect(reads).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + P.pollMs);
    await c.admit('typesafe');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('retries a reset whose write failed on the next poll', async () => {
    const memory = createMemoryCircuitStore();
    memory.setActiveCredential('typesafe', '1');
    await coordinator(memory).authFailure('typesafe', { provider: 'typesafe', version: '1' });
    memory.write({ ...(await memory.readCircuit()), resetRequested: { typesafe: iso(1) } });
    let failNext = true;
    const flaky: CircuitStore = {
      readCircuit: () => memory.readCircuit(),
      updateCircuit: async (engine, update, options) => {
        if (failNext) {
          failNext = false;
          throw new Error('lock timeout');
        }
        return memory.updateCircuit(engine, update, options);
      },
    };
    vi.setSystemTime(T0 + 10);
    const c = coordinator(flaky);
    await expect(c.admit('typesafe')).rejects.toThrow('lock timeout');
    expect(await c.admit('typesafe')).toEqual({ ok: true });
  });

  it('validates stored values in the memory store', () => {
    const store = createMemoryCircuitStore();
    expect(() =>
      store.write({
        ...defaultCircuit(),
        typesafe: { state: 'bogus' },
      } as unknown as EngineCircuit),
    ).toThrow();
  });
});
