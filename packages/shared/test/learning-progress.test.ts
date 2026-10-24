import { describe, expect, it } from 'vitest';

import {
  hasAgreement,
  LearningHistoryItemSchema,
  LearningHistorySchema,
  LearningStatusSchema,
} from '../src/index.js';

const model = {
  thresholds: { minExplicit: 40, minEachClass: 10, minCvAuc: 0.6 },
  counts: { explicit: 0, likes: 0, dislikes: 0 },
  active: null,
  lastAttempt: null,
  deactivated: null,
};

const training = {
  feedId: 'f1',
  status: 'collecting' as const,
  likes: 0,
  dislikes: 0,
  auc: null,
  aucLow: null,
  ratedHigh: { total: 0, liked: 0 },
  ratedLow: { total: 0, disliked: 0 },
  uncovered: { count: 0, suggest: false, articles: [] },
  unwanted: { count: 0, suggest: false, articles: [] },
  articlesPerWeek: null,
};

const status = (feeds: unknown[], extra: Record<string, unknown> = {}) => ({
  model,
  feeds,
  ...extra,
});

const AT = '2026-10-20T08:30:00.000Z';
const item = {
  at: AT,
  kind: 'model' as const,
  n: 50,
  auc: 0.74,
  baselineAuc: 0.7,
  activated: true,
  turnedOn: false,
  engineModel: 'jev-1',
  reason: null,
};

describe('LearningStatusSchema per-feed estimate', () => {
  it('defaults a Training entry estimate to null when absent', () => {
    const parsed = LearningStatusSchema.parse(status([training]));
    expect(parsed.feeds[0]).toMatchObject({ feedId: 'f1', estimate: null });
  });

  it('accepts a Training entry with an estimate', () => {
    const parsed = LearningStatusSchema.parse(
      status([{ ...training, estimate: { n: 14, auc: 0.66 } }]),
    );
    expect(parsed.feeds[0]).toMatchObject({ estimate: { n: 14, auc: 0.66 } });
    const nullAuc = LearningStatusSchema.parse(
      status([{ ...training, estimate: { n: 14, auc: null } }]),
    );
    expect(nullAuc.feeds[0]).toMatchObject({ estimate: { n: 14, auc: null } });
  });

  it('accepts an estimate-only entry', () => {
    const parsed = LearningStatusSchema.parse(
      status([{ feedId: 'f2', estimate: { n: 9, auc: 0.6 } }]),
    );
    expect(parsed.feeds[0]).toEqual({ feedId: 'f2', estimate: { n: 9, auc: 0.6 } });
  });

  it('rejects unknown keys in an estimate, a Training entry and an estimate-only entry', () => {
    expect(() =>
      LearningStatusSchema.parse(status([{ ...training, estimate: { n: 1, auc: 0.5, x: 1 } }])),
    ).toThrow();
    expect(() => LearningStatusSchema.parse(status([{ ...training, extra: 1 }]))).toThrow();
    expect(() =>
      LearningStatusSchema.parse(
        status([{ feedId: 'f2', estimate: { n: 1, auc: 0.5 }, extra: 1 }]),
      ),
    ).toThrow();
  });

  it('rejects a negative or fractional n and a mixed object', () => {
    expect(() =>
      LearningStatusSchema.parse(status([{ feedId: 'f2', estimate: { n: -1, auc: 0.5 } }])),
    ).toThrow();
    expect(() =>
      LearningStatusSchema.parse(status([{ feedId: 'f2', estimate: { n: 1.5, auc: 0.5 } }])),
    ).toThrow();
    // an estimate-only entry carrying one agreement field
    expect(() =>
      LearningStatusSchema.parse(
        status([{ feedId: 'f2', estimate: { n: 1, auc: 0.5 }, status: 'ready' }]),
      ),
    ).toThrow();
    // an estimate-only entry that has no estimate
    expect(() => LearningStatusSchema.parse(status([{ feedId: 'f2' }]))).toThrow();
    expect(() => LearningStatusSchema.parse(status([{ feedId: 'f2', estimate: null }]))).toThrow();
  });
});

describe('LearningStatusSchema estimates.lastRun provenance', () => {
  const run = { at: AT, movedUp: 12, movedDown: 30 };
  const estimates = (lastRun: unknown) => ({ n: 23, auc: 0.71, trainedAt: AT, lastRun });

  it('carries fromRatings', () => {
    const parsed = LearningStatusSchema.parse(
      status([], { estimates: estimates({ ...run, fromRatings: true }) }),
    );
    expect(parsed.estimates?.lastRun).toEqual({ ...run, fromRatings: true });
  });

  it('defaults fromRatings to false when absent', () => {
    const parsed = LearningStatusSchema.parse(status([], { estimates: estimates(run) }));
    expect(parsed.estimates?.lastRun).toEqual({ ...run, fromRatings: false });
  });

  it('requires a boolean, stays strict and keeps a null lastRun', () => {
    expect(() =>
      LearningStatusSchema.parse(
        status([], { estimates: estimates({ ...run, fromRatings: 'yes' }) }),
      ),
    ).toThrow();
    expect(() =>
      LearningStatusSchema.parse(
        status([], { estimates: estimates({ ...run, fromRatings: true, extra: 1 }) }),
      ),
    ).toThrow();
    expect(
      LearningStatusSchema.parse(status([], { estimates: estimates(null) })).estimates?.lastRun,
    ).toBeNull();
  });
});

describe('LearningStatusSchema estimateGate', () => {
  it('defaults to {needed: 0}', () => {
    expect(LearningStatusSchema.parse(status([])).estimateGate).toEqual({ needed: 0 });
  });

  it('accepts a count and is strict', () => {
    expect(
      LearningStatusSchema.parse(status([], { estimateGate: { needed: 6 } })).estimateGate,
    ).toEqual({
      needed: 6,
    });
    expect(() =>
      LearningStatusSchema.parse(status([], { estimateGate: { needed: 6, open: false } })),
    ).toThrow();
    expect(() =>
      LearningStatusSchema.parse(status([], { estimateGate: { needed: -1 } })),
    ).toThrow();
    expect(() =>
      LearningStatusSchema.parse(status([], { estimateGate: { needed: 1.5 } })),
    ).toThrow();
  });
});

describe('hasAgreement', () => {
  it('narrows agreement entries from estimate-only entries', () => {
    const parsed = LearningStatusSchema.parse(
      status([training, { feedId: 'f2', estimate: { n: 9, auc: 0.6 } }]),
    );
    const [first, second] = parsed.feeds;
    expect(hasAgreement(first!)).toBe(true);
    expect(hasAgreement(second!)).toBe(false);
    const narrowed = parsed.feeds.filter(hasAgreement);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]!.status).toBe('collecting');
    expect(narrowed[0]!.estimate).toBeNull();
  });
});

describe('LearningHistoryItemSchema', () => {
  it('parses the contract shape', () => {
    expect(LearningHistoryItemSchema.parse(item)).toEqual(item);
    const estimate = {
      ...item,
      kind: 'estimate' as const,
      auc: null,
      baselineAuc: null,
      activated: false,
      turnedOn: true,
      engineModel: null,
    };
    expect(LearningHistoryItemSchema.parse(estimate)).toEqual(estimate);
  });

  it('rejects an unknown key, an unknown kind, a bad time and a negative n', () => {
    expect(() => LearningHistoryItemSchema.parse({ ...item, extra: 1 })).toThrow();
    expect(() => LearningHistoryItemSchema.parse({ ...item, kind: 'other' })).toThrow();
    expect(() => LearningHistoryItemSchema.parse({ ...item, at: 'yesterday' })).toThrow();
    expect(() => LearningHistoryItemSchema.parse({ ...item, n: -1 })).toThrow();
  });

  it('keeps rejection reasons and requires boolean activation for older readers', () => {
    expect(
      LearningHistoryItemSchema.parse({
        ...item,
        activated: false,
        turnedOn: false,
        reason: 'low_auc,worse_logloss',
      }),
    ).toMatchObject({ activated: false, turnedOn: false, reason: 'low_auc,worse_logloss' });
    expect(() => LearningHistoryItemSchema.parse({ ...item, activated: null })).toThrow();
    expect(() => LearningHistoryItemSchema.parse({ ...item, turnedOn: null })).toThrow();
  });

  it('requires every field', () => {
    for (const key of Object.keys(item)) {
      const { [key]: _omitted, ...rest } = item as Record<string, unknown>;
      expect(() => LearningHistoryItemSchema.parse(rest), key).toThrow();
    }
  });
});

describe('LearningHistorySchema', () => {
  const body = { items: [item], truncated: { model: false, estimate: true } };

  it('parses items with the truncation flags', () => {
    expect(LearningHistorySchema.parse(body)).toEqual(body);
    const empty = { items: [], truncated: { model: false, estimate: false } };
    expect(LearningHistorySchema.parse(empty)).toEqual(empty);
  });

  it('is strict and requires both flags', () => {
    expect(() => LearningHistorySchema.parse({ ...body, extra: 1 })).toThrow();
    expect(() =>
      LearningHistorySchema.parse({ ...body, truncated: { model: false, estimate: true, x: 1 } }),
    ).toThrow();
    expect(() => LearningHistorySchema.parse({ ...body, truncated: { model: false } })).toThrow();
    expect(() => LearningHistorySchema.parse({ items: [item] })).toThrow();
    expect(() =>
      LearningHistorySchema.parse({ ...body, items: [{ ...item, extra: 1 }] }),
    ).toThrow();
  });
});
