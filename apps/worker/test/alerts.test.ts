import { describe, expect, it } from 'vitest';

import {
  BACKUP_MEMO_KEY,
  applyRun,
  planNotifications,
  type AlertState,
} from '../src/alerts/notify.js';
import { createLibreTranslateProbe } from '../src/alerts/probe.js';
import { createBossOptions } from '../src/boss.js';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const cond = (key: string) => ({ key, title: key, detail: 'd' });
const active = (lastSentAt: string | null) => ({
  firstAt: '2030-01-01T00:00:00.000Z',
  lastSentAt,
  active: true,
});

describe('alert planning', () => {
  it('re-sends after 6 h, recovers, closes unsent incidents silently and skips failed rules', () => {
    const state: AlertState = {
      fresh: active('2030-01-01T10:00:00.000Z'),
      old: active('2030-01-01T05:59:00.000Z'),
      gone: active('2030-01-01T08:00:00.000Z'),
      never: active(null),
      'skipped.a': active('2030-01-01T08:00:00.000Z'),
      [BACKUP_MEMO_KEY]: { firstAt: '2030-01-01T11:00:00.000Z', lastSentAt: null, active: false },
    };
    const plan = planNotifications(
      state,
      [cond('fresh'), cond('old'), cond('new')],
      ['skipped'],
      NOW,
    );
    expect(plan.alerts.map((a) => a.key)).toEqual(['new', 'old']);
    expect(plan.recoveries).toEqual(['gone']);
    expect(plan.silent).toEqual(['never']);
  });

  it('keeps undelivered mail pending with a failure count and re-arms on a delivered recovery', () => {
    const plan = planNotifications({}, [cond('a')], [], NOW);
    const failed = applyRun({}, plan, [cond('a')], { alertsSent: false }, undefined, NOW);
    expect(failed['a']).toMatchObject({ lastSentAt: null, active: true, failures: 1 });
    const sent = applyRun(
      failed,
      planNotifications(failed, [cond('a')], [], NOW),
      [cond('a')],
      { alertsSent: true },
      undefined,
      NOW,
    );
    expect(sent['a']).toEqual({
      firstAt: NOW.toISOString(),
      lastSentAt: NOW.toISOString(),
      active: true,
      title: 'a',
    });
    const recoveryPlan = planNotifications(sent, [], [], NOW);
    expect(
      applyRun(sent, recoveryPlan, [], { recoveriesSent: false }, undefined, NOW)['a'],
    ).toMatchObject({ failures: 1 });
    expect(
      applyRun(sent, recoveryPlan, [], { recoveriesSent: true }, undefined, NOW)['a'],
    ).toBeUndefined();
  });
});

describe('LibreTranslate probe', () => {
  const answer = (status: number) =>
    (() => Promise.resolve(new Response('[]', { status }))) as typeof fetch;
  it('is up on 2xx and down on errors, non-2xx and timeouts', async () => {
    expect(await createLibreTranslateProbe('http://lt:5000/', { fetch: answer(200) })()).toBe(true);
    expect(await createLibreTranslateProbe('http://lt:5000', { fetch: answer(503) })()).toBe(false);
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as unknown as typeof fetch;
    expect(
      await createLibreTranslateProbe('http://lt:5000', { fetch: hang, timeoutMs: 20 })(),
    ).toBe(false);
  });
});

describe('pg-boss options', () => {
  it('keeps failed jobs for 30 days: archived after 23 days, deleted 7 days later (spec 11 §5)', () => {
    const options = createBossOptions('postgres://x');
    expect(options.archiveFailedAfterSeconds).toBe(23 * 86_400);
    expect(options.deleteAfterDays).toBe(7);
    expect(options.migrate).toBe(false);
  });
});
