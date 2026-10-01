import { AppError, QUEUE_NAMES, type JobPayload, type QueueName } from '@bantoozi/shared';

import { createAnalysisProcessHandler } from './analysis-process.js';
import { createCaptureBookmarkHandler } from './article-capture-bookmark.js';
import { createArticleClusterHandler } from './article-cluster.js';
import { createArticleEnrichHandler } from './article-enrich.js';
import { createArticleExtractHandler } from './article-extract.js';
import { createArticleMatchHandler } from './article-match.js';
import { createArticleTranslateHandler } from './article-translate.js';
import { createCardBackfillHandler } from './card-backfill.js';
import type { WorkerDeps } from './deps.js';
import { createFeedFetchHandler } from './feed-fetch.js';
import { createFeedScheduleHandler } from './feed-schedule.js';
import { createProviderValidateHandler } from './provider-validate.js';
import { createExpireRulesHandler } from './house-expire-rules.js';
import { createRescoreDegradedHandler } from './house-rescore-degraded.js';
import { createUserRankHandler } from './user-rank.js';

/**
 * The handler map (spec 03 §2): one entry for every queue of `packages/shared` jobs.ts. A stage that
 * a later milestone implements is registered as `unavailable` so it is discoverable in development:
 * the worker does not consume its queue (jobs stay pending in pg-boss), the outbox relay keeps its
 * intents (`stage_unavailable`), and production startup refuses to run it (PLAN §0.5).
 */

export interface JobContext {
  queue: QueueName;
  jobId: string;
  /**
   * The queue's retries of this job (pg-boss `retryCount`/`retryLimit`). Absent when a handler runs
   * outside pg-boss (the dev CLI, tests): that run is its only attempt.
   */
  retry?: { count: number; limit: number };
}

export type QueueHandler<Q extends QueueName> = (
  payload: JobPayload<Q>,
  context: JobContext,
) => Promise<void>;

export type HandlerEntry<Q extends QueueName> =
  { status: 'implemented'; handle: QueueHandler<Q> } | { status: 'unavailable' };

export type HandlerMap = { readonly [Q in QueueName]: HandlerEntry<Q> };

/** Dispatch to a stage that does not exist yet; its durable intent must be kept, never acknowledged. */
export class StageUnavailableError extends AppError {
  constructor(queue: QueueName) {
    super('STAGE_UNAVAILABLE', `Stage ${queue} is not implemented yet`, { details: { queue } });
    this.name = 'StageUnavailableError';
  }
}

const unavailable = { status: 'unavailable' } as const;

/**
 * The base map: every stage a registered stub. `createHandlers` replaces the stages a milestone
 * implements; the rest stay discoverable stubs (M1 implements ingestion, spec 03).
 */
export const HANDLERS: HandlerMap = Object.freeze(
  Object.fromEntries(QUEUE_NAMES.map((queue) => [queue, unavailable])) as unknown as HandlerMap,
);

/** M1 ingestion stages: scheduling, fetch, extraction, bookmark capture. */
export const INGESTION_QUEUES = [
  'feed.schedule',
  'feed.fetch',
  'article.extract',
  'article.capture-bookmark',
] as const satisfies readonly QueueName[];

/**
 * M2 classification stages (specs 04, 05, 07): implemented when the worker has classification
 * dependencies (`article.translate` also needs the translators).
 */
export const CLASSIFICATION_QUEUES = [
  'article.translate',
  'article.enrich',
  'article.cluster',
  'article.match',
  'card.backfill',
  'analysis.process',
  'house.rescore-degraded',
] as const satisfies readonly QueueName[];

/** M2 provider key validation (spec 04 §1.2): implemented when the worker has the probe dependencies. */
export const PROVIDER_QUEUES = ['provider.validate'] as const satisfies readonly QueueName[];

/**
 * M5 ranking (spec 06 §7) and rule expiry (spec 11 §6): they read stored results only, so they need
 * no model dependencies.
 */
export const RANKING_QUEUES = [
  'user.rank',
  'house.expire-rules',
] as const satisfies readonly QueueName[];

/** Queues with real handlers so far (M1 ingestion, M2 classification and key validation, M5 ranking). */
export const IMPLEMENTED_QUEUES = [
  ...INGESTION_QUEUES,
  ...CLASSIFICATION_QUEUES,
  ...PROVIDER_QUEUES,
  ...RANKING_QUEUES,
] as const satisfies readonly QueueName[];

const implemented = <Q extends QueueName>(handle: QueueHandler<Q>): HandlerEntry<Q> => ({
  status: 'implemented',
  handle,
});

/** The worker's handler map: the implemented stages bound to their dependencies, stubs elsewhere. */
export function createHandlers(deps: WorkerDeps): HandlerMap {
  const classification = deps.classification;
  const translation = classification?.translation;
  const providerValidation = deps.providerValidation;
  return Object.freeze({
    ...HANDLERS,
    'feed.schedule': implemented(createFeedScheduleHandler(deps)),
    'feed.fetch': implemented(createFeedFetchHandler(deps)),
    'article.extract': implemented(createArticleExtractHandler(deps)),
    'article.capture-bookmark': implemented(createCaptureBookmarkHandler(deps)),
    'user.rank': implemented(createUserRankHandler(deps)),
    'house.expire-rules': implemented(createExpireRulesHandler(deps)),
    ...(classification === undefined
      ? {}
      : {
          ...(translation === undefined
            ? {}
            : {
                'article.translate': implemented(
                  createArticleTranslateHandler(deps, classification, translation),
                ),
              }),
          'article.enrich': implemented(createArticleEnrichHandler(deps, classification)),
          'article.cluster': implemented(createArticleClusterHandler(deps, classification)),
          'article.match': implemented(createArticleMatchHandler(deps, classification)),
          'card.backfill': implemented(createCardBackfillHandler(deps, classification)),
          'analysis.process': implemented(
            createAnalysisProcessHandler(deps, classification, translation),
          ),
          'house.rescore-degraded': implemented(createRescoreDegradedHandler(deps, classification)),
        }),
    ...(providerValidation === undefined
      ? {}
      : {
          'provider.validate': implemented(
            createProviderValidateHandler({
              db: deps.db,
              logger: deps.logger,
              ...(deps.now === undefined ? {} : { now: deps.now }),
              ...providerValidation,
            }),
          ),
        }),
  }) as HandlerMap;
}

export function isStageAvailable(handlers: HandlerMap, queue: QueueName): boolean {
  return handlers[queue].status === 'implemented';
}

/** The queues among `queues` whose stage is still a stub. */
export function unavailableQueues(handlers: HandlerMap, queues: readonly QueueName[]): QueueName[] {
  return queues.filter((queue) => !isStageAvailable(handlers, queue));
}

/** Run a job's handler; a stub raises {@link StageUnavailableError} instead of acknowledging. */
export async function dispatch<Q extends QueueName>(
  handlers: HandlerMap,
  queue: Q,
  payload: JobPayload<Q>,
  context: JobContext,
): Promise<void> {
  const entry = handlers[queue] as HandlerEntry<Q>;
  if (entry.status !== 'implemented') throw new StageUnavailableError(queue);
  await entry.handle(payload, context);
}
