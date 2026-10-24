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
  problems(): { key: string; message: string }[];
  refresh(): Promise<void>;
  stop(): void;
}

export interface QueueReadinessLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Reports registry queues missing from pg-boss: an error log and a heartbeat problem while any is
 * missing, re-checked every `intervalMs` until they appear. An unreadable table is unknown, not missing.
 */
export async function startQueueReadiness(options: {
  db: Executor;
  logger: QueueReadinessLogger;
  intervalMs?: number;
  queues?: readonly string[];
}): Promise<QueueReadiness> {
  let missing: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const refresh = async (): Promise<void> => {
    let now: string[];
    try {
      now = await missingRegistryQueues(options.db, options.queues);
    } catch (error) {
      options.logger.warn(
        { err: error },
        'pg-boss queues could not be read: queue readiness unknown',
      );
      return;
    }
    const previous = new Set(missing);
    const added = now.filter((name) => !previous.has(name));
    missing = now;
    if (now.length > 0 && added.length > 0) {
      options.logger.error({ missing: now }, missingMessage(now));
    } else if (now.length === 0 && previous.size > 0) {
      options.logger.info({}, 'pg-boss queues are present again');
    }
    if (now.length > 0 && timer === undefined) {
      timer = setInterval(() => void refresh(), options.intervalMs ?? 30_000);
      timer.unref();
    } else if (now.length === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  await refresh();
  return {
    missing: () => [...missing],
    problems: () =>
      missing.length === 0 ? [] : [{ key: QUEUES_MISSING_KEY, message: missingMessage(missing) }],
    refresh,
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
