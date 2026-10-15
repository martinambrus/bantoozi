import { describe, expect, it } from 'vitest';

import * as shared from '../src/index.js';
import { RUNTIME_SETTING_KEYS, parseSetting, validateRuntimeSetting } from '../src/index.js';

/**
 * D-251 per-feed daily cap on automatic analysis (owner-approved 2026-10-15).
 *
 * Names the build must add (this harness fixes them):
 * - runtime setting key `engine.auto_analysis_daily_cap` (integer 0..1,000,000; a stored null
 *   resets to the env default AUTO_ANALYSIS_DAILY_CAP, default 1000);
 * - `autoAdmissionAllowance(cap: number | null, utcHour: number): number` exported from
 *   `packages/shared/src/policies/inference.ts` (via the index): the cumulative number of arrivals a
 *   feed may have admitted by the end of UTC hour `utcHour` (0..23): floor(cap * (hour + 1) / 24);
 *   null = unlimited (Infinity).
 */

const KEY = 'engine.auto_analysis_daily_cap';
const ctx = { production: false, providerHostAllowlist: [], ollamaPricedModels: [] };

describe('runtime setting engine.auto_analysis_daily_cap', () => {
  it('is one of the live runtime keys', () => {
    expect(RUNTIME_SETTING_KEYS as readonly string[]).toContain(KEY);
  });

  it('accepts 0 and 1 000 000, rejects negatives, fractions and values above the range', () => {
    for (const v of [0, 1, 1000, 1_000_000])
      expect(() => parseSetting(KEY as never, v)).not.toThrow();
    for (const v of [-1, 1.5, 1_000_001, '5']) {
      expect(() => parseSetting(KEY as never, v)).toThrow();
    }
    expect(parseSetting(KEY as never, null)).toBeNull();
  });

  it('validates a write the same way', () => {
    expect(validateRuntimeSetting(KEY as never, 0, ctx).ok).toBe(true);
    expect(validateRuntimeSetting(KEY as never, 1_000_001, ctx).ok).toBe(false);
    expect(validateRuntimeSetting(KEY as never, -5, ctx).ok).toBe(false);
  });
});

describe('autoAdmissionAllowance (paced, cumulative)', () => {
  const allowance = (cap: number | null, hour: number): number => {
    const fn = (shared as Record<string, unknown>).autoAdmissionAllowance;
    if (typeof fn !== 'function') throw new Error('autoAdmissionAllowance is not exported');
    return (fn as (c: number | null, h: number) => number)(cap, hour);
  };

  it('is floor(cap * (hour + 1) / 24)', () => {
    expect(allowance(1000, 0)).toBe(41);
    expect(allowance(1000, 11)).toBe(500);
    expect(allowance(1000, 23)).toBe(1000);
    expect(allowance(24, 0)).toBe(1);
    expect(allowance(24, 9)).toBe(10);
    expect(allowance(1, 22)).toBe(0);
    expect(allowance(1, 23)).toBe(1);
  });

  it('is monotone in the hour, so an unused allowance carries forward', () => {
    let last = -1;
    for (let hour = 0; hour < 24; hour += 1) {
      const now = allowance(997, hour);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(997);
  });

  it('is 0 for cap 0 and unlimited for null', () => {
    for (let hour = 0; hour < 24; hour += 1) expect(allowance(0, hour)).toBe(0);
    expect(allowance(null, 5)).toBe(Number.POSITIVE_INFINITY);
  });
});
