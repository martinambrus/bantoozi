import {
  parseSetting,
  PLATFORM_USER_ID,
  type BudgetSnapshot,
  type CallKind,
  type SettingValue,
} from '@bantoozi/shared';

import type { Priority } from './types.js';

/**
 * Spend guard math (spec 04 §6). The daily budget is `settings['engine.daily_budget_usd']`, else
 * `DAILY_BUDGET_USD`, per UTC day. Interactive requests may use a 10 % allowance above it; bulk
 * requests stop at 100 %. Admission itself is atomic in the store (`reserveSpend` under the UTC-day
 * lock, spec 02 §3.3); these pure helpers give the router its advisory checks (`canSpend`,
 * `status()`), the deferral time and the eval router's own synchronized per-invocation cap.
 * `kind = 'eval'` never counts against the production budget.
 */

/** Interactive requests may exceed the daily budget by this share. */
export const INTERACTIVE_ALLOWANCE = 0.1;
/** Budget shares whose crossing `settings['engine.budget_alerts']` records once per UTC day. */
export const BUDGET_ALERT_THRESHOLDS = [
  { key: 'p80At', ratio: 0.8 },
  { key: 'p100At', ratio: 1 },
] as const;
/** Kinds whose calls share one daily call cap per engine (the LLM fallback cap). */
export const DECISION_KINDS: readonly CallKind[] = ['enrich', 'match', 'cluster', 'suggest'];
/** Float tolerance of budget comparisons (well below the 1e-8 USD storage precision). */
export const USD_EPSILON = 1e-9;

export type BudgetAlerts = SettingValue<'engine.budget_alerts'>;

/** The effective daily budget: a stored setting wins over the host default. */
export function effectiveDailyBudgetUsd(stored: unknown, fallbackUsd: number): number {
  return stored === undefined ? fallbackUsd : parseSetting('engine.daily_budget_usd', stored);
}

/** The highest committed spend a request of `priority` may reach (bulk 100 %, interactive 110 %). */
export function spendLimitUsd(budgetUsd: number, priority: Priority): number {
  return priority === 'interactive' ? budgetUsd * (1 + INTERACTIVE_ALLOWANCE) : budgetUsd;
}

/** Settled cost plus outstanding reserved and uncertain amounts, each reservation counted once. */
export function committedSpendUsd(
  snapshot: Pick<BudgetSnapshot, 'settledUsd' | 'reservedUsd' | 'uncertainUsd'>,
): number {
  return snapshot.settledUsd + snapshot.reservedUsd + snapshot.uncertainUsd;
}

/** Whether a request estimated at `estimateUsd` fits under the day's limit for its priority. */
export function admitsSpend(input: {
  committedUsd: number;
  estimateUsd: number;
  budgetUsd: number;
  priority: Priority;
}): boolean {
  return (
    input.committedUsd + input.estimateUsd <=
    spendLimitUsd(input.budgetUsd, input.priority) + USD_EPSILON
  );
}

/** The next UTC midnight: when budget-blocked work gets the next day's allowance. */
export function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

/**
 * The next `engine.budget_alerts` value after the day's committed production spend reached
 * `committedUsd`, or null when nothing new is crossed. A different day starts a fresh record, so
 * each threshold is marked at most once per UTC day. A zero budget records no crossings.
 */
export function nextBudgetAlerts(
  current: BudgetAlerts | undefined,
  input: { day: string; committedUsd: number; budgetUsd: number; now: Date },
): BudgetAlerts | null {
  if (!(input.budgetUsd > 0)) return null;
  const base: BudgetAlerts = current?.day === input.day ? { ...current } : { day: input.day };
  let changed = false;
  for (const { key, ratio } of BUDGET_ALERT_THRESHOLDS) {
    if (base[key] === undefined && input.committedUsd >= input.budgetUsd * ratio - USD_EPSILON) {
      base[key] = input.now.toISOString();
      changed = true;
    }
  }
  return changed ? base : null;
}

/** The kinds that share `kind`'s daily call cap on one engine. */
export function capKinds(kind: CallKind): readonly CallKind[] {
  return DECISION_KINDS.includes(kind) ? DECISION_KINDS : [kind];
}

/** Calls of `engine` in `kind`'s cap group from a snapshot's `${engine}:${kind}` counters. */
export function capGroupCalls(
  callsByEngineKind: Readonly<Record<string, number>>,
  engine: string,
  kind: CallKind,
): number {
  let total = 0;
  for (const k of capKinds(kind)) total += callsByEngineKind[`${engine}:${k}`] ?? 0;
  return total;
}

/** `usage_daily.user_id`: the requesting user, else the platform sentinel (spec 04 §7). */
export function attributionUserId(userId: string | undefined): string {
  return userId ?? PLATFORM_USER_ID;
}

/**
 * The eval router's own budget (spec 04 §1 "Eval routers"): settled and uncertain spend plus every
 * in-flight reservation since the router was created must stay within `limitUsd`, with no
 * interactive allowance. `tryReserve` checks and adds synchronously, which is the router mutex:
 * concurrent attempts of one router can never overshoot. Uncertain attempts keep their reserve.
 */
export class InvocationBudget {
  readonly limitUsd: number;
  #settled = 0;
  #inFlight = 0;

  constructor(limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      throw new RangeError('budgetOverrideUsd must be a finite non-negative number');
    }
    this.limitUsd = limitUsd;
  }

  /** Reserve `amountUsd` before an attempt; false when it would exceed the invocation cap. */
  tryReserve(amountUsd: number): boolean {
    if (this.#settled + this.#inFlight + amountUsd > this.limitUsd + USD_EPSILON) return false;
    this.#inFlight += amountUsd;
    return true;
  }

  /** Settle a reserve: known cost replaces it; `null` (uncertain billing) keeps the reserve. */
  settle(reservedUsd: number, actualUsd: number | null): void {
    this.#inFlight = Math.max(0, this.#inFlight - reservedUsd);
    this.#settled += actualUsd ?? reservedUsd;
  }

  /** Drop a reserve for an attempt that was never sent. */
  cancel(reservedUsd: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - reservedUsd);
  }

  get committedUsd(): number {
    return this.#settled + this.#inFlight;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.committedUsd);
  }
}
