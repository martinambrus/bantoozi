import { createHash } from 'node:crypto';

import {
  createRuntimeSettingsCache,
  readStoredSetting,
  runtimeSettingsLoader,
  type Database,
  type Executor,
  type RuntimeSettingsCache,
} from '@bantoozi/db';
import { OLLAMA_PRICE_TABLE } from '@bantoozi/engine';
import {
  canonicalJson,
  isConcreteJevModel,
  isModelAlias,
  EngineModelPinSchema,
  type EngineModelProbe,
  type RuntimeSettingsSnapshot,
  type RuntimeSettingsValues,
} from '@bantoozi/shared';
import type { Config } from '@bantoozi/shared/server';

import {
  createWorkerModels,
  type WorkerModelConfig,
  type WorkerModels,
} from './classification-deps.js';
import { credentialResolverFromConfig } from './credentials/resolver.js';
import { createWorkerEngineRouter } from './engine-router.js';
import { createModelProber, recordModelProbe } from './model-probe.js';
import { recordModelPin } from './model-pin.js';
import {
  MODEL_WATCH_TRIGGER_GAP_MS,
  enqueueModelWatchNow,
  requestModelWatch,
} from './model-watch.js';
import {
  MODEL_RESOLVE_RETRY_MS,
  MODEL_RESOLVE_TIMEOUT_MS,
  recordModelResolution,
  type ModelState,
} from './model-resolution.js';

/**
 * The worker's runtime values (M8b-T5, PLAN §14.2). Live-class values (price, concurrency, fetch
 * limits, ingest age, prefilter minimum) apply from the settings cache without a restart. The
 * restart class (Jev model, base URLs, fallback, Ollama models and concurrency, LibreTranslate URL)
 * builds long-lived objects, so a change makes the process drain and exit; its supervisor restarts it
 * and the new process builds from the new values and records the pin.
 */

export type WorkerRuntimeConfig = WorkerModelConfig &
  Pick<
    Config,
    | 'providerHostAllowlist'
    | 'prefilterMinCards'
    | 'autoAnalysisDailyCap'
    | 'ingestMaxAgeDays'
    | 'fetchTimeoutMs'
    | 'fetchMaxBytes'
    | 'rateLimitsEnabled'
  >;

/** The configuration fields the effective runtime values replace. */
export type EffectiveFields = Pick<
  Config,
  | 'typesafeModel'
  | 'typesafeBaseUrl'
  | 'typesafePricePerMtokUsd'
  | 'engineConcurrency'
  | 'llmFallbackEnabled'
  | 'ollamaModelFast'
  | 'ollamaModelStrong'
  | 'ollamaBaseUrl'
  | 'ollamaMaxConcurrency'
>;

export interface RuntimeLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The hash of exactly the restart-class values; every other field is ignored. */
export function restartFingerprint(values: RuntimeSettingsValues): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        typesafeModel: values.typesafeModel,
        typesafeBaseUrl: values.typesafeBaseUrl,
        llmFallbackEnabled: values.llmFallbackEnabled,
        ollamaModels: { fast: values.ollamaModels.fast, strong: values.ollamaModels.strong },
        ollamaBaseUrl: values.ollamaBaseUrl,
        ollamaMaxConcurrency: values.ollamaMaxConcurrency,
        libretranslateUrl: values.libretranslateUrl,
        ...(isModelAlias(values.typesafeModel)
          ? { typesafeResolvedModel: values.typesafeResolvedModel }
          : {}),
      }),
    )
    .digest('hex');
}

/** A type alias (not an interface) so it stays comparable to a loosely typed options record. */
export type WorkerRuntimeOptions = {
  db: Database;
  config: WorkerRuntimeConfig;
  logger: RuntimeLogger;
  /** Ends the process (the supervisor restarts it). */
  exit(code: number): void;
  /** The graceful shutdown that precedes the exit. */
  drain?(): Promise<void>;
  /** Default true; effective only in production. */
  selfRestart?: boolean;
  /** Default true; false leaves the pin and the outbox alone (eval ingest-only). */
  recordPin?: boolean;
  now?: () => Date;
  /** Replaces the real model prober at start and in retries (tests). */
  modelProbe?: (requested: string, signal: AbortSignal) => Promise<EngineModelProbe>;
  /** One deadline for the whole start probe. */
  resolveTimeoutMs?: number;
  /** The wait between probes while `jev-latest` is unresolved. */
  resolveRetryMs?: number;
};

export interface HeartbeatRuntime {
  fingerprint: string;
  model: string;
  llm: { fast: string; strong: string } | null;
  pendingRestart: boolean;
  problems: { key: string; message: string }[];
  keyring: { status: 'ok' | 'missing' | 'malformed' | 'active_key_missing'; activeKeyId?: string };
  defaults: Record<string, unknown>;
}

export interface WorkerRuntime {
  /** The live-applying settings cache (price and engine concurrency are applied on each fresh read). */
  settings: RuntimeSettingsCache;
  models: WorkerModels;
  /** The values the process was built from. */
  values: RuntimeSettingsValues;
  processModel: string;
  modelState: ModelState;
  fingerprint: string;
  check(): Promise<{ pendingRestart: boolean; exiting: boolean }>;
  heartbeatRuntime(): HeartbeatRuntime;
  close(): Promise<void>;
}

/** The environment value of each worker-side runtime key, for `runtime.defaults`. */
function envDefaults(config: WorkerRuntimeConfig): Record<string, unknown> {
  return {
    'engine.typesafe_model': config.typesafeModel,
    'engine.typesafe_base_url': config.typesafeBaseUrl,
    'engine.typesafe_price_per_mtok_usd': config.typesafePricePerMtokUsd,
    'engine.concurrency': config.engineConcurrency,
    'engine.llm_fallback_enabled': config.llmFallbackEnabled,
    'engine.ollama_models': { fast: config.ollamaModelFast, strong: config.ollamaModelStrong },
    'engine.ollama_base_url': config.ollamaBaseUrl,
    'engine.ollama_max_concurrency': config.ollamaMaxConcurrency,
    'engine.prefilter_min_cards': config.prefilterMinCards,
    'engine.auto_analysis_daily_cap': config.autoAnalysisDailyCap,
    'ingest.max_age_days': config.ingestMaxAgeDays,
    'fetch.limits': { timeoutMs: config.fetchTimeoutMs, maxBytes: config.fetchMaxBytes },
    'translate.libretranslate_url': config.libretranslateUrl,
  };
}

/** The settings cache of a process: stored rows over the environment values. */
export function createWorkerSettingsCache(
  db: Executor,
  config: WorkerRuntimeConfig,
): RuntimeSettingsCache {
  return createRuntimeSettingsCache({
    load: runtimeSettingsLoader(db),
    env: {
      typesafeModel: config.typesafeModel,
      typesafeBaseUrl: config.typesafeBaseUrl,
      typesafePricePerMtokUsd: config.typesafePricePerMtokUsd,
      engineConcurrency: config.engineConcurrency,
      llmFallbackEnabled: config.llmFallbackEnabled,
      ollamaModelFast: config.ollamaModelFast,
      ollamaModelStrong: config.ollamaModelStrong,
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaMaxConcurrency: config.ollamaMaxConcurrency,
      prefilterMinCards: config.prefilterMinCards,
      autoAnalysisDailyCap: config.autoAnalysisDailyCap,
      ingestMaxAgeDays: config.ingestMaxAgeDays,
      fetchTimeoutMs: config.fetchTimeoutMs,
      fetchMaxBytes: config.fetchMaxBytes,
      rateLimitsEnabled: config.rateLimitsEnabled,
      libretranslateUrl: config.libretranslateUrl,
    },
    context: {
      production: config.nodeEnv === 'production',
      providerHostAllowlist: config.providerHostAllowlist,
      ollamaPricedModels: Object.keys(OLLAMA_PRICE_TABLE),
    },
  });
}

/** The configuration with the effective runtime values laid over the environment's. */
export function withEffectiveValues<T extends EffectiveFields>(
  config: T,
  values: RuntimeSettingsValues,
): T {
  return {
    ...config,
    typesafeModel: values.typesafeModel,
    typesafeResolvedModel: values.typesafeResolvedModel,
    typesafeBaseUrl: values.typesafeBaseUrl,
    typesafePricePerMtokUsd: values.typesafePricePerMtokUsd,
    engineConcurrency: values.engineConcurrency,
    llmFallbackEnabled: values.llmFallbackEnabled,
    ollamaModelFast: values.ollamaModels.fast,
    ollamaModelStrong: values.ollamaModels.strong,
    ollamaBaseUrl: values.ollamaBaseUrl,
    ollamaMaxConcurrency: values.ollamaMaxConcurrency,
    ...('libretranslateUrl' in config ? { libretranslateUrl: values.libretranslateUrl } : {}),
  };
}

/** One read of the effective values (the seed and the credentials CLI). */
export async function loadEffectiveValues(
  db: Database,
  config: WorkerRuntimeConfig,
): Promise<RuntimeSettingsValues> {
  return (await createWorkerSettingsCache(db, config).get()).values;
}

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

export async function createWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const { db, config, logger } = options;
  const now = options.now ?? (() => new Date());
  const inner = createWorkerSettingsCache(db, config);
  const boot = await inner.get();
  const configured = boot.values.typesafeModel;
  const alias = isModelAlias(configured) ? configured : undefined;
  const liveConfig: { -readonly [K in keyof WorkerRuntimeConfig]: WorkerRuntimeConfig[K] } = {
    ...withEffectiveValues(config, boot.values),
    typesafeResolvedModel: null,
  };
  const resolveTimeoutMs = options.resolveTimeoutMs ?? MODEL_RESOLVE_TIMEOUT_MS;
  const resolveRetryMs = options.resolveRetryMs ?? MODEL_RESOLVE_RETRY_MS;

  async function recordProbe(probe: EngineModelProbe): Promise<void> {
    if (options.recordPin === false) return;
    try {
      await recordModelProbe(db, probe);
    } catch (error) {
      logger.warn(
        { err: error, model: probe.requested },
        'the model probe result could not be recorded',
      );
    }
  }

  /** One bounded probe of the alias; the concrete id it answered, or the reason it did not. */
  async function probeAlias(requested: string): Promise<{ model: string } | { reason: string }> {
    const signal = AbortSignal.timeout(resolveTimeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    let result: EngineModelProbe | undefined;
    let thrown = 'probe_failed';
    try {
      const probe =
        options.modelProbe ??
        ((model: string, probeSignal: AbortSignal) => {
          const credentials = credentialResolverFromConfig(db, liveConfig, SILENT_LOGGER);
          const ledger = createWorkerEngineRouter({
            db,
            config: liveConfig,
            credentials,
            logger: SILENT_LOGGER,
          });
          return createModelProber({
            ledger,
            credentials,
            config: liveConfig,
            logger,
            now,
          }).probe(model, { signal: probeSignal });
        });
      result = await Promise.race([probe(requested, signal), deadline]);
    } catch (error) {
      thrown = error instanceof Error ? error.message : 'probe_failed';
    }
    await recordProbe(
      result ?? {
        requested,
        ok: false,
        at: now().toISOString(),
        error: signal.aborted ? 'timeout' : 'internal_error',
      },
    );
    if (result?.ok && result.answered !== undefined && isConcreteJevModel(result.answered)) {
      return { model: result.answered };
    }
    return { reason: result === undefined ? thrown : (result.error ?? 'not_concrete') };
  }

  let modelState: ModelState;
  let lastAttempt = now().getTime();
  let values = boot.values;
  if (alias === undefined) {
    modelState = { kind: 'concrete', model: configured };
  } else if (boot.values.typesafeResolvedModel !== null) {
    modelState = {
      kind: 'resolved',
      alias,
      model: boot.values.typesafeResolvedModel,
      source: 'stored',
    };
  } else if (options.recordPin === false) {
    modelState = { kind: 'unresolved', alias, reason: 'not_resolved' };
  } else {
    const probed = await probeAlias(alias);
    lastAttempt = now().getTime();
    if ('model' in probed) {
      await recordModelResolution(db, { alias, model: probed.model, now: now() });
      modelState = { kind: 'resolved', alias, model: probed.model, source: 'probed' };
    } else {
      logger.warn({ alias, code: probed.reason }, 'the model alias could not be resolved');
      modelState = { kind: 'unresolved', alias, reason: probed.reason };
    }
  }
  if (modelState.kind === 'resolved') {
    values = { ...values, typesafeResolvedModel: modelState.model };
    liveConfig.typesafeResolvedModel = modelState.model;
  }

  let processModel: string;
  if (modelState.kind === 'concrete' || modelState.kind === 'resolved') {
    processModel = modelState.model;
  } else {
    const stored = EngineModelPinSchema.safeParse(await readStoredSetting(db, 'engine.model_pin'));
    processModel = stored.success ? stored.data.model : modelState.alias;
  }
  let lastClaimMs: number | undefined;
  const onModelUnavailable =
    modelState.kind === 'resolved' && options.recordPin !== false
      ? async (): Promise<void> => {
          const at = now();
          if (
            lastClaimMs !== undefined &&
            at.getTime() - lastClaimMs < MODEL_WATCH_TRIGGER_GAP_MS
          ) {
            return;
          }
          if (await requestModelWatch(db, at)) lastClaimMs = at.getTime();
        }
      : undefined;
  const models = createWorkerModels(db, liveConfig, logger, {
    primaryModel: processModel,
    ...(onModelUnavailable === undefined ? {} : { onModelUnavailable }),
  });
  const fingerprint = restartFingerprint(values);

  let latest: RuntimeSettingsSnapshot = boot;
  let applied: RuntimeSettingsSnapshot | undefined;
  const settings: RuntimeSettingsCache = {
    async get() {
      const snapshot = await inner.get();
      latest = snapshot;
      if (snapshot !== applied) {
        applied = snapshot;
        liveConfig.typesafePricePerMtokUsd = snapshot.values.typesafePricePerMtokUsd;
        try {
          models.classification.router.reconfigure({
            concurrency: snapshot.values.engineConcurrency,
          });
        } catch (error) {
          logger.warn({ err: error }, 'engine concurrency setting could not be applied');
        }
      }
      return snapshot;
    },
    invalidate: () => inner.invalidate(),
  };
  applied = boot;

  const processPin = {
    model: processModel,
    ...(modelState.kind === 'resolved' ? { alias: modelState.alias } : {}),
    ...(values.llmFallbackEnabled ? { llm: { ...values.ollamaModels } } : {}),
  };
  // The stale-worker guard re-reads the settings on every classification job (one query, never the
  // 10 s cache), so a restart-class change fences the job at once, not up to a tick later.
  const guardCache = createWorkerSettingsCache(db, config);
  models.classification.currentness = {
    fingerprint,
    pin: processPin,
    async restartFingerprint(executor) {
      // Inside a completion transaction the values are read through it (under its share locks).
      const cache =
        executor === undefined ? guardCache : createWorkerSettingsCache(executor, config);
      cache.invalidate();
      return restartFingerprint((await cache.get()).values);
    },
  };

  if (options.recordPin !== false && modelState.kind !== 'unresolved') {
    const pin = await recordModelPin(db, processPin, now());
    if (pin.changed)
      logger.info({}, 'engine model pin changed: re-enrichment and re-matching enqueued');
    if (modelState.kind === 'resolved' && modelState.source === 'stored') {
      await enqueueModelWatchNow(db);
    }
  }

  let pendingRestart = false;
  let exiting = false;
  let warnedFor: string | undefined;
  let retrying = false;
  let closed = false;
  const selfRestart = config.nodeEnv === 'production' && options.selfRestart !== false;

  async function retryResolution(): Promise<void> {
    if (
      modelState.kind !== 'unresolved' ||
      options.recordPin === false ||
      retrying ||
      exiting ||
      closed ||
      now().getTime() - lastAttempt < resolveRetryMs
    ) {
      return;
    }
    retrying = true;
    try {
      lastAttempt = now().getTime();
      const probed = await probeAlias(modelState.alias);
      if ('model' in probed && !closed) {
        await recordModelResolution(db, {
          alias: modelState.alias,
          model: probed.model,
          now: now(),
        });
      }
    } catch (error) {
      logger.warn({ err: error }, 'the model alias retry failed');
    } finally {
      retrying = false;
    }
  }

  async function check(): Promise<{ pendingRestart: boolean; exiting: boolean }> {
    await retryResolution();
    inner.invalidate();
    const snapshot = await settings.get();
    const effective = restartFingerprint(snapshot.values);
    pendingRestart = effective !== fingerprint;
    if (pendingRestart && selfRestart) {
      if (!exiting) {
        exiting = true;
        logger.warn(
          { pendingRestart: true },
          'restart-class setting changed: draining and exiting',
        );
        try {
          await options.drain?.();
        } catch (error) {
          logger.error({ err: error }, 'drain before the restart failed');
        }
        options.exit(0);
      }
    } else if (pendingRestart && warnedFor !== effective) {
      warnedFor = effective;
      logger.warn(
        { pendingRestart: true },
        'restart-class setting changed: restart this worker to apply it',
      );
    }
    return { pendingRestart, exiting };
  }

  function keyringReport(): HeartbeatRuntime['keyring'] {
    const state = models.credentials.keyring();
    return state.ok ? { status: 'ok', activeKeyId: state.activeKeyId } : { status: state.reason };
  }

  return {
    settings,
    models,
    values,
    processModel,
    modelState,
    fingerprint,
    check,
    heartbeatRuntime: () => ({
      fingerprint,
      model: processModel,
      llm: values.llmFallbackEnabled ? { ...values.ollamaModels } : null,
      pendingRestart,
      problems: [
        ...latest.problems.map((p) => ({ key: p.key, message: p.message })),
        ...(modelState.kind === 'unresolved'
          ? [
              {
                key: 'engine.typesafe_model',
                message: `${modelState.alias} is not resolved to a model yet; classification is paused`,
              },
            ]
          : []),
      ],
      keyring: keyringReport(),
      defaults: envDefaults(config),
    }),
    close: () => {
      closed = true;
      return models.close();
    },
  };
}
