import type { Database, Transaction } from '@bantoozi/db';
import {
  createRobotsChecker,
  safeFetch,
  type ExtractDeps,
  type FetchPurpose,
  type Resolver,
  type RobotsChecker,
  type SafeFetchResult,
} from '@bantoozi/feeds';
import type { JobSender, OriginLimiter, SettingEnvDefaults } from '@bantoozi/shared';
import type pg from 'pg';

import { createPipelineGate } from '../gate.js';
import type { PipelineContext } from '../pipeline.js';

/** The safe client's limits from the worker config (spec 01 §3, spec 03 §4). */
export interface FetchSettings {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /** FETCH_ALLOW_PRIVATE: tests and E2E only; refused in production by config validation. */
  allowPrivate: boolean;
}

/** The structured logger subset handlers use (pino in production). */
export interface HandlerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Everything the M1 ingestion handlers need; built once per worker process. */
export interface WorkerDeps {
  db: Database;
  /**
   * A separate worker-role pool for the per-feed fetch locks (spec 03 §3): each fetch pins one
   * connection for its whole duration, so they never compete with the item transactions of `db`.
   * Size it to the `feed.fetch` concurrency.
   */
  lockPool: pg.Pool;
  fetch: FetchSettings;
  /** INGEST_MAX_AGE_DAYS: older publications are stored as `stale`. */
  ingestMaxAgeDays: number;
  /** Env fallbacks of settings (language modes, …). */
  settingsEnv: SettingEnvDefaults;
  /** The shared per-origin politeness limiter (PostgreSQL in production). */
  limiter: OriginLimiter;
  /** Process-wide robots.txt cache (spec 03 §8.1 step 2). */
  robots: RobotsChecker;
  logger: HandlerLogger;
  /** Test seams: DNS and the clock. */
  resolver?: Resolver;
  now?: () => Date;
}

export type WorkerDepsInput = Omit<WorkerDeps, 'robots'> & { robots?: RobotsChecker };

/** Build the dependencies, creating the robots cache over the same safe client when not given. */
export function createWorkerDeps(input: WorkerDepsInput): WorkerDeps {
  const deps = { ...input } as WorkerDeps;
  const now = input.now;
  deps.robots =
    input.robots ??
    createRobotsChecker({
      fetch: (url) => fetchWith(deps, url, { purpose: 'robots' }),
      ...(now === undefined ? {} : { now: () => now().getTime() }),
    });
  return deps;
}

/** safeFetch with the worker's limits, limiter and test seams. */
export function fetchWith(
  deps: WorkerDeps,
  url: string,
  options: {
    purpose: FetchPurpose;
    userAgent?: string;
    conditional?: { etag?: string | null; lastModified?: string | null };
    beforeRequest?: (url: URL, hop: number) => Promise<true | { code: string; message: string }>;
    /** What remains of a caller's shared deadline (discovery); never above FETCH_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Redirect hops left in a caller's request budget (discovery). */
    maxRedirects?: number;
    signal?: AbortSignal;
  },
): Promise<SafeFetchResult> {
  const now = deps.now;
  return safeFetch(url, {
    purpose: options.purpose,
    userAgent: options.userAgent ?? deps.fetch.userAgent,
    timeoutMs: Math.min(options.timeoutMs ?? deps.fetch.timeoutMs, deps.fetch.timeoutMs),
    maxBytes: deps.fetch.maxBytes,
    allowPrivate: deps.fetch.allowPrivate,
    limiter: deps.limiter,
    ...(options.conditional === undefined ? {} : { conditional: options.conditional }),
    ...(options.beforeRequest === undefined ? {} : { beforeRequest: options.beforeRequest }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }),
    ...(now === undefined ? {} : { now: () => now().getTime() }),
  });
}

/** The page fetch and robots policy extraction uses (spec 03 §8.1). */
export function extractDeps(deps: WorkerDeps): ExtractDeps {
  const now = deps.now;
  return {
    fetch: (url, options) => fetchWith(deps, url, options),
    robots: deps.robots,
    ...(now === undefined ? {} : { now: () => now().getTime() }),
  };
}

/** A transaction's pipeline context: its outbox writer and the database gate. */
export function pipelineContext(
  deps: WorkerDeps,
  tx: Transaction,
  sender: JobSender,
): PipelineContext {
  return { sender, gate: createPipelineGate(tx, deps.settingsEnv) };
}

export function nowOf(deps: WorkerDeps): Date {
  return deps.now?.() ?? new Date();
}
