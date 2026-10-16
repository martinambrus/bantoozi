import { runtimeSettingsLoader, type Database, createRuntimeSettingsCache } from '@bantoozi/db';
import { OLLAMA_PRICES } from '@bantoozi/translate';
import type { RuntimeSettingsSnapshot } from '@bantoozi/shared';

import type { ApiConfig } from '../context.js';

/**
 * The API's live runtime settings (M8b-T3, spec 08 §9): one TTL cache per process over the stored
 * rows, with the environment values as defaults. A PATCH through this process invalidates it.
 */
export function createApiRuntimeSettings(
  db: Database,
  config: ApiConfig,
  options: { ttlMs?: number; now?: () => number } = {},
) {
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
      ollamaPricedModels: Object.keys(OLLAMA_PRICES),
    },
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** The live values, or `null` when the settings cannot be read yet (callers use the env config). */
export async function liveRuntime(services: {
  runtime: { get(): Promise<RuntimeSettingsSnapshot> };
}): Promise<RuntimeSettingsSnapshot['values'] | null> {
  try {
    return (await services.runtime.get()).values;
  } catch {
    return null;
  }
}

/** The Jev model the API assumes without a stored pin: the live setting, else the environment's. */
export async function liveTypesafeModel(services: {
  runtime: { get(): Promise<RuntimeSettingsSnapshot> };
  config: { typesafeModel: string };
}): Promise<string> {
  return (await liveRuntime(services))?.typesafeModel ?? services.config.typesafeModel;
}
