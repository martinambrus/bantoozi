import { QUEUE_NAMES, isAppError } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import type { Database } from '@bantoozi/db';
import type { CredentialResolver } from '@bantoozi/shared/server';
import type pg from 'pg';

import type { TranslationDeps } from '../src/classify/translation.js';
import {
  createWorkerDeps,
  type ClassificationDeps,
  type WorkerDepsInput,
} from '../src/handlers/deps.js';
import {
  CLASSIFICATION_QUEUES,
  HANDLERS,
  IMPLEMENTED_QUEUES,
  INGESTION_QUEUES,
  PROVIDER_QUEUES,
  RANKING_QUEUES,
  SUGGEST_QUEUES,
  StageUnavailableError,
  createHandlers,
  dispatch,
  isStageAvailable,
  unavailableQueues,
  type HandlerMap,
} from '../src/handlers/index.js';
import { assertProductionReady } from '../src/readiness.js';

const baseDeps: WorkerDepsInput = {
  db: {} as Database,
  lockPool: {} as pg.Pool,
  fetch: { userAgent: 'test', timeoutMs: 1000, maxBytes: 1024, allowPrivate: false },
  ingestMaxAgeDays: 14,
  settingsEnv: { dailyBudgetUsd: 2, languageModes: {}, signupMode: 'invite' },
  limiter: {
    reserve: async () => ({ status: 'granted', token: 't' }),
    release: async () => {},
    block: async () => {},
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const classification = (translation?: TranslationDeps): ClassificationDeps => ({
  router: {} as ClassificationDeps['router'],
  primaryModel: 'jev-1.13.0',
  leaseMs: 600_000,
  callDeadlineMs: 300_000,
  jobBudgetMs: 600_000,
  ...(translation === undefined ? {} : { translation }),
});

const available = (handlers: HandlerMap) =>
  QUEUE_NAMES.filter((q) => isStageAvailable(handlers, q)).sort();

describe('handler map', () => {
  it('registers an entry for every queue of jobs.ts', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it('implements only the M1 ingestion and M5 ranking stages without classification dependencies', () => {
    const handlers = createHandlers(createWorkerDeps(baseDeps));
    expect(Object.keys(handlers).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(available(handlers)).toEqual([...INGESTION_QUEUES, ...RANKING_QUEUES].sort());
    expect(RANKING_QUEUES).toEqual(['user.rank', 'house.expire-rules']);
    expect(INGESTION_QUEUES).toEqual([
      'feed.schedule',
      'feed.fetch',
      'article.extract',
      'article.capture-bookmark',
    ]);
    expect(unavailableQueues(handlers, ['article.enrich', 'user.rank'])).toEqual([
      'article.enrich',
    ]);
  });

  it('implements the M2 classification stages with classification dependencies', () => {
    const handlers = createHandlers(
      createWorkerDeps({
        ...baseDeps,
        classification: classification({} as TranslationDeps),
      }),
    );
    expect(available(handlers)).toEqual(
      [...INGESTION_QUEUES, ...CLASSIFICATION_QUEUES, ...SUGGEST_QUEUES, ...RANKING_QUEUES].sort(),
    );
    expect(CLASSIFICATION_QUEUES).toEqual([
      'article.translate',
      'article.enrich',
      'article.cluster',
      'article.match',
      'card.backfill',
      'analysis.process',
      'house.rescore-degraded',
    ]);
    expect(unavailableQueues(handlers, ['article.enrich', 'user.rank', 'user.learn'])).toEqual([
      'user.learn',
    ]);
  });

  it('implements provider.validate with the provider probe dependencies', () => {
    const handlers = createHandlers(
      createWorkerDeps({
        ...baseDeps,
        classification: classification({} as TranslationDeps),
        providerValidation: {
          router: {} as ClassificationDeps['router'],
          credentials: {} as CredentialResolver,
          config: {
            nodeEnv: 'test',
            typesafeBaseUrl: 'http://127.0.0.1:9',
            typesafeModel: 'jev-1.13.0',
            typesafePricePerMtokUsd: 0.042,
            ollamaBaseUrl: 'http://127.0.0.1:9',
            ollamaModelFast: 'fast',
            ollamaModelStrong: 'strong',
          },
        },
      }),
    );
    expect(PROVIDER_QUEUES).toEqual(['provider.validate']);
    expect(available(handlers)).toEqual([...IMPLEMENTED_QUEUES].sort());
    expect(unavailableQueues(handlers, QUEUE_NAMES)).not.toContain('provider.validate');
  });

  it('keeps article.translate a stub without the translators', () => {
    const handlers = createHandlers(
      createWorkerDeps({ ...baseDeps, classification: classification() }),
    );
    expect(isStageAvailable(handlers, 'article.translate')).toBe(false);
    expect(isStageAvailable(handlers, 'analysis.process')).toBe(true);
  });

  it('keeps every stage of the base map a stub that refuses to acknowledge work', async () => {
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
