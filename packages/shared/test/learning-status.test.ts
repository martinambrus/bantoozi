import { describe, expect, it } from 'vitest';

import { LearningStatusSchema } from '../src/index.js';

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

const OK = { state: 'ok', since: null, reason: null };

describe('LearningStatusSchema classification', () => {
  it('fills an ok classification when an older server sends none', () => {
    expect(LearningStatusSchema.parse(base).classification).toEqual(OK);
  });

  it.each([
    OK,
    { state: 'paused', since: '2026-10-17T08:30:00.000Z', reason: 'engine_unavailable' },
    { state: 'paused', since: '2026-10-17T10:30:00+02:00', reason: 'model_upgrade' },
    { state: 'paused', since: null, reason: 'engine_unavailable' },
    { state: 'paused', since: null, reason: 'model_upgrade' },
  ])('accepts the classification %j', (classification) => {
    expect(LearningStatusSchema.parse({ ...base, classification }).classification).toEqual(
      classification,
    );
  });

  it('rejects an unknown reason', () => {
    const result = LearningStatusSchema.safeParse({
      ...base,
      classification: { state: 'paused', since: null, reason: 'maintenance' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key inside classification', () => {
    const result = LearningStatusSchema.safeParse({
      ...base,
      classification: { ...OK, detail: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a since that is not an ISO timestamp', () => {
    const result = LearningStatusSchema.safeParse({
      ...base,
      classification: { state: 'paused', since: 'yesterday', reason: 'engine_unavailable' },
    });
    expect(result.success).toBe(false);
  });
});
