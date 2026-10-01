import {
  isGoldenDatabase,
  recordWorkerHeartbeat,
  removeWorkerHeartbeat,
  type Executor,
} from '@bantoozi/db';
import { parseSetting, type QueueName } from '@bantoozi/shared';

/**
 * The worker's evaluation-collection mode (spec 10 §2.1, D-96) and its heartbeat (spec 02 §2).
 *
 * A golden database (one holding the evaluation user, `eval ingest-sample` creates it) must only be
 * served by ingest-only workers, so collection never spends on Jev and frozen samples are never
 * classified by an ordinary worker. Three layers enforce it: an ingest-only worker consumes only
 * the ingestion queues and its pipeline stops after extraction; an ordinary worker refuses to start
 * on a golden database and stops when one becomes golden under it (checked with every heartbeat);
 * and `ingest-sample` refuses to collect while any live heartbeat is not ingest-only.
 */

/** The queues an ingest-only worker consumes: fetching and extraction, nothing that infers. */
export const INGEST_ONLY_QUEUES: readonly QueueName[] = [
  'feed.schedule',
  'feed.fetch',
  'article.extract',
];

/** Every 30 s (spec 02 §2). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** The configured queues, narrowed to the ingestion queues in ingest-only mode. */
export function effectiveWorkerQueues(
  configured: readonly QueueName[],
  evalIngestOnly: boolean,
): QueueName[] {
  return evalIngestOnly
    ? configured.filter((queue) => INGEST_ONLY_QUEUES.includes(queue))
    : [...configured];
}

export class GoldenDatabaseError extends Error {
  constructor() {
    super(
      'this database is a golden evaluation database (it holds eval@bantoozi.local): only workers ' +
        'with EVAL_INGEST_ONLY=true may serve it (spec 10 §2.1)',
    );
    this.name = 'GoldenDatabaseError';
  }
}

/** Refuse an ordinary worker on a golden database. */
export async function assertWorkerMode(db: Executor, evalIngestOnly: boolean): Promise<void> {
  if (!evalIngestOnly && (await isGoldenDatabase(db))) throw new GoldenDatabaseError();
}

export interface HeartbeatLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HeartbeatOptions {
  db: Executor;
  processId: string;
  queues: readonly QueueName[];
  evalIngestOnly: boolean;
  envCredentials: readonly ('typesafe' | 'ollama')[];
  logger: HeartbeatLogger;
  /**
   * Called once when the database turned golden under an ordinary worker after startup. A golden
   * database at startup is not reported here: `startHeartbeat` rejects with the error instead, so
   * the caller aborts before it holds a heartbeat handle.
   */
  onGoldenDatabase: (error: GoldenDatabaseError) => void;
  intervalMs?: number;
  now?: () => Date;
}

export interface Heartbeat {
  /** One beat: the mode check, then this process's entry. Exposed for tests. */
  beat(): Promise<void>;
  /** Stop beating and remove this process's entry. */
  stop(): Promise<void>;
}

/**
 * Write the first heartbeat now, then every `intervalMs`. Rejects with `GoldenDatabaseError` when an
 * ordinary worker finds a golden database right after that first write (the entry is removed again).
 */
export async function startHeartbeat(options: HeartbeatOptions): Promise<Heartbeat> {
  const now = options.now ?? (() => new Date());
  let violated = false;
  let stopped = false;
  async function beat(): Promise<void> {
    if (!options.evalIngestOnly && !violated && (await isGoldenDatabase(options.db))) {
      violated = true;
      options.onGoldenDatabase(new GoldenDatabaseError());
      return;
    }
    await write();
  }
  async function write(): Promise<void> {
    const at = now();
    const entry = parseSetting('worker.heartbeat', {
      [options.processId]: {
        at: at.toISOString(),
        queues: [...options.queues],
        evalIngestOnly: options.evalIngestOnly,
        envCredentials: [...options.envCredentials],
      },
    })[options.processId];
    if (entry === undefined) throw new Error('heartbeat entry missing after validation');
    await recordWorkerHeartbeat(options.db, options.processId, entry, at);
  }
  // Write first, then check: `ingest-sample` creates the evaluation user first and then reads
  // heartbeats, so of two that start together at least one sees the other (D-96).
  await write();
  if (!options.evalIngestOnly && (await isGoldenDatabase(options.db))) {
    await removeWorkerHeartbeat(options.db, options.processId).catch((err: unknown) =>
      options.logger.warn({ err }, 'removing the worker heartbeat failed'),
    );
    throw new GoldenDatabaseError();
  }
  const timer = setInterval(() => {
    if (stopped) return;
    beat().catch((err: unknown) => options.logger.warn({ err }, 'worker heartbeat failed'));
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    beat,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await removeWorkerHeartbeat(options.db, options.processId).catch((err: unknown) =>
        options.logger.warn({ err }, 'removing the worker heartbeat failed'),
      );
    },
  };
}
