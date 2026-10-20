import {
  BreakerStateSchema,
  EngineCircuitSchema,
  systemClock,
  type BreakerState,
} from '@bantoozi/shared';
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
  releaseProbe,
  renewProbe,
  tripBreaker,
} from '../src/breaker.js';
import { captureLogger } from './support/router-fixtures.js';

const P = DEFAULT_BREAKER_PARAMS;
const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();
const CLOSED: BreakerState = { state: 'closed', reopenCount: 0 };
const TOKEN = '11111111-1111-4111-8111-111111111111';

const halfOpen = (extra: Record<string, unknown> = {}): BreakerState =>
  ({
    state: 'half_open',
    openedAt: iso(10 * MIN),
    openUntil: iso(12 * MIN),
    reopenCount: 2,
    probeToken: TOKEN,
    probeUntil: iso(14 * MIN),
    ...extra,
  }) as BreakerState;

const legacyOpen = (): BreakerState => ({
  state: 'open',
  openedAt: iso(0),
  openUntil: iso(2 * MIN),
  reopenCount: 0,
});

describe('breaker failing streak: pure transitions', () => {
  it('trip sets failingSince equal to openedAt', () => {
    const open = tripBreaker(CLOSED, at(0), P);
    expect(open).toEqual({
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 0,
      failingSince: iso(0),
    });
  });

  it('acquireProbe carries failingSince unchanged', () => {
    const open = tripBreaker(CLOSED, at(0), P)!;
    const half = acquireProbe(open, at(2 * MIN), TOKEN, P)!;
    expect(half).toMatchObject({ state: 'half_open', failingSince: iso(0) });
  });

  it('acquireProbe on a legacy open state adds no failingSince', () => {
    const half = acquireProbe(legacyOpen(), at(2 * MIN), TOKEN, P)!;
    expect(half.state).toBe('half_open');
    expect(half).not.toHaveProperty('failingSince');
  });

  it('releaseProbe and renewProbe carry failingSince unchanged', () => {
    const half = halfOpen({ failingSince: iso(0) });
    expect(releaseProbe(half, TOKEN)).toMatchObject({ state: 'half_open', failingSince: iso(0) });
    expect(renewProbe(half, TOKEN, at(11 * MIN), P)).toMatchObject({
      state: 'half_open',
      failingSince: iso(0),
    });
  });

  it('releaseProbe and renewProbe of a legacy half-open state add no failingSince', () => {
    const half = halfOpen();
    expect(releaseProbe(half, TOKEN)).not.toHaveProperty('failingSince');
    expect(renewProbe(half, TOKEN, at(11 * MIN), P)).not.toHaveProperty('failingSince');
  });

  it('a failed probe re-opens with a fresh openedAt and the old failingSince', () => {
    const half = halfOpen({ failingSince: iso(0) });
    expect(completeProbe(half, TOKEN, false, at(13 * MIN), P)).toEqual({
      state: 'open',
      openedAt: iso(13 * MIN),
      openUntil: iso(13 * MIN + 16 * MIN),
      reopenCount: 3,
      failingSince: iso(0),
    });
  });

  it('five trip, probe, fail cycles keep failingSince and move openedAt every time', () => {
    let state: BreakerState = tripBreaker(CLOSED, at(0), P)!;
    const first = state.openedAt!;
    const openedAts = [state.openedAt!];
    for (let i = 0; i < 5; i += 1) {
      const probeAt = Date.parse(state.openUntil!) - T0;
      const half = acquireProbe(state, at(probeAt), TOKEN, P)!;
      state = completeProbe(half, TOKEN, false, at(probeAt + 1_000), P)!;
      expect(state.failingSince).toBe(first);
      expect(state.state).toBe('open');
      openedAts.push(state.openedAt!);
    }
    expect(new Set(openedAts).size).toBe(6);
    expect(
      openedAts.slice(1).every((value, i) => Date.parse(value) > Date.parse(openedAts[i]!)),
    ).toBe(true);
    expect(state.failingSince).toBe(iso(0));
    expect(state.reopenCount).toBe(5);
  });

  it('a successful probe closes to exactly the closed state without failingSince', () => {
    const half = halfOpen({ failingSince: iso(0) });
    expect(completeProbe(half, TOKEN, true, at(13 * MIN), P)).toStrictEqual({
      state: 'closed',
      reopenCount: 0,
    });
  });

  it('a failed probe of a legacy open state without failingSince falls back to its openedAt', () => {
    const half = acquireProbe(legacyOpen(), at(2 * MIN), TOKEN, P)!;
    const reopened = completeProbe(half, TOKEN, false, at(3 * MIN), P)!;
    expect(reopened).toMatchObject({
      state: 'open',
      openedAt: iso(3 * MIN),
      reopenCount: 1,
      failingSince: iso(0),
    });
  });

  it('a failed probe of a half-open state with neither failingSince nor openedAt omits it', () => {
    const half: BreakerState = {
      state: 'half_open',
      reopenCount: 0,
      probeToken: TOKEN,
      probeUntil: iso(5 * MIN),
    };
    const reopened = completeProbe(half, TOKEN, false, at(MIN), P)!;
    expect(reopened.state).toBe('open');
    expect(reopened).not.toHaveProperty('failingSince');
  });

  it('enterAuthMode from closed starts the streak now', () => {
    expect(enterAuthMode({ state: 'closed', reopenCount: 2 }, at(5 * MIN))).toEqual({
      state: 'auth',
      openedAt: iso(5 * MIN),
      reopenCount: 2,
      failingSince: iso(5 * MIN),
    });
  });

  it('enterAuthMode from open keeps the streak start of the open state', () => {
    const open = { ...legacyOpen(), failingSince: iso(-20 * MIN) } as BreakerState;
    expect(enterAuthMode(open, at(5 * MIN))).toEqual({
      state: 'auth',
      openedAt: iso(5 * MIN),
      reopenCount: 0,
      failingSince: iso(-20 * MIN),
    });
  });

  it('enterAuthMode from half_open keeps the streak start', () => {
    const half = halfOpen({ failingSince: iso(-20 * MIN) });
    expect(enterAuthMode(half, at(15 * MIN))).toMatchObject({
      state: 'auth',
      openedAt: iso(15 * MIN),
      failingSince: iso(-20 * MIN),
    });
  });

  it('enterAuthMode from a legacy open state uses its openedAt', () => {
    expect(enterAuthMode(legacyOpen(), at(5 * MIN))).toEqual({
      state: 'auth',
      openedAt: iso(5 * MIN),
      reopenCount: 0,
      failingSince: iso(0),
    });
  });

  it('enterAuthMode from a legacy half-open state uses its openedAt', () => {
    expect(enterAuthMode(halfOpen(), at(15 * MIN))).toMatchObject({
      state: 'auth',
      failingSince: iso(10 * MIN),
    });
  });

  it('applyReset closes any state with failingSince to exactly the closed state', () => {
    const open = { ...legacyOpen(), failingSince: iso(0) } as BreakerState;
    expect(applyReset(open, at(5 * MIN))).toStrictEqual({ state: 'closed', reopenCount: 0 });
    const auth = {
      state: 'auth',
      openedAt: iso(0),
      reopenCount: 1,
      failingSince: iso(0),
    } as BreakerState;
    expect(applyReset(auth, at(5 * MIN))).toStrictEqual({ state: 'closed', reopenCount: 0 });
  });
});

describe('breaker failing streak: schema', () => {
  it('accepts an ISO failingSince and keeps it', () => {
    const parsed = BreakerStateSchema.safeParse({
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 1,
      failingSince: iso(-MIN),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ failingSince: iso(-MIN) });
  });

  it('still accepts a state without failingSince', () => {
    expect(BreakerStateSchema.safeParse(legacyOpen()).success).toBe(true);
  });

  it('rejects a failingSince that is not an ISO datetime', () => {
    expect(
      BreakerStateSchema.safeParse({ ...legacyOpen(), failingSince: 'yesterday' }).success,
    ).toBe(false);
  });

  it('still rejects unknown keys', () => {
    expect(
      BreakerStateSchema.safeParse({ ...legacyOpen(), failingSince: iso(0), streak: 1 }).success,
    ).toBe(false);
  });

  it('accepts failingSince inside the engine circuit', () => {
    const parsed = EngineCircuitSchema.safeParse({
      ...defaultCircuit(),
      typesafe: { ...legacyOpen(), failingSince: iso(0) },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('breaker failing streak: coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const build = () => {
    const store = createMemoryCircuitStore();
    const coordinator = createBreakerCoordinator({
      store,
      clock: systemClock,
      logger: captureLogger(),
    });
    return { store, coordinator };
  };

  async function trip(coordinator: ReturnType<typeof build>['coordinator']) {
    for (let i = 0; i < 15; i += 1) await coordinator.record('typesafe', 'success');
    for (let i = 0; i < 5; i += 1) await coordinator.record('typesafe', 'failure');
  }

  it('trips with failingSince equal to openedAt', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    expect((await store.readCircuit()).typesafe).toEqual({
      state: 'open',
      openedAt: iso(0),
      openUntil: iso(2 * MIN),
      reopenCount: 0,
      failingSince: iso(0),
    });
  });

  it('five failed probes keep failingSince and give each re-open a fresh, different openedAt', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    const openedAts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const before = (await store.readCircuit()).typesafe;
      openedAts.push(before.openedAt!);
      vi.setSystemTime(Date.parse(before.openUntil!));
      const admission = await coordinator.admit('typesafe');
      expect(admission).toMatchObject({ ok: true });
      await coordinator.record(
        'typesafe',
        'failure',
        admission.ok ? admission.probeToken : undefined,
      );
      const after = (await store.readCircuit()).typesafe;
      expect(after.state).toBe('open');
      expect(after.failingSince).toBe(iso(0));
      expect(Date.parse(after.openedAt!)).toBe(Date.parse(before.openUntil!));
      expect(after.openedAt).not.toBe(before.openedAt);
    }
    expect(new Set(openedAts).size).toBe(5);
    expect((await store.readCircuit()).typesafe.reopenCount).toBe(5);
  });

  it('a half-open state keeps failingSince while the lease is held and after a neutral release', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    vi.setSystemTime(T0 + 2 * MIN);
    const admission = await coordinator.admit('typesafe');
    expect((await store.readCircuit()).typesafe).toMatchObject({
      state: 'half_open',
      failingSince: iso(0),
    });
    expect(await coordinator.renew('typesafe', admission.ok ? admission.probeToken! : '')).toBe(
      true,
    );
    expect((await store.readCircuit()).typesafe.failingSince).toBe(iso(0));
    await coordinator.record(
      'typesafe',
      'neutral',
      admission.ok ? admission.probeToken : undefined,
    );
    expect((await store.readCircuit()).typesafe).toMatchObject({
      state: 'half_open',
      failingSince: iso(0),
    });
  });

  it('a successful probe closes to exactly the closed state', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    vi.setSystemTime(T0 + 2 * MIN);
    const admission = await coordinator.admit('typesafe');
    await coordinator.record(
      'typesafe',
      'success',
      admission.ok ? admission.probeToken : undefined,
    );
    expect((await store.readCircuit()).typesafe).toStrictEqual({ state: 'closed', reopenCount: 0 });
  });

  it('a legacy open state without failingSince gets its openedAt as failingSince on the first failed probe', async () => {
    const store = createMemoryCircuitStore({
      ...defaultCircuit(),
      typesafe: legacyOpen(),
    });
    const coordinator = createBreakerCoordinator({
      store,
      clock: systemClock,
      logger: captureLogger(),
    });
    vi.setSystemTime(T0 + 2 * MIN);
    const admission = await coordinator.admit('typesafe');
    expect(admission).toMatchObject({ ok: true });
    await coordinator.record(
      'typesafe',
      'failure',
      admission.ok ? admission.probeToken : undefined,
    );
    expect((await store.readCircuit()).typesafe).toMatchObject({
      state: 'open',
      openedAt: iso(2 * MIN),
      reopenCount: 1,
      failingSince: iso(0),
    });
  });

  it('auth failure from a tripped breaker keeps the streak start', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    vi.setSystemTime(T0 + 5 * MIN);
    await coordinator.authFailure('typesafe', { provider: 'typesafe', version: null });
    expect((await store.readCircuit()).typesafe).toMatchObject({
      state: 'auth',
      openedAt: iso(5 * MIN),
      failingSince: iso(0),
    });
  });

  it('auth failure from a closed breaker starts the streak now', async () => {
    const { store, coordinator } = build();
    vi.setSystemTime(T0 + 5 * MIN);
    await coordinator.authFailure('typesafe', { provider: 'typesafe', version: null });
    expect((await store.readCircuit()).typesafe).toMatchObject({
      state: 'auth',
      failingSince: iso(5 * MIN),
    });
  });

  it('an admin reset closes a tripped breaker without failingSince', async () => {
    const { store, coordinator } = build();
    await trip(coordinator);
    const circuit = await store.readCircuit();
    vi.setSystemTime(T0 + 5 * MIN);
    store.write({ ...circuit, resetRequested: { typesafe: iso(5 * MIN) } });
    vi.setSystemTime(T0 + 5 * MIN + P.pollMs);
    await coordinator.admit('typesafe');
    expect((await store.readCircuit()).typesafe).toStrictEqual({ state: 'closed', reopenCount: 0 });
  });
});
