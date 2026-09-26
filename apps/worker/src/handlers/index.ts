import { AppError, QUEUE_NAMES, type JobPayload, type QueueName } from '@bantoozi/shared';

import { createCaptureBookmarkHandler } from './article-capture-bookmark.js';
import { createArticleExtractHandler } from './article-extract.js';
import type { WorkerDeps } from './deps.js';
import { createFeedFetchHandler } from './feed-fetch.js';
import { createFeedScheduleHandler } from './feed-schedule.js';

/**
 * The handler map (spec 03 §2): one entry for every queue of `packages/shared` jobs.ts. A stage that
 * a later milestone implements is registered as `unavailable` so it is discoverable in development:
 * the worker does not consume its queue (jobs stay pending in pg-boss), the outbox relay keeps its
 * intents (`stage_unavailable`), and production startup refuses to run it (PLAN §0.5).
 */

export interface JobContext {
  queue: QueueName;
  jobId: string;
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

/** Queues with real handlers so far (M1: scheduling, fetch, extraction, bookmark capture). */
export const IMPLEMENTED_QUEUES = [
  'feed.schedule',
  'feed.fetch',
  'article.extract',
  'article.capture-bookmark',
] as const satisfies readonly QueueName[];

/** The worker's handler map: the implemented stages bound to their dependencies, stubs elsewhere. */
export function createHandlers(deps: WorkerDeps): HandlerMap {
  return Object.freeze({
    ...HANDLERS,
    'feed.schedule': { status: 'implemented', handle: createFeedScheduleHandler(deps) },
    'feed.fetch': { status: 'implemented', handle: createFeedFetchHandler(deps) },
    'article.extract': { status: 'implemented', handle: createArticleExtractHandler(deps) },
    'article.capture-bookmark': {
      status: 'implemented',
      handle: createCaptureBookmarkHandler(deps),
    },
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
