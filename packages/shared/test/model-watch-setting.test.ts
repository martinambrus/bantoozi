import { describe, expect, it } from 'vitest';

import {
  EngineModelWatchSchema,
  HOUSE_CRON_QUEUES,
  HOUSE_CRON_SCHEDULES,
  HOUSE_PROGRESS_JOBS,
  MODEL_NOTICE_MAX_ATTEMPTS,
  QUEUES,
  SETTINGS,
  enqueueModelWatch,
  parseJobPayload,
  resolveWorkerQueues,
  settingDefault,
  type JobIntent,
  type JobSender,
} from '../src/index.js';

/**
 * JEV-3 registration points: the `house.model-watch` queue, its 6-hour cron and enqueue helper, and
 * the worker-written `engine.model_watch` setting (trigger rate limit, newest check, pending mail).
 */

const AT = '2026-10-21T10:00:00.000Z';

function capture(): { sender: JobSender; intents: JobIntent[] } {
  const intents: JobIntent[] = [];
  return { intents, sender: { enqueue: (i) => (intents.push(i), Promise.resolve()) } };
}

describe('house.model-watch queue', () => {
  it('is a singleton housekeeping queue with an empty payload and a 6-hour cron', () => {
    expect(HOUSE_CRON_QUEUES).toContain('house.model-watch');
    expect(HOUSE_PROGRESS_JOBS).toContain('house.model-watch');
    expect(QUEUES['house.model-watch'].options).toMatchObject({
      policy: 'singleton',
      retryLimit: 1,
    });
    expect(QUEUES['house.model-watch'].concurrency).toBe(1);
    expect(HOUSE_CRON_SCHEDULES['house.model-watch']).toEqual({
      cron: '35 */6 * * *',
      everyMs: 6 * 60 * 60_000,
    });
    expect(parseJobPayload('house.model-watch', {})).toEqual({});
    expect(() => parseJobPayload('house.model-watch', { force: true })).toThrow();
    expect(resolveWorkerQueues('*')).toContain('house.model-watch');
  });

  it('enqueueModelWatch builds one validated intent; a revision separates triggers', async () => {
    const { sender, intents } = capture();
    await enqueueModelWatch(sender);
    await enqueueModelWatch(sender, { revision: 'unavailable:2026-10-21T10:00:00.000Z' });
    expect(intents.map((i) => [i.queue, i.payload, i.send])).toEqual([
      ['house.model-watch', {}, { kind: 'send' }],
      ['house.model-watch', {}, { kind: 'send' }],
    ]);
    expect(intents[0]!.dedupeKey).not.toBe(intents[1]!.dedupeKey);
    // Control: the same call twice coalesces (identical dedupe key).
    await enqueueModelWatch(sender);
    expect(intents[2]!.dedupeKey).toBe(intents[0]!.dedupeKey);
  });
});

describe('engine.model_watch setting', () => {
  it('is worker-written and has no default', () => {
    expect(SETTINGS['engine.model_watch'].writers).toEqual(['worker']);
    expect(
      settingDefault('engine.model_watch', {
        dailyBudgetUsd: 2,
        languageModes: { en: 'native', sk: 'native', cs: 'native' },
        signupMode: 'invite',
      }),
    ).toBeUndefined();
  });

  it('accepts an optional strict candidate while preserving old rows', () => {
    const candidate = { model: 'jev-1.14.0', firstSeenAt: AT, count: 1 };
    expect(EngineModelWatchSchema.parse({ candidate })).toEqual({ candidate });
    for (const invalid of [
      { ...candidate, model: 'jev-latest' },
      { ...candidate, firstSeenAt: 'yesterday' },
      { ...candidate, count: 0 },
      { ...candidate, count: 1.5 },
      { ...candidate, extra: true },
    ])
      expect(EngineModelWatchSchema.safeParse({ candidate: invalid }).success).toBe(false);
    // The previous strict schema ignores the extended row through watchStateOf's fallback.
    expect(EngineModelWatchSchema.omit({ candidate: true }).safeParse({ candidate }).success).toBe(
      false,
    );
  });

  it('accepts the three parts and nothing else', () => {
    const full = {
      triggeredAt: AT,
      lastCheck: { at: AT, ok: false, error: 'provider_unavailable' },
      notice: {
        from: 'jev-1.13.0',
        to: 'jev-1.14.0',
        at: AT,
        major: false,
        attempts: MODEL_NOTICE_MAX_ATTEMPTS,
      },
    };
    expect(EngineModelWatchSchema.parse(full)).toEqual(full);
    expect(EngineModelWatchSchema.parse({})).toEqual({});
    expect(EngineModelWatchSchema.parse({ lastCheck: { at: AT, ok: true } })).toEqual({
      lastCheck: { at: AT, ok: true },
    });
    expect(EngineModelWatchSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
    expect(
      EngineModelWatchSchema.safeParse({ notice: { ...full.notice, to: 'jev-latest' } }).success,
    ).toBe(false);
    expect(
      EngineModelWatchSchema.safeParse({ notice: { ...full.notice, from: 'gpt-5' } }).success,
    ).toBe(false);
    expect(
      EngineModelWatchSchema.safeParse({
        notice: { ...full.notice, attempts: MODEL_NOTICE_MAX_ATTEMPTS + 1 },
      }).success,
    ).toBe(false);
    expect(EngineModelWatchSchema.safeParse({ triggeredAt: 'yesterday' }).success).toBe(false);
    expect(
      EngineModelWatchSchema.safeParse({ lastCheck: { at: AT, ok: false, error: '' } }).success,
    ).toBe(false);
  });
});
