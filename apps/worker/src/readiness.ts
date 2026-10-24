import { REQUIRED_PG_BOSS_QUEUES, listPgBossQueueNames, type Executor } from '@bantoozi/db';
import type { QueueName } from '@bantoozi/shared';
import type { NodeEnv } from '@bantoozi/shared/server';

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

export const QUEUES_MISSING_KEY = 'queues.missing';

const NAMED_AT_MOST = 10;

/**
 * The queues the migrate job leaves behind and the worker cannot create: every registry queue, then
 * pg-boss's internal cron queue (migration 0017, D-142), without which `boss.schedule` succeeds and
 * no cron ever fires.
 */
export const REQUIRED_QUEUES = REQUIRED_PG_BOSS_QUEUES;

/** The required queues that pg-boss does not hold, in registry order. */
export async function missingRegistryQueues(
  db: Executor,
  queues: readonly string[] = REQUIRED_QUEUES,
): Promise<string[]> {
  const present = new Set(await listPgBossQueueNames(db));
  return queues.filter((name) => !present.has(name));
}

function nameQueues(missing: readonly string[]): string {
  const shown = missing.slice(0, NAMED_AT_MOST).join(', ');
  return missing.length > NAMED_AT_MOST
    ? `${shown} and ${missing.length - NAMED_AT_MOST} more`
    : shown;
}

function missingMessage(missing: readonly string[]): string {
  return `pg-boss queues missing: ${nameQueues(missing)} (${missing.length}) — run the migrate job (pnpm db:migrate, or the deploy's migration step); the worker never creates queues`;
}

export interface QueueReadiness {
  missing(): string[];
  problems(): { key: string; message: string; missingQueues: string[] }[];
  refresh(): Promise<void>;
  reportMissing(queue: string): void;
  stop(): void;
}

export interface QueueReadinessLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Reports missing queues in logs and heartbeat problems. Retry missing or unreadable catalogs every
 * 30 seconds; keep checking healthy catalogs every 10 minutes so later deletions are detected.
 * A timer or manual refresh shares an in-flight read; unreadable warnings mark state changes only.
 */
export async function startQueueReadiness(options: {
  db: Executor;
  logger: QueueReadinessLogger;
  intervalMs?: number;
  queues?: readonly string[];
}): Promise<QueueReadiness> {
  let missing: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let unreadable = false;
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inFlight = (async () => {
      let now: string[];
      try {
        now = await missingRegistryQueues(options.db, options.queues);
      } catch (error) {
        if (stopped) return;
        if (!unreadable) {
          options.logger.warn(
            { err: error },
            'pg-boss queues could not be read: queue readiness unknown',
          );
        }
        unreadable = true;
        return;
      }
      if (stopped) return;
      unreadable = false;
      const previous = new Set(missing);
      const added = now.filter((name) => !previous.has(name));
      missing = now;
      if (now.length > 0 && added.length > 0) {
        options.logger.error({ missing: now }, missingMessage(now));
      } else if (now.length === 0 && previous.size > 0) {
        options.logger.info({}, 'pg-boss queues are present again');
      }
    })().finally(() => {
      inFlight = undefined;
      if (!stopped) {
        const delay = unreadable || missing.length > 0 ? (options.intervalMs ?? 30_000) : 600_000;
        timer = setTimeout(() => void refresh(), delay);
        timer.unref();
      }
    });
    return inFlight;
  };
  await refresh();
  return {
    missing: () => [...missing],
    problems: () =>
      missing.length === 0
        ? []
        : [
            {
              key: QUEUES_MISSING_KEY,
              message: missingMessage(missing),
              missingQueues: [...missing],
            },
          ],
    refresh,
    reportMissing(queue) {
      if (stopped || missing.includes(queue)) return;
      missing = [...missing, queue];
      options.logger.error({ missing }, missingMessage(missing));
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), options.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
