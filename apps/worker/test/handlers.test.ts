import { QUEUE_NAMES, isAppError } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import {
  HANDLERS,
  StageUnavailableError,
  dispatch,
  isStageAvailable,
  unavailableQueues,
  type HandlerMap,
} from '../src/handlers/index.js';
import { assertProductionReady } from '../src/readiness.js';

describe('handler map', () => {
  it('registers an entry for every queue of jobs.ts', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it('keeps every M0 stage a stub that refuses to acknowledge work', async () => {
    expect(unavailableQueues(HANDLERS, QUEUE_NAMES)).toEqual(QUEUE_NAMES);
    const error = await dispatch(
      HANDLERS,
      'feed.fetch',
      { feedId: '1' },
      { queue: 'feed.fetch', jobId: 'j' },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageUnavailableError);
    expect(isAppError(error) && error.code).toBe('STAGE_UNAVAILABLE');
  });

  it('runs an implemented handler', async () => {
    const seen: string[] = [];
    const handlers: HandlerMap = {
      ...HANDLERS,
      'user.learn': {
        status: 'implemented',
        handle: async (payload) => {
          seen.push(payload.userId);
        },
      },
    };
    expect(isStageAvailable(handlers, 'user.learn')).toBe(true);
    const userId = '0190a8e6-7d5b-7c2e-9f3a-1b2c3d4e5f60';
    await dispatch(handlers, 'user.learn', { userId }, { queue: 'user.learn', jobId: 'j' });
    expect(seen).toEqual([userId]);
  });
});

describe('production readiness (PLAN §0.5)', () => {
  it('refuses unimplemented required handlers in production only', () => {
    expect(() => assertProductionReady('production', HANDLERS, ['feed.fetch'])).toThrow(
      'refusing to start: unimplemented handlers for feed.fetch',
    );
    expect(assertProductionReady('development', HANDLERS, ['feed.fetch'])).toEqual(['feed.fetch']);
    const ready: HandlerMap = {
      ...HANDLERS,
      'feed.fetch': { status: 'implemented', handle: async () => {} },
    };
    expect(assertProductionReady('production', ready, ['feed.fetch'])).toEqual([]);
  });
});
