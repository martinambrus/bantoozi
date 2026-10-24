import { describe, expect, it } from 'vitest';

import { EstimatesStatusSchema, LearningStatusSchema } from '../src/index.js';

const AT = '2026-10-20T08:30:00.000Z';
const LAST_RUN = { at: '2026-10-21T02:00:00.000Z', movedUp: 12, movedDown: 30, fromRatings: false };
const FULL = { n: 23, auc: 0.71, trainedAt: AT, lastRun: LAST_RUN };

const base = {
  model: {
    thresholds: { minExplicit: 40, minEachClass: 10, minCvAuc: 0.6 },
    counts: { explicit: 0, likes: 0, dislikes: 0 },
    active: null,
    lastAttempt: null,
    deactivated: null,
  },
  feeds: [],
};

describe('EstimatesStatusSchema', () => {
  it('accepts a full status and returns it unchanged', () => {
    expect(EstimatesStatusSchema.parse(FULL)).toEqual(FULL);
  });

  it('accepts a model that has not refreshed yet (lastRun null)', () => {
    expect(EstimatesStatusSchema.parse({ ...FULL, lastRun: null }).lastRun).toBeNull();
  });

  it('accepts an undefined AUC (auc null)', () => {
    expect(EstimatesStatusSchema.parse({ ...FULL, auc: null }).auc).toBeNull();
  });

  it('accepts an offset timestamp and zero counts', () => {
    const parsed = EstimatesStatusSchema.parse({
      n: 0,
      auc: 0,
      trainedAt: '2026-10-20T10:30:00+02:00',
      lastRun: { at: '2026-10-21T04:00:00+02:00', movedUp: 0, movedDown: 0 },
    });
    expect(parsed.n).toBe(0);
    expect(parsed.lastRun).toMatchObject({ movedUp: 0, movedDown: 0 });
  });

  it('rejects an unknown key', () => {
    expect(EstimatesStatusSchema.safeParse({ ...FULL, weights: [] }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    for (const key of ['n', 'auc', 'trainedAt', 'lastRun'] as const) {
      const { [key]: _omitted, ...rest } = FULL;
      expect(EstimatesStatusSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it('rejects negative or fractional counts', () => {
    expect(EstimatesStatusSchema.safeParse({ ...FULL, n: -1 }).success).toBe(false);
    expect(EstimatesStatusSchema.safeParse({ ...FULL, n: 1.5 }).success).toBe(false);
    for (const field of ['movedUp', 'movedDown'] as const) {
      const lastRun = { ...LAST_RUN, [field]: -3 };
      expect(EstimatesStatusSchema.safeParse({ ...FULL, lastRun }).success, field).toBe(false);
    }
  });

  it('rejects a time that is not ISO', () => {
    expect(EstimatesStatusSchema.safeParse({ ...FULL, trainedAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(EstimatesStatusSchema.safeParse({ ...FULL, trainedAt: '2026-10-20' }).success).toBe(
      false,
    );
    const lastRun = { ...LAST_RUN, at: '21.10.2026 02:00' };
    expect(EstimatesStatusSchema.safeParse({ ...FULL, lastRun }).success).toBe(false);
  });

  it('rejects an unknown key inside lastRun', () => {
    const lastRun = { ...LAST_RUN, unchanged: 4 };
    expect(EstimatesStatusSchema.safeParse({ ...FULL, lastRun }).success).toBe(false);
  });
});

describe('LearningStatusSchema estimates', () => {
  it('fills null when an older server sends no estimates', () => {
    expect(LearningStatusSchema.parse(base).estimates).toBeNull();
  });

  it('fills null when estimates is undefined', () => {
    expect(LearningStatusSchema.parse({ ...base, estimates: undefined }).estimates).toBeNull();
  });

  it('keeps an explicit null', () => {
    expect(LearningStatusSchema.parse({ ...base, estimates: null }).estimates).toBeNull();
  });

  it('round-trips a full object', () => {
    const parsed = LearningStatusSchema.parse({ ...base, estimates: FULL });
    expect(parsed.estimates).toEqual(FULL);
    expect(LearningStatusSchema.parse(parsed)).toEqual(parsed);
  });

  it('rejects an estimates object with an unknown key', () => {
    const result = LearningStatusSchema.safeParse({ ...base, estimates: { ...FULL, platt: [] } });
    expect(result.success).toBe(false);
  });
});
