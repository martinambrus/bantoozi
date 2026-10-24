import { QUEUES, safeParseJobPayload, type QueueName } from '@bantoozi/shared';
import PgBoss, { type ConstructorOptions } from 'pg-boss';

import { dispatch, isStageAvailable, type HandlerMap } from './handlers/index.js';
import type { JobBroker, RelayLogger } from './outbox-relay.js';
import { parseStaleRecoveryRevision } from './stale-recovery.js';

/**
 * pg-boss in the worker (spec 02 §1.2): started with `migrate: false` on the worker role; the migrate
 * job owns the schema and the queues. The API never has a pg-boss client.
 */
export function createBossOptions(connectionString: string): ConstructorOptions {
  return {
    connectionString,
    schema: 'pgboss',
    migrate: false,
    application_name: 'bantoozi-worker',
    max: 4,
    // Failed jobs stay 30 days in total (spec 11 §5): archived after 23 days, deleted 7 days later.
    archiveFailedAfterSeconds: 23 * 24 * 60 * 60,
    deleteAfterDays: 7,
  };
}

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss(createBossOptions(connectionString));
}

/** The relay's broker: sends with the jobs.ts semantics (singleton keys, debounce). */
export function pgBossBroker(boss: PgBoss): JobBroker {
  return {
    send: (queue, data, singletonKey) =>
      boss.send(queue, data, singletonKey === undefined ? {} : { singletonKey }),
    sendDebounced: (queue, data, seconds, key) => boss.sendDebounced(queue, data, {}, seconds, key),
  };
}

export interface Registration {
  /** Queues with consumers in this process. */
  consuming: QueueName[];
  /** Stub stages among the configured queues: not consumed, their jobs stay pending. */
  unavailable: QueueName[];
}

/**
 * Register `concurrency` consumers (batch size 1, each awaited before acknowledgement) for every
 * implemented stage among `queues`. Invalid payloads are dropped with an error log, never retried
 * (spec 03 §2). Stub stages get no consumer, so dispatch never acknowledges real work.
 */
export async function registerHandlers(
  boss: PgBoss,
  handlers: HandlerMap,
  queues: readonly QueueName[],
  logger: RelayLogger,
): Promise<Registration> {
  const registration: Registration = { consuming: [], unavailable: [] };
  for (const queue of queues) {
    if (!isStageAvailable(handlers, queue)) {
      registration.unavailable.push(queue);
      continue;
    }
    for (let i = 0; i < QUEUES[queue].concurrency; i += 1) {
      await boss.work<unknown>(queue, { batchSize: 1, includeMetadata: true }, async (jobs) => {
        for (const job of jobs) {
          let data = job.data;
          let staleRecoveryRevision: string | undefined;
          if (
            data !== null &&
            typeof data === 'object' &&
            '_staleRecoveryRevision' in data &&
            parseStaleRecoveryRevision(data._staleRecoveryRevision) !== null
          ) {
            const { _staleRecoveryRevision, ...payload } = data;
            staleRecoveryRevision = _staleRecoveryRevision as string;
            data = payload;
          }
          const parsed = safeParseJobPayload(queue, data);
          if (!parsed.success) {
            logger.error({ queue, jobId: job.id }, 'dropping a job with an invalid payload');
            continue;
          }
          await dispatch(handlers, queue, parsed.data, {
            queue,
            jobId: job.id,
            retry: { count: job.retryCount, limit: job.retryLimit },
            ...(staleRecoveryRevision === undefined ? {} : { staleRecoveryRevision }),
          });
        }
      });
    }
    registration.consuming.push(queue);
  }
  return registration;
}
