import { randomBytes } from 'node:crypto';

import type { Database } from '@bantoozi/db';
import { buildJobIntent, type EngineModelPin } from '@bantoozi/shared';
import type pg from 'pg';

import type { startHeartbeat } from '../../src/eval-mode.js';
import type { ClassificationDeps } from '../../src/handlers/deps.js';

import { ClassifyHarness, ScriptedRouter } from './classify.js';

/**
 * M8b-T5 ruler world (scope B2 "Class R", PLAN §14.2). The restart class is the set of values that
 * build long-lived objects: model, base URLs, fallback, Ollama models, Ollama concurrency and the
 * LibreTranslate URL. This file pins the seams the implementation must offer; everything the tests
 * import from `src/` that does not exist yet is imported lazily, so a missing module fails each
 * test, not the file.
 *
 * Seams chosen by this ruler (change them here only, never in the tests):
 *
 * `src/runtime.ts` exports
 *   - `restartFingerprint(values: RuntimeSettingsValues): string` — canonicalJson hash of exactly the
 *     seven restart-class values (typesafeModel, typesafeBaseUrl, llmFallbackEnabled, ollamaModels,
 *     ollamaBaseUrl, ollamaMaxConcurrency, libretranslateUrl); every other field is ignored.
 *   - `createWorkerRuntime(options): Promise<WorkerRuntime>`. It is `main.ts`'s startup, minus the
 *     process: reads the effective settings FIRST (stored row, else env, an invalid row ignored),
 *     builds the models (`createWorkerModels`) from them, and (unless `recordPin === false`) records
 *     the pin (`recordModelPin`) from the effective model and fallback. Options:
 *       { db, config: WorkerRuntimeConfig, logger, exit(code), drain?(), selfRestart? (default true),
 *         recordPin? (default true), now? }
 *     Runtime members: `settings` (the live-applying cache), `models` (WorkerModels), `processModel`,
 *     `fingerprint`, `check()`, `heartbeatRuntime()`, `close()`.
 *   - `check()`: ALWAYS reads fresh settings (invalidates the cache first), compares the effective
 *     fingerprint with the one the process booted with. A difference sets pendingRestart. In
 *     production with `selfRestart !== false` it also calls `drain()` and then `exit(0)`, exactly once
 *     per process however often `check()` runs; otherwise it logs `pendingRestart: true` through
 *     `logger.warn(obj, msg)` and never exits. Returns `{ pendingRestart, exiting }`.
 *   - `heartbeatRuntime()`: synchronous, never throws, JSON only, no secrets. Shape:
 *       { fingerprint, model, llm: {fast,strong} | null, pendingRestart, problems: [{key,message}],
 *         keyring: { status: 'ok'|'missing'|'malformed'|'active_key_missing', activeKeyId? },
 *         defaults: { [settingKey]: envValue } }
 *     `defaults` has exactly the twelve worker-side runtime keys (everything but
 *     `api.rate_limits_enabled`), with the environment values (the API shows them as "default from
 *     worker env"); `ollama_models` is `{fast,strong}`, `fetch.limits` is `{timeoutMs,maxBytes}`.
 *   - `StaleWorkerError`-class errors are identified by `name === 'StaleWorkerError'` and
 *     `retryDelaySeconds === 30`. They are thrown by `loadClassificationConfig` callers
 *     (article.enrich, house.reenrich, ...) when `engine.model_pin.model` differs from the process's
 *     `classification.primaryModel`. No pin row: not stale.
 *
 * JEV-2 seams (the `jev-latest` alias): `createWorkerRuntime` also takes
 *   `modelProbe?: (requested: string, signal: AbortSignal) => Promise<EngineModelProbe>` (replaces the
 *   real prober at start and in retries; production tests inject it because the production engine
 *   needs https), `resolveTimeoutMs?` (default 30_000, one deadline for the start probe) and
 *   `resolveRetryMs?` (default 300_000). The runtime gains `modelState` (`concrete` | `resolved` with
 *   source `stored`|`probed` | `unresolved`) and `values` (with `typesafeResolvedModel`). The worker
 *   writes `engine.model_resolution`; `restartFingerprint` also hashes `typesafeResolvedModel` when
 *   the configured model is the alias. `router.status()` has `typesafeLane`.
 *
 * `src/eval-mode.ts`: `HeartbeatOptions.runtime?: () => Record<string, unknown>`; the beat writes its
 * result to the entry's `runtime` field.
 */

export const OLD_MODEL = 'jev-1.13.0';
export const NEW_MODEL = 'jev-1.14.0';
export const LLM = { fast: 'glm-5.3-flash', strong: 'glm-5.3' } as const;

/** The thirteen worker-side runtime setting keys of `runtime.defaults`. */
export const WORKER_DEFAULT_KEYS = [
  'engine.typesafe_model',
  'engine.typesafe_base_url',
  'engine.typesafe_price_per_mtok_usd',
  'engine.concurrency',
  'engine.llm_fallback_enabled',
  'engine.ollama_models',
  'engine.ollama_base_url',
  'engine.ollama_max_concurrency',
  'engine.prefilter_min_cards',
  'engine.auto_analysis_daily_cap',
  'ingest.max_age_days',
  'fetch.limits',
  'translate.libretranslate_url',
] as const;

/** All runtime keys (and the stored alias resolution), cleared between tests. */
export const RUNTIME_KEYS = [
  ...WORKER_DEFAULT_KEYS,
  'api.rate_limits_enabled',
  // JEV-2: the worker-written resolution of the `jev-latest` alias (not an editable runtime key).
  'engine.model_resolution',
  'engine.model_probe',
  'engine.model_impact',
] as const;

export interface WorkerRuntimeConfigLike {
  nodeEnv: 'test' | 'production' | 'development';
  typesafeBaseUrl: string;
  typesafeModel: string;
  typesafePricePerMtokUsd: number;
  engineConcurrency: number;
  dailyBudgetUsd: number;
  languageModes: { en: 'native'; sk: 'native'; cs: 'native' };
  signupMode: 'invite';
  ollamaBaseUrl: string;
  ollamaModelFast: string;
  ollamaModelStrong: string;
  ollamaMaxConcurrency: number;
  llmFallbackEnabled: boolean;
  libretranslateUrl: string;
  providerMasterKeyId: string | undefined;
  providerMasterKeys: string | undefined;
  typesafeApiKey: string | undefined;
  ollamaApiKey: string | undefined;
  providerHostAllowlist: readonly string[];
  prefilterMinCards: number;
  autoAnalysisDailyCap: number;
  ingestMaxAgeDays: number;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  rateLimitsEnabled: boolean;
}

export function keyringJson(...ids: string[]): string {
  return JSON.stringify(
    Object.fromEntries(ids.map((id) => [id, randomBytes(32).toString('base64')])),
  );
}

export function baseConfig(
  nodeEnv: WorkerRuntimeConfigLike['nodeEnv'],
  overrides: Partial<WorkerRuntimeConfigLike> = {},
): WorkerRuntimeConfigLike {
  return {
    nodeEnv,
    typesafeBaseUrl: 'https://api.typesafe.ai',
    typesafeModel: OLD_MODEL,
    typesafePricePerMtokUsd: 0.042,
    engineConcurrency: 8,
    dailyBudgetUsd: 5,
    languageModes: { en: 'native', sk: 'native', cs: 'native' },
    signupMode: 'invite',
    ollamaBaseUrl: 'https://ollama.com',
    ollamaModelFast: LLM.fast,
    ollamaModelStrong: LLM.strong,
    ollamaMaxConcurrency: 1,
    llmFallbackEnabled: false,
    libretranslateUrl: 'http://libretranslate:5000',
    providerMasterKeyId: 'k1',
    providerMasterKeys: keyringJson('k1'),
    typesafeApiKey: undefined,
    ollamaApiKey: undefined,
    providerHostAllowlist: ['api.typesafe.ai', 'ollama.com'],
    prefilterMinCards: 60,
    autoAnalysisDailyCap: 1000,
    ingestMaxAgeDays: 14,
    fetchTimeoutMs: 10_000,
    fetchMaxBytes: 5 * 1024 * 1024,
    rateLimitsEnabled: true,
    ...overrides,
  };
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

export interface Recorder {
  logs: LogEntry[];
  exits: number[];
  /** Order in which `drain` and `exit` were called. */
  calls: string[];
  drains: number;
  logger: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  };
  exit(code: number): void;
  drain(): Promise<void>;
}

export function recorder(): Recorder {
  const r: Recorder = {
    logs: [],
    exits: [],
    calls: [],
    drains: 0,
    logger: {
      info: (obj, msg) => void r.logs.push({ level: 'info', obj: obj as never, msg }),
      warn: (obj, msg) => void r.logs.push({ level: 'warn', obj: obj as never, msg }),
      error: (obj, msg) => void r.logs.push({ level: 'error', obj: obj as never, msg }),
    },
    exit(code) {
      r.exits.push(code);
      r.calls.push('exit');
    },
    async drain() {
      r.drains += 1;
      r.calls.push('drain');
    },
  };
  return r;
}

export interface HeartbeatRuntime {
  fingerprint: string;
  model: string;
  llm: { fast: string; strong: string } | null;
  pendingRestart: boolean;
  problems: { key: string; message: string }[];
  keyring: { status: 'ok' | 'missing' | 'malformed' | 'active_key_missing'; activeKeyId?: string };
  defaults: Record<string, unknown>;
}

export type ModelStateLike =
  | { kind: 'concrete'; model: string }
  | { kind: 'resolved'; alias: string; model: string; source: 'stored' | 'probed' }
  | { kind: 'unresolved'; alias: string; reason: string };

export interface ModelProbeResultLike {
  requested: string;
  answered?: string;
  ok: boolean;
  at: string;
  error?: string;
}

export type ModelProbeSeam = (
  requested: string,
  signal: AbortSignal,
) => Promise<ModelProbeResultLike>;

export interface WorkerRuntimeLike {
  modelState: ModelStateLike;
  values: { typesafeModel: string; typesafeResolvedModel?: string | null };
  settings: { get(): Promise<unknown>; invalidate(): void };
  models: {
    classification: ClassificationDeps;
    close(): Promise<void>;
  };
  processModel: string;
  fingerprint: string;
  check(): Promise<{ pendingRestart: boolean; exiting: boolean }>;
  heartbeatRuntime(): HeartbeatRuntime;
  close(): Promise<void>;
}

export interface StartOptions {
  db: Database;
  config: WorkerRuntimeConfigLike;
  recorder: Recorder;
  selfRestart?: boolean;
  recordPin?: boolean;
  now?: () => Date;
  modelProbe?: ModelProbeSeam;
  resolveTimeoutMs?: number;
  resolveRetryMs?: number;
}

/** `createWorkerRuntime`, imported lazily so a missing module fails each test, not the file. */
export async function startRuntime(options: StartOptions): Promise<WorkerRuntimeLike> {
  const mod = (await import('../../src/runtime.js')) as unknown as {
    createWorkerRuntime: (o: Record<string, unknown>) => Promise<WorkerRuntimeLike>;
  };
  return mod.createWorkerRuntime({
    db: options.db,
    config: options.config,
    logger: options.recorder.logger,
    exit: (code: number) => options.recorder.exit(code),
    drain: () => options.recorder.drain(),
    ...(options.selfRestart === undefined ? {} : { selfRestart: options.selfRestart }),
    ...(options.recordPin === undefined ? {} : { recordPin: options.recordPin }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.modelProbe === undefined ? {} : { modelProbe: options.modelProbe }),
    ...(options.resolveTimeoutMs === undefined
      ? {}
      : { resolveTimeoutMs: options.resolveTimeoutMs }),
    ...(options.resolveRetryMs === undefined ? {} : { resolveRetryMs: options.resolveRetryMs }),
  });
}

export async function callRestartFingerprint(values: unknown): Promise<string> {
  const mod = (await import('../../src/runtime.js')) as {
    restartFingerprint: (v: unknown) => string;
  };
  return mod.restartFingerprint(values);
}

export type Heartbeat = Awaited<ReturnType<typeof startHeartbeat>>;

/** `startHeartbeat` with the runtime seam (`HeartbeatOptions.runtime`). */
export async function heartbeatWith(
  db: Database,
  processId: string,
  runtime: () => Record<string, unknown>,
): Promise<Heartbeat> {
  const mod = await import('../../src/eval-mode.js');
  return mod.startHeartbeat({
    db,
    processId,
    queues: [],
    evalIngestOnly: false,
    envCredentials: [],
    logger: { warn: () => {} },
    onGoldenDatabase: () => {},
    intervalMs: 3_600_000,
    runtime,
  } as never);
}

export async function heartbeatEntry(
  owner: pg.Pool,
  processId: string,
): Promise<{ runtime?: HeartbeatRuntime } | undefined> {
  const result = await owner.query<{ entry: { runtime?: HeartbeatRuntime } | null }>(
    `SELECT value -> $1 AS entry FROM settings WHERE key = 'worker.heartbeat'`,
    [processId],
  );
  return result.rows[0]?.entry ?? undefined;
}

export async function setSetting(owner: pg.Pool, key: string, value: unknown): Promise<void> {
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export interface ResolutionRow {
  alias: string;
  model: string;
  resolvedAt: string;
  checkedAt: string;
  previous?: { model: string; until: string };
}

export async function resolutionRow(owner: pg.Pool): Promise<ResolutionRow | undefined> {
  const result = await owner.query<{ value: ResolutionRow }>(
    `SELECT value FROM settings WHERE key = 'engine.model_resolution'`,
  );
  return result.rows[0]?.value;
}

/** A stored resolution of `jev-latest` (what a previous start probe wrote). */
export async function storeResolution(
  owner: pg.Pool,
  model: string,
  at = '2026-10-10T08:00:00.000Z',
): Promise<ResolutionRow> {
  const row: ResolutionRow = { alias: 'jev-latest', model, resolvedAt: at, checkedAt: at };
  await setSetting(owner, 'engine.model_resolution', row);
  return row;
}

export async function pinRow(owner: pg.Pool): Promise<EngineModelPin | undefined> {
  const result = await owner.query<{ value: EngineModelPin }>(
    `SELECT value FROM settings WHERE key = 'engine.model_pin'`,
  );
  return result.rows[0]?.value;
}

/** A clean slate: no runtime rows, no heartbeat, an empty outbox, the pin at `OLD_MODEL`. */
export async function resetWorld(
  h: ClassifyHarness,
  pin: { model: string; llm?: { fast: string; strong: string } } = { model: OLD_MODEL },
): Promise<void> {
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    [...RUNTIME_KEYS, 'engine.model_pin', 'worker.heartbeat'],
  ]);
  await h.owner.query('DELETE FROM job_outbox');
  await setSetting(h.owner, 'engine.model_pin', { ...pin, since: '2026-10-01T00:00:00.000Z' });
}

/** The rebuild intents of the pin: queue, revision (from the dedupe key) and payload. */
export async function rebuildIntents(
  owner: pg.Pool,
): Promise<{ queue: string; dedupeKey: string | null; payload: unknown }[]> {
  const result = await owner.query<{ queue: string; dedupe_key: string | null; payload: unknown }>(
    `SELECT queue, dedupe_key, payload FROM job_outbox
      WHERE queue IN ('house.reenrich', 'house.rematch') ORDER BY queue, id`,
  );
  return result.rows.map((r) => ({ queue: r.queue, dedupeKey: r.dedupe_key, payload: r.payload }));
}

export const expectedDedupeKey = (queue: 'house.reenrich' | 'house.rematch', since: string) =>
  buildJobIntent(queue, {}, { revision: since }).dedupeKey;

/** A handler map over one worker's own runtime classification deps and a scripted router. */
export function handlersFor(
  h: ClassifyHarness,
  runtime: WorkerRuntimeLike,
  router: ScriptedRouter,
) {
  return h.handlersWith({
    classification: { ...runtime.models.classification, router },
  });
}

export { ClassifyHarness, ScriptedRouter };
