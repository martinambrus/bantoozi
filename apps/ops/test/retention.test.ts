import { describe, expect, it } from 'vitest';

import { backupIdOf, backupIdTime, ledgerExpired, planRetention } from '../src/retention.js';

const daily = (from: string, to: string, time = '023000'): string[] => {
  const ids: string[] = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d = new Date(d.getTime() + 86_400_000)
  ) {
    ids.push(`${d.toISOString().slice(0, 10).replace(/-/gu, '')}T${time}Z`);
  }
  return ids;
};

describe('backup ids', () => {
  it('round-trips and rejects anything else', () => {
    const id = '20261011T023000Z';
    expect(backupIdOf(backupIdTime(id) as Date)).toBe(id);
    expect(backupIdTime('20261340T023000Z')).toBeUndefined();
    expect(backupIdTime('backup')).toBeUndefined();
  });
});

describe('retention: 7 daily, 4 weekly (Sunday), 6 monthly (1st), the last restore-tested', () => {
  const now = new Date('2026-10-11T03:00:00Z');
  const ids = daily('2026-02-01', '2026-10-11');

  it('keeps exactly the modelled set over eight months of daily backups', () => {
    const plan = planRetention({
      ids,
      restoreTested: ['20260315T023000Z', '20260316T023000Z'],
      now,
    });
    const kept = [...plan.keep.keys()];
    const expectedDaily = daily('2026-10-05', '2026-10-11');
    const expectedWeekly = ['20261011', '20261004', '20260927', '20260920'].map(
      (d) => `${d}T023000Z`,
    );
    const expectedMonthly = [
      '20261001',
      '20260901',
      '20260801',
      '20260701',
      '20260601',
      '20260501',
    ].map((d) => `${d}T023000Z`);
    const expected = new Set([
      ...expectedDaily,
      ...expectedWeekly,
      ...expectedMonthly,
      '20260316T023000Z',
    ]);
    expect(kept.sort()).toEqual([...expected].sort());
    expect(plan.keep.get('20260316T023000Z')).toEqual(['last-restore-tested']);
    expect(plan.keep.get('20261011T023000Z')).toEqual(['daily', 'weekly']);
    expect(plan.prune).toContain('20260315T023000Z');
    expect(plan.prune).toHaveLength(ids.length - expected.size);
  });

  it('never prunes the last restore-tested backup, however old, and prunes earlier tested ones', () => {
    const plan = planRetention({
      ids,
      restoreTested: ['20260210T023000Z', '20260211T023000Z'],
      now,
    });
    expect(plan.keep.has('20260211T023000Z')).toBe(true);
    expect(plan.prune).toContain('20260210T023000Z');
  });

  it('is idempotent: planning again on the survivors keeps all of them', () => {
    const first = planRetention({ ids, restoreTested: [], now });
    const again = planRetention({ ids: [...first.keep.keys()], restoreTested: [], now });
    expect(again.prune).toEqual([]);
  });

  it('moves the window with a later clock (fake dates)', () => {
    const first = planRetention({ ids, restoreTested: ['20260316T023000Z'], now });
    const later = planRetention({
      ids: [...first.keep.keys()],
      restoreTested: ['20260316T023000Z'],
      now: new Date('2026-11-15T03:00:00Z'),
    });
    expect(later.keep.has('20260316T023000Z')).toBe(true);
    expect(later.keep.has('20261005T023000Z')).toBe(true);
    expect(later.keep.has('20261001T023000Z')).toBe(true);
  });

  it('keeps every backup of a recent date (a pre-deploy backup does not evict the cron backup)', () => {
    const plan = planRetention({
      ids: ['20261011T023000Z', '20261011T101500Z', '20261010T023000Z'],
      restoreTested: [],
      now,
    });
    expect(plan.prune).toEqual([]);
    const old = planRetention({
      ids: [...daily('2026-10-05', '2026-10-11'), '20260501T023000Z', '20260501T101500Z'],
      restoreTested: [],
      now,
    });
    // Out of the daily window the 1st-of-month rule keeps the newest backup of that date only.
    expect(old.keep.has('20260501T101500Z')).toBe(true);
    expect(old.keep.has('20260501T023000Z')).toBe(false);
    expect(old.prune).toEqual(['20260501T023000Z']);
  });

  it('never prunes a backup newer than the clock', () => {
    const plan = planRetention({
      ids: ['20261201T023000Z', '20261011T023000Z'],
      restoreTested: [],
      now,
    });
    expect(plan.keep.get('20261201T023000Z')).toEqual(['future']);
  });

  it('handles an empty bucket and a single backup', () => {
    expect(planRetention({ ids: [], restoreTested: [], now }).prune).toEqual([]);
    expect(planRetention({ ids: ['20260101T000000Z'], restoreTested: [], now }).prune).toEqual([]);
  });
});

describe('ledger copies', () => {
  it('expire after the longest backup lifetime plus 7 days', () => {
    const now = new Date('2026-10-11T03:00:00Z');
    expect(ledgerExpired('20260501T023000Z', now)).toBe(false);
    expect(ledgerExpired('20250401T023000Z', now)).toBe(true);
  });
});
