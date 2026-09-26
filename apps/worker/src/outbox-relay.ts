import {
  claimOutboxIntents,
  completeOutboxIntent,
  failOutboxIntent,
  hasPendingEquivalentJob,
  oldestPendingOutboxAgeSeconds,
  outboxRetryDelaySeconds,
  type ClaimedIntent,
  type Database,
} from '@bantoozi/db';
import { isQueueName, safeParseJobPayload, sendSpecFor } from '@bantoozi/shared';

import { isStageAvailable, type HandlerMap } from './handlers/index.js';

/**
 * The durable outbox relay (spec 02 §3.2, spec 03 §2.1). Each pass claims at most `batchSize` due
 * intents under a fresh lease (committed before any send), sends each through the typed pg-boss
 * semantics of jobs.ts, and marks it delivered only with its own lease token. Nothing is ever
 * discarded: a failed send, a stub stage (`stage_unavailable`) or an unproven singleton conflict
 * keeps the intent with a retry time; a crash after send replays it (consumers are idempotent).
 */

/** The broker operations the relay needs (pg-boss in production). */
export interface JobBroker {
  send(queue: string, data: object, singletonKey: string | undefined): Promise<string | null>;
  sendDebounced(queue: string, data: object, seconds: number, key: string): Promise<string | null>;
}

export interface RelayLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayOptions {
  handlers: HandlerMap;
  batchSize?: number;
  leaseSeconds?: number;
  /** Retry delay of intents whose stage is still a stub. */
  unavailableRetrySeconds?: number;
  logger?: RelayLogger;
}

export interface RelayReport {
  claimed: number;
  delivered: number;
  /** Kept for later: stub stage or unproven singleton conflict. */
  retained: number;
  /** Kept after an error (send failure, invalid intent). */
  failed: number;
  /** Lease lost to another relay before completion (it owns the intent now). */
  lost: number;
}

const INVALID_INTENT_RETRY_SECONDS = 3600;
const CONFLICT_RETRY_SECONDS = 5;

type Outcome = 'delivered' | 'retained' | 'failed' | 'lost';

export async function relayOnce(
  db: Database,
  broker: JobBroker,
  options: RelayOptions,
): Promise<RelayReport> {
  const claimed = await claimOutboxIntents(db, {
    limit: options.batchSize ?? 100,
    leaseSeconds: options.leaseSeconds ?? 60,
  });
  const report: RelayReport = {
    claimed: claimed.length,
    delivered: 0,
    retained: 0,
    failed: 0,
    lost: 0,
  };
  for (const intent of claimed) {
    const outcome = await relayIntent(db, broker, intent, options);
    report[outcome] += 1;
  }
  return report;
}

async function relayIntent(
  db: Database,
  broker: JobBroker,
  intent: ClaimedIntent,
  options: RelayOptions,
): Promise<Outcome> {
  const keep = async (outcome: 'retained' | 'failed', error: string, retryInSeconds: number) =>
    (await failOutboxIntent(db, intent, { error, retryInSeconds })) ? outcome : 'lost';
  try {
    if (!isQueueName(intent.queue)) {
      options.logger?.error(
        { intentId: intent.id, queue: intent.queue },
        'outbox intent for an unknown queue',
      );
      return await keep('failed', 'unknown_queue', INVALID_INTENT_RETRY_SECONDS);
    }
    const queue = intent.queue;
    const parsed = safeParseJobPayload(queue, intent.payload);
    if (!parsed.success) {
      options.logger?.error(
        { intentId: intent.id, queue },
        'outbox intent with an invalid payload',
      );
      return await keep('failed', 'invalid_payload', INVALID_INTENT_RETRY_SECONDS);
    }
    if (!isStageAvailable(options.handlers, queue)) {
      return await keep('retained', 'stage_unavailable', options.unavailableRetrySeconds ?? 60);
    }
    const payload = parsed.data as object;
    const spec = sendSpecFor(queue, parsed.data);
    const jobId =
      spec.kind === 'debounced'
        ? await broker.sendDebounced(queue, payload, spec.seconds, spec.key)
        : await broker.send(queue, payload, spec.singletonKey);
    if (jobId === null) {
      const singletonKey = spec.kind === 'debounced' ? spec.key : spec.singletonKey;
      const equivalent =
        singletonKey !== undefined &&
        (await hasPendingEquivalentJob(db, {
          queue,
          singletonKey,
          payload,
          anyPayload: spec.kind === 'debounced',
        }));
      if (!equivalent) return await keep('retained', 'singleton_conflict', CONFLICT_RETRY_SECONDS);
    }
    return (await completeOutboxIntent(db, intent)) ? 'delivered' : 'lost';
  } catch (error) {
    // Redacted: the error class/code only, never a payload or connection string.
    const code =
      error instanceof Error
        ? `${error.name}${'code' in error ? `:${String(error.code)}` : ''}`
        : 'error';
    options.logger?.warn({ intentId: intent.id, queue: intent.queue, code }, 'outbox send failed');
    return keep('failed', code, outboxRetryDelaySeconds(intent.attempts));
  }
}

export interface RelayLoop {
  stop(): Promise<void>;
}

/**
 * Poll at most every `intervalMs` (≤ 1 s) while idle and immediately while a full batch was claimed;
 * warn when an intent has been pending for more than five minutes.
 */
export function startOutboxRelay(
  db: Database,
  broker: JobBroker,
  options: RelayOptions & { intervalMs?: number },
): RelayLoop {
  const intervalMs = Math.min(options.intervalMs ?? 1000, 1000);
  const batchSize = options.batchSize ?? 100;
  let stopped = false;
  let wake: (() => void) | undefined;
  let lastAgeCheck = 0;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const loop = (async () => {
    while (!stopped) {
      let busy = false;
      try {
        const report = await relayOnce(db, broker, options);
        busy = report.claimed === batchSize;
        if (Date.now() - lastAgeCheck > 60_000) {
          lastAgeCheck = Date.now();
          const age = await oldestPendingOutboxAgeSeconds(db);
          if (age !== null && age > 300) {
            options.logger?.warn(
              { oldestPendingSeconds: Math.round(age) },
              'outbox intent pending for more than 5 minutes',
            );
          }
        }
      } catch (error) {
        options.logger?.error({ err: error }, 'outbox relay pass failed');
      }
      if (!stopped && !busy) await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
