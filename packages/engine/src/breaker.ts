import {
  EngineCircuitSchema,
  newUuid,
  settingDefault,
  type BreakerState,
  type Clock,
  type EngineCircuit,
} from '@bantoozi/shared';

import type { EngineLogger } from './types.js';

/**
 * Circuit breaker of the engine router (spec 04 §5). Each process keeps a **local** rolling window
 * of logical-request outcomes per provider; the **shared** state per engine lives in
 * `settings['engine.circuit']` (spec 02 §2), which is authoritative:
 *
 * - `closed` → `open` after ≥ 20 logical requests within 5 minutes with more than 20 % failures
 *   (final `error`/`timeout`/`rate_limited`/`invalid_response`; budget, cancellation and invalid
 *   requests are not failures).
 * - `open` for 2 minutes, doubling per consecutive re-open (`reopenCount`), capped at 30 minutes.
 * - after `openUntil` one router acquires the single half-open probe lease (`probeToken`,
 *   `probeUntil`) in the same transaction as the state change; only that lease holder completes the
 *   transition (success closes and resets the doubling, failure re-opens). An expired lease can be
 *   reclaimed after a crash.
 * - a 401/403 of the credential version currently active sets `auth` until an explicit admin reset;
 *   a late 401 from a superseded credential version cannot disable its replacement.
 * - `resetRequested[engine]` newer than a router's last seen reset discards its local window and
 *   closes that engine (also from `auth`), within one poll of at most every 10 seconds.
 *
 * The transition functions are pure; {@link createBreakerCoordinator} applies them through a
 * {@link CircuitStore} that updates one engine entry atomically under the settings row lock,
 * preserving the other engine and `resetRequested` (never writing a stale process-local copy).
 */

export type BreakerEngine = 'typesafe' | 'llm';
export const BREAKER_ENGINES: readonly BreakerEngine[] = ['typesafe', 'llm'];

export interface BreakerParams {
  /** Rolling window of logical requests. */
  windowMs: number;
  /** Minimum logical requests in the window before the breaker may open. */
  minRequests: number;
  /** Open when failures / requests exceeds this share. */
  failureRatio: number;
  /** First open duration; doubles per consecutive re-open. */
  baseOpenMs: number;
  /** Cap of the open duration. */
  maxOpenMs: number;
  /** Half-open probe lease: must cover one logical request with its retries. */
  probeLeaseMs: number;
  /** Shared state is re-read at most this often (and before paid attempts once stale). */
  pollMs: number;
}

export const DEFAULT_BREAKER_PARAMS: Readonly<BreakerParams> = Object.freeze({
  windowMs: 5 * 60_000,
  minRequests: 20,
  failureRatio: 0.2,
  baseOpenMs: 2 * 60_000,
  maxOpenMs: 30 * 60_000,
  probeLeaseMs: 150_000,
  pollMs: 10_000,
});

export const CLOSED_BREAKER: Readonly<BreakerState> = Object.freeze({
  state: 'closed',
  reopenCount: 0,
});

const closed = (): BreakerState => ({ state: 'closed', reopenCount: 0 });
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));

/** The default (all closed) circuit, as the settings registry defines it. */
export function defaultCircuit(): EngineCircuit {
  const value = settingDefault('engine.circuit', {
    dailyBudgetUsd: 0,
    languageModes: {},
    signupMode: 'invite',
  });
  return EngineCircuitSchema.parse(value);
}

/** Open duration after `reopenCount` consecutive re-opens: 2 min × 2^n, at most 30 min. */
export function openDurationMs(reopenCount: number, params: BreakerParams): number {
  return Math.min(params.baseOpenMs * 2 ** Math.max(0, reopenCount), params.maxOpenMs);
}

/** `closed` → `open` (the local window tripped). Any other state is left alone. */
export function tripBreaker(
  current: BreakerState,
  now: Date,
  params: BreakerParams,
): BreakerState | null {
  if (current.state !== 'closed') return null;
  const at = now.getTime();
  return {
    state: 'open',
    openedAt: iso(at),
    openUntil: iso(at + openDurationMs(current.reopenCount, params)),
    reopenCount: current.reopenCount,
  };
}

/**
 * Acquire the half-open probe lease: from `open` once `openUntil` has passed, or from `half_open`
 * when no lease is live (never granted, released, or expired after a crash).
 */
export function acquireProbe(
  current: BreakerState,
  now: Date,
  token: string,
  params: BreakerParams,
): BreakerState | null {
  const at = now.getTime();
  const openExpired = current.state === 'open' && (ms(current.openUntil) ?? 0) <= at;
  const leaseFree =
    current.state === 'half_open' &&
    (current.probeToken === undefined || (ms(current.probeUntil) ?? 0) <= at);
  if (!openExpired && !leaseFree) return null;
  return {
    state: 'half_open',
    ...(current.openedAt === undefined ? {} : { openedAt: current.openedAt }),
    ...(current.openUntil === undefined ? {} : { openUntil: current.openUntil }),
    reopenCount: current.reopenCount,
    probeToken: token,
    probeUntil: iso(at + params.probeLeaseMs),
  };
}

/**
 * The probe lease holder's verdict: success closes and resets the doubling, failure re-opens for
 * the next doubled duration. A holder whose lease was reclaimed (another token) changes nothing.
 */
export function completeProbe(
  current: BreakerState,
  token: string,
  success: boolean,
  now: Date,
  params: BreakerParams,
): BreakerState | null {
  if (current.state !== 'half_open' || current.probeToken !== token) return null;
  if (success) return closed();
  const at = now.getTime();
  const reopenCount = current.reopenCount + 1;
  return {
    state: 'open',
    openedAt: iso(at),
    openUntil: iso(at + openDurationMs(reopenCount, params)),
    reopenCount,
  };
}

/** Give the probe lease back without a verdict (budget, cancellation, no demand). */
export function releaseProbe(current: BreakerState, token: string): BreakerState | null {
  if (current.state !== 'half_open' || current.probeToken !== token) return null;
  return {
    state: 'half_open',
    ...(current.openedAt === undefined ? {} : { openedAt: current.openedAt }),
    ...(current.openUntil === undefined ? {} : { openUntil: current.openUntil }),
    reopenCount: current.reopenCount,
  };
}

/** 401/403 of the active credential: `auth` until an explicit reset (any other state is replaced). */
export function enterAuthMode(current: BreakerState, now: Date): BreakerState | null {
  if (current.state === 'auth') return null;
  return { state: 'auth', openedAt: now.toISOString(), reopenCount: current.reopenCount };
}

/**
 * An admin reset requested at `resetAt` closes the breaker and resets the doubling, unless the
 * current state began after the request (a newer incident is not cleared by an older reset).
 */
export function applyReset(current: BreakerState, resetAt: Date): BreakerState | null {
  if (current.state === 'closed' && current.reopenCount === 0) return null;
  const opened = ms(current.openedAt);
  if (opened !== undefined && opened > resetAt.getTime()) return null;
  return closed();
}

export type BreakerVerdict =
  | { admit: 'closed' }
  /** The probe lease is (or may be) available: try to acquire it. */
  | { admit: 'probe' }
  | { admit: 'deny'; auth: boolean; retryAt?: Date };

/** Whether a paid attempt may be sent under this state (spec 04 §5). */
export function evaluateBreaker(current: BreakerState, now: Date): BreakerVerdict {
  const at = now.getTime();
  switch (current.state) {
    case 'closed':
      return { admit: 'closed' };
    case 'auth':
      return { admit: 'deny', auth: true };
    case 'open': {
      const until = ms(current.openUntil) ?? 0;
      return until <= at
        ? { admit: 'probe' }
        : { admit: 'deny', auth: false, retryAt: new Date(until) };
    }
    case 'half_open': {
      const until = ms(current.probeUntil);
      if (current.probeToken === undefined || until === undefined || until <= at) {
        return { admit: 'probe' };
      }
      return { admit: 'deny', auth: false, retryAt: new Date(until) };
    }
  }
}

/** A process-local rolling window of logical-request outcomes for one provider. */
export class FailureWindow {
  #entries: Array<{ at: number; failed: boolean }> = [];

  record(at: number, failed: boolean): void {
    this.#entries.push({ at, failed });
  }

  prune(now: number, windowMs: number): void {
    const from = now - windowMs;
    let drop = 0;
    while (drop < this.#entries.length && this.#entries[drop]!.at < from) drop += 1;
    if (drop > 0) this.#entries.splice(0, drop);
  }

  counts(): { requests: number; failures: number } {
    let failures = 0;
    for (const e of this.#entries) if (e.failed) failures += 1;
    return { requests: this.#entries.length, failures };
  }

  /** ≥ `minRequests` requests in the window and a failure share above `failureRatio`. */
  shouldTrip(now: number, params: BreakerParams): boolean {
    this.prune(now, params.windowMs);
    const { requests, failures } = this.counts();
    return requests >= params.minRequests && failures / requests > params.failureRatio;
  }

  clear(): void {
    this.#entries = [];
  }
}

/** Only the credential version still active may put a breaker into auth mode. */
export interface CredentialGuard {
  provider: 'typesafe' | 'ollama';
  /** The DB credential version of the failed attempt; `null` for an environment key. */
  version: string | null;
}

/**
 * Persistence of `settings['engine.circuit']` (implemented by the PostgreSQL engine store). Each
 * update is one short transaction: insert the default row when missing, lock it, apply `update` to
 * the fresh locked value and write back only that engine's entry.
 */
export interface CircuitStore {
  readCircuit(): Promise<EngineCircuit>;
  /**
   * `update` receives the current (locked) circuit and returns the engine's next state, or null
   * for no change. With `credential`, the change applies only while that credential version is
   * still the provider's active one (checked under the credential row lock first).
   */
  updateCircuit(
    engine: BreakerEngine,
    update: (current: EngineCircuit) => BreakerState | null,
    options?: { credential?: CredentialGuard },
  ): Promise<{ circuit: EngineCircuit; changed: boolean }>;
}

export type BreakerAdmission =
  { ok: true; probeToken?: string } | { ok: false; auth: boolean; retryAt?: Date };

/** The logical-request outcome a provider's window records. */
export type BreakerOutcome = 'success' | 'failure' | 'neutral';

export interface BreakerCoordinator {
  /** Decide whether a paid attempt may be sent now (re-reading shared state once it is stale). */
  admit(engine: BreakerEngine): Promise<BreakerAdmission>;
  /** Record the final outcome of one logical request (with the probe token when it was a probe). */
  record(engine: BreakerEngine, outcome: BreakerOutcome, probeToken?: string): Promise<void>;
  /** A 401/403 of `credential`: auth mode, unless that version was superseded meanwhile. */
  authFailure(engine: BreakerEngine, credential: CredentialGuard): Promise<void>;
  /** The shared states (polled like `admit`). */
  states(): Promise<Record<BreakerEngine, BreakerState>>;
}

export interface BreakerCoordinatorDeps {
  store: CircuitStore;
  clock: Clock;
  logger: EngineLogger;
  params?: Partial<BreakerParams>;
  /** Probe lease tokens (UUIDs). */
  newToken?: () => string;
}

export function createBreakerCoordinator(deps: BreakerCoordinatorDeps): BreakerCoordinator {
  const params: BreakerParams = { ...DEFAULT_BREAKER_PARAMS, ...deps.params };
  const newToken = deps.newToken ?? newUuid;
  const windows: Record<BreakerEngine, FailureWindow> = {
    typesafe: new FailureWindow(),
    llm: new FailureWindow(),
  };
  /** The last `resetRequested` timestamp this router has applied, per engine. */
  const seenReset: Partial<Record<BreakerEngine, number>> = {};
  let cache: EngineCircuit | undefined;
  let polledAt = Number.NEGATIVE_INFINITY;
  let polling: Promise<EngineCircuit> | undefined;

  const now = () => deps.clock.now();

  function remember(circuit: EngineCircuit, engine: BreakerEngine, previous?: BreakerState): void {
    cache = circuit;
    const next = circuit[engine];
    if (previous !== undefined && previous.state !== next.state) {
      // A transition invalidates the evidence gathered under the old state.
      if (next.state === 'closed' || next.state === 'open') windows[engine].clear();
      deps.logger.info(
        { engine, from: previous.state, to: next.state, reopenCount: next.reopenCount },
        'engine breaker state changed',
      );
    }
  }

  async function applyResets(circuit: EngineCircuit): Promise<EngineCircuit> {
    let current = circuit;
    for (const engine of BREAKER_ENGINES) {
      const requested = ms(current.resetRequested[engine]);
      if (requested === undefined || Number.isNaN(requested)) continue;
      const seen = seenReset[engine];
      if (seen !== undefined && requested <= seen) continue;
      const resetAt = new Date(requested);
      if (applyReset(current[engine], resetAt) !== null) {
        const before = current[engine];
        const result = await deps.store.updateCircuit(engine, (c) =>
          applyReset(c[engine], resetAt),
        );
        current = result.circuit;
        if (result.changed) {
          deps.logger.info(
            { engine, resetRequested: resetAt.toISOString() },
            'engine breaker reset',
          );
        }
        remember(current, engine, before);
      }
      // Local evidence older than the reset is discarded (after a successful write, so a failed
      // one is retried by the next poll).
      windows[engine].clear();
      seenReset[engine] = requested;
    }
    return current;
  }

  async function poll(force: boolean): Promise<EngineCircuit> {
    const at = now().getTime();
    if (!force && cache !== undefined && at - polledAt < params.pollMs) return cache;
    if (polling !== undefined) return polling;
    polling = (async () => {
      try {
        const circuit = await applyResets(await deps.store.readCircuit());
        cache = circuit;
        polledAt = now().getTime();
        return circuit;
      } finally {
        polling = undefined;
      }
    })();
    return polling;
  }

  async function update(
    engine: BreakerEngine,
    fn: (current: BreakerState) => BreakerState | null,
    options?: { credential?: CredentialGuard },
  ): Promise<boolean> {
    const before = cache?.[engine];
    const result = await deps.store.updateCircuit(engine, (c) => fn(c[engine]), options);
    remember(result.circuit, engine, before);
    return result.changed;
  }

  return {
    async admit(engine) {
      const circuit = await poll(false);
      const verdict = evaluateBreaker(circuit[engine], now());
      if (verdict.admit === 'closed') return { ok: true };
      if (verdict.admit === 'deny') {
        return {
          ok: false,
          auth: verdict.auth,
          ...(verdict.retryAt === undefined ? {} : { retryAt: verdict.retryAt }),
        };
      }
      const token = newToken();
      const at = now();
      if (await update(engine, (s) => acquireProbe(s, at, token, params))) {
        deps.logger.info({ engine }, 'engine breaker half-open probe acquired');
        return { ok: true, probeToken: token };
      }
      // Another router won the lease or changed the state: decide on the fresh value.
      const fresh = evaluateBreaker(cache![engine], now());
      if (fresh.admit === 'closed') return { ok: true };
      return {
        ok: false,
        auth: fresh.admit === 'deny' && fresh.auth,
        ...(fresh.admit === 'deny' && fresh.retryAt !== undefined
          ? { retryAt: fresh.retryAt }
          : {}),
      };
    },

    async record(engine, outcome, probeToken) {
      const at = now();
      if (probeToken !== undefined) {
        if (outcome === 'neutral') {
          await update(engine, (s) => releaseProbe(s, probeToken));
        } else {
          await update(engine, (s) =>
            completeProbe(s, probeToken, outcome === 'success', at, params),
          );
        }
        return;
      }
      if (outcome === 'neutral') return;
      const window = windows[engine];
      window.record(at.getTime(), outcome === 'failure');
      if (outcome !== 'failure' || !window.shouldTrip(at.getTime(), params)) return;
      const counts = window.counts();
      if (await update(engine, (s) => tripBreaker(s, at, params))) {
        deps.logger.warn({ engine, ...counts }, 'engine breaker opened');
      }
      window.clear();
    },

    async authFailure(engine, credential) {
      const at = now();
      const changed = await update(engine, (s) => enterAuthMode(s, at), { credential });
      if (changed) {
        deps.logger.error(
          { engine, provider: credential.provider, credentialVersion: credential.version },
          'engine breaker entered auth mode',
        );
      }
    },

    async states() {
      const circuit = await poll(false);
      return { typesafe: circuit.typesafe, llm: circuit.llm };
    },
  };
}

/**
 * A process-local {@link CircuitStore} (tests and single-process tools). Updates are atomic because
 * the callback runs synchronously on one copy; it does not coordinate separate processes.
 */
export function createMemoryCircuitStore(initial?: EngineCircuit): CircuitStore & {
  /** Replace the stored value (tests: e.g. an admin reset request). */
  write(circuit: EngineCircuit): void;
  /** The provider's active credential version the auth guard compares with (`null`: env key). */
  setActiveCredential(provider: 'typesafe' | 'ollama', version: string | null): void;
} {
  let value: EngineCircuit = EngineCircuitSchema.parse(initial ?? defaultCircuit());
  const active: Record<'typesafe' | 'ollama', string | null> = { typesafe: null, ollama: null };
  const copy = (): EngineCircuit => structuredClone(value);
  return {
    async readCircuit() {
      return copy();
    },
    async updateCircuit(engine, update, options) {
      const guard = options?.credential;
      if (guard !== undefined && active[guard.provider] !== guard.version) {
        return { circuit: copy(), changed: false };
      }
      const next = update(copy());
      if (next === null) return { circuit: copy(), changed: false };
      value = EngineCircuitSchema.parse({ ...value, [engine]: next });
      return { circuit: copy(), changed: true };
    },
    write(circuit) {
      value = EngineCircuitSchema.parse(circuit);
    },
    setActiveCredential(provider, version) {
      active[provider] = version;
    },
  };
}
