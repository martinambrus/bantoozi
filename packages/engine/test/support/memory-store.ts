import { randomUUID } from 'node:crypto';

import {
  PLATFORM_USER_ID,
  type BudgetSnapshot,
  type CallKind,
  type EngineCallRow,
  type EngineStore,
  type InferenceAuthorization,
  type UsageRow,
} from '@bantoozi/shared';

import { capKinds, INTERACTIVE_ALLOWANCE, USD_EPSILON } from '../../src/spend-guard.js';

/**
 * An in-memory {@link EngineStore} with the semantics of the PostgreSQL store (packages/db): a
 * reservation ledger counted once per reservation, call caps, the interactive allowance, eval
 * excluded from the production budget, idempotent settlement on the reservation id and uncertain
 * reconciliation. `reserveSpend` checks and inserts without awaiting in between, so concurrent
 * callers are serialized like the advisory lock serializes them.
 */

export interface MemoryReservation {
  id: string;
  day: string;
  engine: string;
  kind: CallKind;
  userId: string | undefined;
  priority: 'interactive' | 'bulk';
  reservedUsd: number;
  callCap: number | undefined;
  status: 'reserved' | 'settled' | 'uncertain';
  actualUsd: number | undefined;
}

export interface MemoryEngineStore extends EngineStore {
  reservations: MemoryReservation[];
  calls: EngineCallRow[];
  usage: Map<string, UsageRow>;
  settings: Map<string, unknown>;
  /** Live demand: every authorization is authorized unless this says otherwise. */
  authorize: (authorization: InferenceAuthorization) => boolean;
  /** Make the next `n` settlements throw (a lost database connection). */
  failSettlements(n: number): void;
  settleAttempts: number;
}

export function createMemoryEngineStore(options: { dailyBudgetUsd: number }): MemoryEngineStore {
  const reservations: MemoryReservation[] = [];
  const calls: EngineCallRow[] = [];
  const usage = new Map<string, UsageRow>();
  const settings = new Map<string, unknown>();
  let failures = 0;

  const budget = (): number => {
    const stored = settings.get('engine.daily_budget_usd');
    return typeof stored === 'number' ? stored : options.dailyBudgetUsd;
  };
  const committed = (day: string): number =>
    reservations
      .filter((r) => r.day === day && r.kind !== 'eval')
      .reduce((sum, r) => sum + (r.status === 'settled' ? (r.actualUsd ?? 0) : r.reservedUsd), 0);

  function addUsage(row: UsageRow): void {
    const key = `${row.day}|${row.userId}|${row.engine}|${row.kind}`;
    const current = usage.get(key);
    usage.set(
      key,
      current === undefined
        ? { ...row }
        : {
            ...current,
            calls: current.calls + row.calls,
            inputTokens: current.inputTokens + row.inputTokens,
            outputTokens: current.outputTokens + row.outputTokens,
            costUsd: current.costUsd + row.costUsd,
          },
    );
  }

  const store: MemoryEngineStore = {
    reservations,
    calls,
    usage,
    settings,
    settleAttempts: 0,
    authorize: () => true,
    failSettlements(n) {
      failures = n;
    },

    async reserveSpend(input) {
      if (!store.authorize(input.authorization)) return null;
      if ((input.kind === 'eval') !== (input.authorization.type === 'eval')) return null;
      if (input.callCap !== undefined) {
        const group = capKinds(input.kind);
        const used = reservations.filter(
          (r) => r.day === input.day && r.engine === input.engine && group.includes(r.kind),
        ).length;
        if (used + 1 > input.callCap) return null;
      }
      if (input.kind !== 'eval') {
        const limit =
          input.priority === 'interactive' ? budget() * (1 + INTERACTIVE_ALLOWANCE) : budget();
        if (committed(input.day) + input.estimateUsd > limit + USD_EPSILON) return null;
      }
      const id = randomUUID();
      reservations.push({
        id,
        day: input.day,
        engine: input.engine,
        kind: input.kind,
        userId: input.userId,
        priority: input.priority,
        reservedUsd: input.estimateUsd,
        callCap: input.callCap,
        status: 'reserved',
        actualUsd: undefined,
      });
      return id;
    },

    async authorizeInference(authorization) {
      return store.authorize(authorization);
    },

    async settleReservation(id, call, row, billing) {
      store.settleAttempts += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('connection lost');
      }
      const reservation = reservations.find((r) => r.id === id);
      if (reservation === undefined) throw new Error('unknown reservation');
      const previous = calls.find((c) => c.reservationId === id);
      if (previous !== undefined) {
        if (reservation.status === 'uncertain' && billing === 'known') {
          previous.billing = 'known';
          previous.costUsd = call.costUsd;
          reservation.status = 'settled';
          reservation.actualUsd = call.costUsd;
          addUsage({ ...row, day: reservation.day, calls: 0 });
        }
        return;
      }
      if (reservation.status === 'settled') return;
      const cost = billing === 'known' ? call.costUsd : 0;
      calls.push({ ...call, reservationId: id, billing, costUsd: cost });
      if (billing === 'known') {
        reservation.status = 'settled';
        reservation.actualUsd = cost;
      } else {
        reservation.status = 'uncertain';
      }
      addUsage({ ...row, day: reservation.day, costUsd: cost });
    },

    async insertCall(row) {
      if (row.costUsd !== 0) throw new RangeError('zero-cost calls only');
      const duplicate = calls.some(
        (c) =>
          c.logicalRequestId === row.logicalRequestId &&
          c.engine === row.engine &&
          c.attempts === row.attempts,
      );
      if (duplicate) return;
      calls.push({ ...row });
      addUsage({
        day: row.createdAt.toISOString().slice(0, 10),
        userId: row.userId ?? PLATFORM_USER_ID,
        engine: row.engine,
        kind: row.kind,
        calls: 1,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: 0,
      });
    },

    async upsertUsage(row) {
      addUsage(row);
    },

    async spendSince(from, opts) {
      const excluded = opts.excludeKinds === 'none' ? [] : opts.excludeKinds;
      return reservations
        .filter((r) => !excluded.includes(r.kind))
        .reduce((sum, r) => sum + (r.status === 'settled' ? (r.actualUsd ?? 0) : r.reservedUsd), 0);
    },

    async getBudgetSnapshot(day, opts): Promise<BudgetSnapshot> {
      const excluded = opts.excludeKinds === 'none' ? [] : opts.excludeKinds;
      const snapshot: BudgetSnapshot = {
        settledUsd: 0,
        reservedUsd: 0,
        uncertainUsd: 0,
        callsByEngineKind: {},
      };
      for (const r of reservations) {
        if (r.day !== day || excluded.includes(r.kind)) continue;
        if (r.status === 'settled') snapshot.settledUsd += r.actualUsd ?? 0;
        else if (r.status === 'reserved') snapshot.reservedUsd += r.reservedUsd;
        else snapshot.uncertainUsd += r.reservedUsd;
        const key = `${r.engine}:${r.kind}`;
        snapshot.callsByEngineKind[key] = (snapshot.callsByEngineKind[key] ?? 0) + 1;
      }
      return snapshot;
    },

    async getSetting<T>(key: string) {
      return settings.get(key) as T | undefined;
    },

    async setSetting<T>(key: string, value: T) {
      settings.set(key, value);
    },
  };
  return store;
}
