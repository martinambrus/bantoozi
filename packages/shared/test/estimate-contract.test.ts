import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKER_CONFIG,
  DEFAULT_USER_PREFERENCES,
  ESTIMATE_DEBOUNCE_SECONDS,
  QUEUES,
  QUEUE_NAMES,
  RANKING_RELEVANT_PREFERENCES,
  UserPreferencesPatchSchema,
  buildJobIntent,
  enqueueEstimate,
  mergeRankerConfig,
  mergeUserPreferences,
  parseJobPayload,
  readUserPreferences,
  type JobIntent,
  type JobSender,
} from '../src/index.js';

const USER = '0190d4a7-1234-7abc-8def-0123456789ab';
const OTHER = '0190d4a7-1234-7abc-8def-0123456789ac';
const ARRIVAL = '2026-10-01T10:00:00.000Z';

describe('user.estimate queue', () => {
  it('is registered as a stately queue with concurrency 2', () => {
    expect(QUEUE_NAMES).toContain('user.estimate');
    expect(QUEUES['user.estimate'].concurrency).toBe(2);
    expect(QUEUES['user.estimate'].options).toMatchObject({ policy: 'stately' });
  });

  it('accepts exactly {userId: uuid}', () => {
    expect(parseJobPayload('user.estimate', { userId: USER })).toEqual({ userId: USER });
    expect(() => parseJobPayload('user.estimate', { userId: 'nope' })).toThrow();
    expect(() => parseJobPayload('user.estimate', {} as never)).toThrow();
    expect(() => parseJobPayload('user.estimate', { userId: USER, extra: 1 } as never)).toThrow();
  });

  it('debounces per user for 20 seconds under the key estimate:<userId>', () => {
    expect(ESTIMATE_DEBOUNCE_SECONDS).toBe(20);
    expect(buildJobIntent('user.estimate', { userId: USER }).send).toEqual({
      kind: 'debounced',
      key: `estimate:${USER}`,
      seconds: 20,
    });
  });

  it('gives two intents of one user the same dedupe key and two users different ones', () => {
    const a = buildJobIntent('user.estimate', { userId: USER });
    const b = buildJobIntent('user.estimate', { userId: USER });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(buildJobIntent('user.estimate', { userId: OTHER }).dedupeKey).not.toBe(a.dedupeKey);
  });

  it('enqueueEstimate sends one intent for the user without a revision', async () => {
    const sent: JobIntent[] = [];
    const sender = {
      enqueue: async (intent: JobIntent) => {
        sent.push(intent);
      },
    } as unknown as JobSender;
    await enqueueEstimate(sender, { userId: USER });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.queue).toBe('user.estimate');
    expect(sent[0]?.dedupeKey).toBe(buildJobIntent('user.estimate', { userId: USER }).dedupeKey);
  });
});

describe('user.rank estimate payload', () => {
  const rank = (extra: Record<string, unknown>) =>
    ({ userId: USER, reason: 'estimate', ...extra }) as never;

  it('accepts an empty estimate and one with version, up and down', () => {
    expect(() => parseJobPayload('user.rank', rank({ estimate: {} }))).not.toThrow();
    expect(
      parseJobPayload('user.rank', rank({ estimate: { version: 3, up: 1, down: 0 } })),
    ).toMatchObject({
      estimate: { version: 3, up: 1, down: 0 },
    });
  });

  it('rejects unknown keys inside estimate', () => {
    expect(() => parseJobPayload('user.rank', rank({ estimate: { extra: 1 } }))).toThrow();
  });

  it('rejects estimate together with full: true', () => {
    expect(() => parseJobPayload('user.rank', rank({ full: true, estimate: {} }))).toThrow();
  });

  it('sends {estimate: {}} as singleton rank-est:<userId>', () => {
    expect(buildJobIntent('user.rank', rank({ estimate: {} })).send).toEqual({
      kind: 'send',
      singletonKey: `rank-est:${USER}`,
    });
  });

  it('sends an estimate continuation as rank-est-cont:<userId>:<arrival>:<articleId>', () => {
    const payload = rank({
      estimate: { version: 2 },
      cursor: { arrival: ARRIVAL, articleId: '77' },
    });
    expect(buildJobIntent('user.rank', payload).send).toEqual({
      kind: 'send',
      singletonKey: `rank-est-cont:${USER}:${ARRIVAL}:77`,
    });
  });

  it('keeps the plain cursor on rank-cont and plain and full ranks unchanged', () => {
    expect(
      buildJobIntent('user.rank', {
        userId: USER,
        reason: 'x',
        full: true,
        snapshotAt: ARRIVAL,
        cursor: { arrival: ARRIVAL, articleId: '77' },
      } as never).send,
    ).toEqual({ kind: 'send', singletonKey: `rank-cont:${USER}:${ARRIVAL}:77` });
    expect(
      buildJobIntent('user.rank', { userId: USER, reason: 'x', full: true } as never).send,
    ).toEqual({
      kind: 'send',
      singletonKey: `rank-full:${USER}`,
    });
    expect(buildJobIntent('user.rank', { userId: USER, reason: 'x' } as never).send).toEqual({
      kind: 'debounced',
      key: `rank:${USER}`,
      seconds: 3,
    });
  });
});

describe('RankerConfig.estimate', () => {
  it('defaults to minRatings 10 and minEachClass 3', () => {
    expect(DEFAULT_RANKER_CONFIG.estimate).toEqual({ minRatings: 10, minEachClass: 3 });
    expect(mergeRankerConfig({}).estimate).toEqual({ minRatings: 10, minEachClass: 3 });
  });

  it('keeps minEachClass when only minRatings is overridden', () => {
    expect(mergeRankerConfig({ estimate: { minRatings: 20 } }).estimate).toEqual({
      minRatings: 20,
      minEachClass: 3,
    });
  });

  it('rejects an unknown estimate key', () => {
    expect(() => mergeRankerConfig({ estimate: { minRating: 20 } })).toThrow();
  });

  it('rejects zero and fractional thresholds', () => {
    expect(() => mergeRankerConfig({ estimate: { minRatings: 0 } })).toThrow();
    expect(() => mergeRankerConfig({ estimate: { minEachClass: 0 } })).toThrow();
    expect(() => mergeRankerConfig({ estimate: { minRatings: 2.5 } })).toThrow();
    expect(() => mergeRankerConfig({ estimate: { minEachClass: 1.5 } })).toThrow();
  });
});

describe('estimates preference', () => {
  it('defaults to on', () => {
    expect(DEFAULT_USER_PREFERENCES.estimates).toBe('on');
    expect(readUserPreferences({}).estimates).toBe('on');
  });

  it('reads on for a stored value that is garbage or null and keeps a stored off', () => {
    expect(readUserPreferences({ estimates: 'maybe' }).estimates).toBe('on');
    expect(readUserPreferences({ estimates: 7 }).estimates).toBe('on');
    expect(readUserPreferences(null).estimates).toBe('on');
    expect(readUserPreferences({ estimates: 'off' }).estimates).toBe('off');
  });

  it('accepts on and off in a patch and rejects anything else', () => {
    expect(UserPreferencesPatchSchema.safeParse({ estimates: 'on' }).success).toBe(true);
    expect(UserPreferencesPatchSchema.safeParse({ estimates: 'off' }).success).toBe(true);
    expect(UserPreferencesPatchSchema.safeParse({ estimates: 'maybe' }).success).toBe(false);
  });

  it('merges the patch and keeps the other leaves', () => {
    const current = readUserPreferences({ theme: 'dark', sort: 'newest' });
    const next = mergeUserPreferences(current, { estimates: 'off' });
    expect(next).toEqual({ ...current, estimates: 'off' });
    expect(next.theme).toBe(current.theme);
  });

  it('is ranking relevant', () => {
    expect(RANKING_RELEVANT_PREFERENCES).toContain('estimates');
  });
});
