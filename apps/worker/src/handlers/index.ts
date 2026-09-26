import { AppError, QUEUE_NAMES, type JobPayload, type QueueName } from '@bantoozi/shared';

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

/** M0: every stage is a registered stub; milestones M1–M8 replace entries with real handlers. */
export const HANDLERS: HandlerMap = Object.freeze(
  Object.fromEntries(QUEUE_NAMES.map((queue) => [queue, unavailable])) as unknown as HandlerMap,
);

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
