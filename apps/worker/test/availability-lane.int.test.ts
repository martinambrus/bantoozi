import type { EngineRouter, RouterStatus } from '@bantoozi/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { primaryAvailability } from '../src/classify/availability.js';
import { dispatch } from '../src/handlers/index.js';
import { ClassifyHarness, DAY, MINUTE, ago } from './support/classify.js';

/**
 * JEV-2-C (availability): a router that reports no Jev lane (`typesafeLane: 'unconfigured'`, the
 * configured model is an unresolved alias) is not an available primary engine, so
 * `house.rescore-degraded` re-enqueues nothing and says why. Breaker states still win.
 */
let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.owner.query(
    `UPDATE articles SET pipeline_state = 'stale' WHERE pipeline_state <> 'stale'`,
  );
  await h.owner.query('DELETE FROM match_queue');
  await h.deleteSetting('house.progress');
  await h.deleteSetting('engine.circuit');
  await h.clearOutbox();
});

const NOW = new Date('2026-10-20T12:00:00.000Z');

/** A healthy world (closed breaker, credential, budget) whose lane state is `lane`. */
function routerWith(lane: 'unconfigured' | 'ready' | undefined): EngineRouter {
  const status = async (): Promise<RouterStatus> =>
    ({
      credentials: {
        typesafe: { source: 'env', enabled: true },
        ollama: { source: 'env', enabled: true },
      },
      breakers: {
        typesafe: { state: 'closed', reopenCount: 0 },
        llm: { state: 'closed', reopenCount: 0 },
      },
      spendTodayUsd: 0,
      budgetUsd: 2,
      llmCallsToday: 0,
      ...(lane === undefined ? {} : { typesafeLane: lane }),
    }) as RouterStatus;
  return { status, canSpend: async () => true } as unknown as EngineRouter;
}

const availability = (lane: 'unconfigured' | 'ready' | undefined) =>
  primaryAvailability(h.db, routerWith(lane), h.settingsEnv, NOW);

const closed = { state: 'closed', reopenCount: 0 } as const;
const mirror = (typesafe: Record<string, unknown>) =>
  h.setSetting('engine.circuit', { typesafe, llm: closed, resetRequested: {} });

describe('primaryAvailability and the Jev lane', () => {
  it('A1 an unconfigured lane is unavailable; ready and absent are available; breakers still win', async () => {
    expect(await availability('unconfigured')).toEqual({
      available: false,
      reason: 'unconfigured',
    });
    // Control: the same healthy world with the lane ready, or no field, is available.
    expect(await availability('ready')).toEqual({ available: true });
    expect(await availability(undefined)).toEqual({ available: true });

    await mirror({ state: 'auth', reopenCount: 0 });
    expect(await availability('unconfigured')).toEqual({ available: false, reason: 'auth' });
    await mirror({
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(NOW.getTime() + 10 * MINUTE).toISOString(),
      reopenCount: 1,
    });
    expect(await availability('unconfigured')).toEqual({
      available: false,
      reason: 'circuit_open',
    });
    // An open period that has passed does not hide the missing lane.
    await mirror({
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(NOW.getTime() - MINUTE).toISOString(),
      reopenCount: 1,
    });
    expect(await availability('unconfigured')).toEqual({
      available: false,
      reason: 'unconfigured',
    });
  });
});

describe('house.rescore-degraded with an unconfigured Jev lane', () => {
  it('A2 re-enqueues no article.enrich and records the skip reason; a ready lane recovers', async () => {
    const userId = await h.user();
    const feedId = await h.feed();
    await h.subscribe(userId, feedId, 'active', ago(30 * DAY));
    const degraded = await h.article({ feedIds: [feedId], state: 'degraded' });

    const info = vi.fn();
    const handlers = h.handlersWith({ logger: { info, warn: () => {}, error: () => {} } as never });
    const run = async () => {
      const since = await h.mark();
      await dispatch(
        handlers,
        'house.rescore-degraded',
        {},
        { queue: 'house.rescore-degraded', jobId: 'direct' },
      );
      return h.payloads('article.enrich', since);
    };

    const status = h.router.status.bind(h.router);
    Object.assign(h.router, {
      status: async (): Promise<RouterStatus> =>
        ({ ...(await status()), typesafeLane: 'unconfigured' }) as RouterStatus,
    });
    try {
      expect(await run()).toEqual([]);
      expect(
        info.mock.calls.some(
          ([fields]) => (fields as { skipped?: string } | undefined)?.skipped === 'unconfigured',
        ),
      ).toBe(true);
      expect(await h.setting('house.progress')).toBeUndefined();
    } finally {
      delete (h.router as unknown as Record<string, unknown>)['status'];
    }

    // Control: with the lane ready the same degraded article is recovered.
    expect(await run()).toEqual([{ articleId: degraded, priority: 'bulk' }]);
  });
});
