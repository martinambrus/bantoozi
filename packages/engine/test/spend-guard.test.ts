import { PLATFORM_USER_ID } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  admitsSpend,
  attributionUserId,
  capGroupCalls,
  capKinds,
  committedSpendUsd,
  effectiveDailyBudgetUsd,
  InvocationBudget,
  nextBudgetAlerts,
  nextUtcDay,
  spendLimitUsd,
} from '../src/spend-guard.js';

describe('daily budget (spec 04 §6)', () => {
  it('prefers the stored setting over the host default', () => {
    expect(effectiveDailyBudgetUsd(undefined, 2)).toBe(2);
    expect(effectiveDailyBudgetUsd(5, 2)).toBe(5);
    expect(effectiveDailyBudgetUsd(0, 2)).toBe(0);
    expect(() => effectiveDailyBudgetUsd(-1, 2)).toThrow();
    expect(() => effectiveDailyBudgetUsd('3', 2)).toThrow();
  });

  it('gives interactive requests a 10 % allowance and stops bulk at 100 %', () => {
    expect(spendLimitUsd(2, 'bulk')).toBe(2);
    expect(spendLimitUsd(2, 'interactive')).toBeCloseTo(2.2, 12);
    const at = (committedUsd: number, priority: 'bulk' | 'interactive') =>
      admitsSpend({ committedUsd, estimateUsd: 0.1, budgetUsd: 2, priority });
    expect(at(1.9, 'bulk')).toBe(true);
    expect(at(1.95, 'bulk')).toBe(false);
    expect(at(1.95, 'interactive')).toBe(true);
    expect(at(2.1, 'interactive')).toBe(true);
    expect(at(2.11, 'interactive')).toBe(false);
  });

  it('counts settled, reserved and uncertain spend once each', () => {
    expect(committedSpendUsd({ settledUsd: 1, reservedUsd: 0.25, uncertainUsd: 0.5 })).toBe(1.75);
  });

  it('rolls over at UTC midnight', () => {
    expect(nextUtcDay(new Date('2026-09-26T23:59:59.999Z')).toISOString()).toBe(
      '2026-09-27T00:00:00.000Z',
    );
    expect(nextUtcDay(new Date('2026-12-31T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    // A local evening can already be the next UTC day.
    expect(nextUtcDay(new Date('2026-09-26T22:30:00-02:00')).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
  });
});

describe('budget alert crossings', () => {
  const now = new Date('2026-09-26T10:00:00.000Z');
  const input = (committedUsd: number, day = '2026-09-26') => ({
    day,
    committedUsd,
    budgetUsd: 2,
    now,
  });

  it('records the 80 % and 100 % crossings once per UTC day', () => {
    expect(nextBudgetAlerts(undefined, input(1.5))).toBeNull();
    const p80 = nextBudgetAlerts(undefined, input(1.6));
    expect(p80).toEqual({ day: '2026-09-26', p80At: now.toISOString() });
    expect(nextBudgetAlerts(p80!, input(1.7))).toBeNull();
    const p100 = nextBudgetAlerts(p80!, input(2));
    expect(p100).toEqual({
      day: '2026-09-26',
      p80At: now.toISOString(),
      p100At: now.toISOString(),
    });
    expect(nextBudgetAlerts(p100!, input(3))).toBeNull();
  });

  it('starts a fresh record on a new day, and records both when jumping past 100 %', () => {
    const yesterday = { day: '2026-09-25', p80At: 'x', p100At: 'y' };
    expect(nextBudgetAlerts(yesterday, input(2.5))).toEqual({
      day: '2026-09-26',
      p80At: now.toISOString(),
      p100At: now.toISOString(),
    });
  });

  it('records nothing for a zero budget', () => {
    expect(nextBudgetAlerts(undefined, { ...input(1), budgetUsd: 0 })).toBeNull();
  });
});

describe('call caps and attribution', () => {
  it('shares one cap across the decision kinds of an engine', () => {
    expect(capKinds('match')).toEqual(['enrich', 'match', 'cluster', 'suggest']);
    expect(capKinds('translate')).toEqual(['translate']);
    const calls = { 'llm:enrich': 2, 'llm:match': 3, 'llm:translate': 7, 'typesafe:match': 9 };
    expect(capGroupCalls(calls, 'llm', 'suggest')).toBe(5);
    expect(capGroupCalls(calls, 'llm', 'translate')).toBe(7);
  });

  it('attributes to the user, else the platform sentinel (spec 04 §7)', () => {
    expect(attributionUserId('u-1')).toBe('u-1');
    expect(attributionUserId(undefined)).toBe(PLATFORM_USER_ID);
  });
});

describe('InvocationBudget (eval routers, spec 04 §1)', () => {
  it('admits concurrent reservations only within the cap, with no interactive allowance', () => {
    const budget = new InvocationBudget(1);
    expect(budget.tryReserve(0.6)).toBe(true);
    expect(budget.tryReserve(0.6)).toBe(false);
    expect(budget.tryReserve(0.4)).toBe(true);
    expect(budget.remainingUsd).toBeCloseTo(0, 12);
  });

  it('replaces a reserve by the known cost, keeps an uncertain one and frees an unsent one', () => {
    const budget = new InvocationBudget(1);
    budget.tryReserve(0.5);
    budget.settle(0.5, 0.1);
    expect(budget.committedUsd).toBeCloseTo(0.1, 12);
    budget.tryReserve(0.5);
    budget.settle(0.5, null);
    expect(budget.committedUsd).toBeCloseTo(0.6, 12);
    budget.tryReserve(0.3);
    budget.cancel(0.3);
    expect(budget.committedUsd).toBeCloseTo(0.6, 12);
    expect(budget.tryReserve(0.5)).toBe(false);
  });

  it('rejects an invalid cap', () => {
    expect(() => new InvocationBudget(-1)).toThrow(RangeError);
    expect(() => new InvocationBudget(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
