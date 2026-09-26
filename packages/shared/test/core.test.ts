import { describe, expect, it } from 'vitest';

import {
  AppError,
  DEFAULT_USER_PREFERENCES,
  ExplainSchema,
  PLANS,
  QuotaExceededError,
  UserPreferencesPatchSchema,
  admitsAutomaticInference,
  analysisRequestTransition,
  compareBigIntStrings,
  createManualClock,
  effectiveImagesAllowed,
  feedHttpErrorCode,
  httpStatusForCode,
  isBigIntString,
  isUuid,
  mergeImagePolicies,
  mergeUserPreferences,
  newUserId,
  nextRevision,
  planInferenceModeChange,
  planLimits,
  planMinIntervalMap,
  readUserPreferences,
  utcDay,
} from '../src/index.js';

describe('ids (spec 01 §5)', () => {
  it('generates time-ordered UUID v7 user ids', () => {
    const a = newUserId();
    const b = newUserId();
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b || a.slice(0, 13) === b.slice(0, 13)).toBe(true);
  });

  it('handles bigint ids and revisions as decimal strings without Number', () => {
    expect(isBigIntString('9223372036854775807')).toBe(true);
    expect(isBigIntString('9223372036854775808')).toBe(false);
    expect(isBigIntString('-9223372036854775808')).toBe(true);
    expect(isBigIntString('007')).toBe(false);
    expect(isBigIntString('-0')).toBe(false);
    expect(isBigIntString('1e3')).toBe(false);
    expect(nextRevision('9007199254740993')).toBe('9007199254740994');
    expect(compareBigIntStrings('9007199254740993', '9007199254740992')).toBe(1);
  });
});

describe('errors (spec 08 §1)', () => {
  it('maps every code to its HTTP status in one place', () => {
    const table: Record<string, number> = {
      VALIDATION_FAILED: 400,
      INVALID_CODE: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      STALE_CURSOR: 409,
      STALE_STATE: 409,
      IDEMPOTENCY_CONFLICT: 409,
      QUOTA_EXCEEDED: 409,
      INVITE_REQUIRED: 403,
      RATE_LIMITED: 429,
      FEED_NOT_A_FEED: 422,
      FEED_TIMEOUT: 422,
      ENGINE_UNAVAILABLE: 503,
      INTERNAL: 500,
    };
    for (const [code, status] of Object.entries(table)) {
      expect(httpStatusForCode(code as never), code).toBe(status);
    }
    expect(httpStatusForCode(feedHttpErrorCode(404))).toBe(422);
    expect(() => feedHttpErrorCode(99)).toThrow();
  });

  it('carries a stable code and details', () => {
    const e = new QuotaExceededError('maxFeeds', 200, 200);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('QUOTA_EXCEEDED');
    expect(e.httpStatus).toBe(409);
    expect(e.details).toEqual({ limit: 'maxFeeds', used: 200, max: 200 });
  });
});

describe('clock', () => {
  it('is injectable and controllable', () => {
    const clock = createManualClock('2026-09-25T10:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-09-25T10:00:00.000Z');
    clock.advance(14 * 3600_000);
    expect(utcDay(clock.now())).toBe('2026-09-26');
  });
});

describe('plans (spec 08 §6)', () => {
  it('matches the plan table', () => {
    expect(PLANS.beta).toEqual({
      maxFeeds: 200,
      maxCards: 50,
      maxLabels: 20,
      maxForks: 20,
      maxRules: 200,
      opmlMaxFeeds: 300,
      minFetchIntervalS: 900,
      backfillDays: 7,
      invitesOnSignup: 3,
    });
    expect(PLANS.admin).toEqual({
      maxFeeds: 2000,
      maxCards: 500,
      maxLabels: 200,
      maxForks: 200,
      maxRules: 2000,
      opmlMaxFeeds: 2000,
      minFetchIntervalS: 300,
      backfillDays: 14,
      invitesOnSignup: 50,
    });
    expect(planMinIntervalMap()).toEqual({ beta: 900, admin: 300 });
    expect(planLimits('unknown')).toBe(PLANS.beta);
  });
});

describe('UserPreferences (spec 08 §3.1)', () => {
  it('applies defaults on read and tolerates bad stored leaves', () => {
    expect(readUserPreferences({})).toEqual(DEFAULT_USER_PREFERENCES);
    expect(readUserPreferences(null)).toEqual(DEFAULT_USER_PREFERENCES);
    const read = readUserPreferences({
      defaultTier: 3,
      demote: { clickbait: 'on' },
      theme: 'neon',
      legacy: 1,
    });
    expect(read.defaultTier).toBe(3);
    expect(read.demote).toEqual({
      clickbait: 'on',
      promotional: 'auto',
      shallow: 'auto',
      stale: 'auto',
    });
    expect(read.theme).toBe('system');
    expect(read).not.toHaveProperty('legacy');
    expect(DEFAULT_USER_PREFERENCES.loadRemoteImages).toBe(false);
    expect(DEFAULT_USER_PREFERENCES.implicitFeedback).toBe(false);
    expect(DEFAULT_USER_PREFERENCES.exampleSuggestions).toBe(true);
    expect(DEFAULT_USER_PREFERENCES.swipe).toEqual({ left: 'dislike', right: 'like' });
    expect(readUserPreferences({ exampleSuggestions: 'no' }).exampleSuggestions).toBe(true);
  });

  it('merges only supplied leaves and replaces arrays', () => {
    const current = { ...DEFAULT_USER_PREFERENCES, folderOrder: ['a', 'b'] };
    const patch = UserPreferencesPatchSchema.parse({
      demote: { stale: 'off' },
      folderOrder: ['c'],
    });
    const next = mergeUserPreferences(current, patch);
    expect(next.demote).toEqual({
      clickbait: 'auto',
      promotional: 'auto',
      shallow: 'auto',
      stale: 'off',
    });
    expect(next.folderOrder).toEqual(['c']);
    expect(current.demote.stale).toBe('auto');
    const quiet = mergeUserPreferences(
      current,
      UserPreferencesPatchSchema.parse({ exampleSuggestions: false }),
    );
    expect(quiet.exampleSuggestions).toBe(false);
  });

  it('rejects unknown keys and empty patches', () => {
    expect(() => UserPreferencesPatchSchema.parse({})).toThrow();
    expect(() => UserPreferencesPatchSchema.parse({ theme: 'dark', bogus: true })).toThrow();
    expect(() => UserPreferencesPatchSchema.parse({ demote: {} })).toThrow();
    expect(() => UserPreferencesPatchSchema.parse({ defaultTier: 6 })).toThrow();
    expect(() =>
      UserPreferencesPatchSchema.parse({ onboardingCompletedAt: 'yesterday' }),
    ).toThrow();
  });
});

describe('inference mode policy (spec 02 §3.4)', () => {
  const t0 = new Date('2026-09-25T10:00:00Z');

  it('CAS-checks the version, no-ops on the same mode and stamps activation', () => {
    const off = { mode: 'off' as const, version: '0', activatedAt: null };
    expect(() => planInferenceModeChange(off, 'active', '1', t0)).toThrow(/version/);
    expect(planInferenceModeChange(off, 'off', '0', t0)).toEqual({ kind: 'noop', state: off });
    const toActive = planInferenceModeChange(off, 'active', '0', t0);
    expect(toActive).toEqual({
      kind: 'change',
      from: 'off',
      state: { mode: 'active', version: '1', activatedAt: t0 },
    });
    const toTraining = planInferenceModeChange(toActive.state, 'training', '1', t0);
    expect(toTraining.state).toEqual({ mode: 'training', version: '2', activatedAt: null });
  });

  it('admits automatic inference only for active carriers arriving at/after activation', () => {
    const active = { mode: 'active' as const, version: '4', activatedAt: t0 };
    expect(admitsAutomaticInference(active, new Date(t0.getTime() - 1))).toBe(false);
    expect(admitsAutomaticInference(active, t0)).toBe(true);
    expect(admitsAutomaticInference(active, new Date(t0.getTime() + 1), '4')).toBe(true);
    expect(admitsAutomaticInference(active, new Date(t0.getTime() + 1), '3')).toBe(false);
    expect(
      admitsAutomaticInference({ mode: 'training', version: '4', activatedAt: null }, t0),
    ).toBe(false);
  });

  it('requires explicit startTraining consent for selected-article analysis on off feeds', () => {
    expect(analysisRequestTransition('off', false)).toEqual({ allowed: false });
    expect(analysisRequestTransition('off', true)).toEqual({ allowed: true, enterTraining: true });
    expect(analysisRequestTransition('training', false)).toEqual({
      allowed: true,
      enterTraining: false,
    });
    expect(analysisRequestTransition('active', false)).toEqual({
      allowed: true,
      enterTraining: false,
    });
  });
});

describe('image policy (spec 08 §4.2)', () => {
  it('lets explicit feed choices override the global preference', () => {
    expect(effectiveImagesAllowed('allow', false)).toBe(true);
    expect(effectiveImagesAllowed('block', true)).toBe(false);
    expect(effectiveImagesAllowed('inherit', true)).toBe(true);
    expect(effectiveImagesAllowed(null, false)).toBe(false);
  });

  it('preserves block when merging conflicting preferences', () => {
    expect(mergeImagePolicies('allow', 'block')).toBe('block');
    expect(mergeImagePolicies('inherit', 'allow')).toBe('allow');
    expect(mergeImagePolicies('inherit', 'inherit')).toBe('inherit');
  });
});

describe('Explain v1 (spec 06 §6.2)', () => {
  const explain = {
    v: 1,
    inputs: { contentRevision: '3', rankRevision: '12', contextSha: 'a'.repeat(64) },
    source: 'cards',
    p: 0.82,
    lane: 'for_you',
    tier: 4,
    decidingCardId: '17',
    cards: [{ id: '17', title: 'EV batteries', strength: 'love', p: 0.82, engine: 'typesafe' }],
    rules: [{ code: 'boost_feed', ruleId: '5' }],
    cluster: { id: '9', size: 3 },
  };

  it('accepts a valid explanation and rejects unknown keys or too many cards', () => {
    expect(ExplainSchema.parse(explain)).toEqual(explain);
    expect(() => ExplainSchema.parse({ ...explain, extra: 1 })).toThrow();
    expect(() => ExplainSchema.parse({ ...explain, v: 2 })).toThrow();
    expect(() =>
      ExplainSchema.parse({
        ...explain,
        cards: Array.from({ length: 11 }, () => explain.cards[0]),
      }),
    ).toThrow();
    expect(() => ExplainSchema.parse({ ...explain, p: 1.2 })).toThrow();
  });
});
