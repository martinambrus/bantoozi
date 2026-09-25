import type { NodeEnv } from '@bantoozi/shared/server';
import type { QueueName } from '@bantoozi/shared';

import { unavailableQueues, type HandlerMap } from './handlers/index.js';

/**
 * PLAN §0.5: stub stages exist for development discovery only. Production startup refuses any
 * configured queue whose handler is not implemented; elsewhere the stub queues are returned so the
 * worker can log them.
 */
export function assertProductionReady(
  nodeEnv: NodeEnv,
  handlers: HandlerMap,
  queues: readonly QueueName[],
): QueueName[] {
  const unavailable = unavailableQueues(handlers, queues);
  if (nodeEnv === 'production' && unavailable.length > 0) {
    throw new Error(`refusing to start: unimplemented handlers for ${unavailable.join(', ')}`);
  }
  return unavailable;
}
