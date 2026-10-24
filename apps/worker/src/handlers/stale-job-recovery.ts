import { enqueueDelayedWorkerIntent, retryTransaction } from '@bantoozi/db';
import { buildJobIntent, type QueueName } from '@bantoozi/shared';

import { StaleWorkerError } from '../stale-worker.js';
import { parseStaleRecoveryRevision } from '../stale-recovery.js';
import { nowOf, type WorkerDeps } from './deps.js';
import type { QueueHandler } from './index.js';

/**
 * A stale fence can fire before work starts or after a call's result is discarded and leases
 * released. Keep the queue's normal retries, then preserve a delayed intent on the last attempt:
 * no sweeper recovers every stage, and the same stale process may consume any number of jobs.
 */
export function recoverStaleJob<Q extends QueueName>(
  deps: WorkerDeps,
  handle: QueueHandler<Q>,
): QueueHandler<Q> {
  return async (payload, context) => {
    try {
      await handle(payload, context);
    } catch (error) {
      if (
        error instanceof StaleWorkerError &&
        (context.retry === undefined || context.retry.count >= context.retry.limit)
      ) {
        try {
          const previous = parseStaleRecoveryRevision(context.staleRecoveryRevision);
          const hop = previous === null ? 0 : previous.hop + 1;
          const delaySeconds = Math.min(error.retryDelaySeconds * 2 ** Math.min(hop, 5), 15 * 60);
          const availableAt = new Date(nowOf(deps).getTime() + delaySeconds * 1000);
          // A relay may still be acknowledging the original intent. This job's replacement must
          // not coalesce with that intent; repeated handling of this job still coalesces with itself.
          const intent = buildJobIntent(context.queue, payload, {
            revision: `stale:${previous?.originalJobId ?? context.jobId}:${hop}`,
          });
          const inserted = await retryTransaction(deps.db, (tx) =>
            enqueueDelayedWorkerIntent(tx, intent, availableAt),
          );
          if (inserted) {
            deps.logger.warn(
              { queue: context.queue, jobId: context.jobId, availableAt, hop },
              'stale worker: delayed intent left for a current worker',
            );
          }
        } catch (recoveryError) {
          deps.logger.error(
            { err: recoveryError, queue: context.queue, jobId: context.jobId },
            'stale worker recovery failed',
          );
        }
      }
      throw error;
    }
  };
}
