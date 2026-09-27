import type { Database } from '@bantoozi/db';
import type { EngineLogger } from '@bantoozi/engine';
import type { Config } from '@bantoozi/shared/server';
import {
  createLibreTranslateClient,
  createOllamaTranslator,
  createSupportedSourcesCache,
} from '@bantoozi/translate';

import {
  credentialResolverFromConfig,
  type WorkerCredentialResolver,
} from './credentials/resolver.js';
import { createWorkerEngineRouter, type WorkerEngineConfig } from './engine-router.js';
import type { ClassificationDeps, WorkerDeps } from './handlers/deps.js';

/**
 * The M2 model dependencies of a worker process: one engine router over the PostgreSQL store and
 * the server-only credential resolver, shared by the classification stages, the translators and
 * `provider.validate` (spec 04 §1, spec 07 §2).
 */

/** A handler's deadline for one router call (spec 04 §4): a longer `Retry-After` defers the work. */
export const CLASSIFICATION_CALL_DEADLINE_MS = 5 * 60_000;
/**
 * Lease of claimed match rows and analysis requests: outlasts one router call (the deadline plus
 * the final attempt's timeout, at most 60 s for the LLM fallback) with a margin.
 */
export const CLASSIFICATION_LEASE_MS = 10 * 60_000;
/**
 * A match or analysis job starts no further call after this long: its wall time stays below the
 * budget plus one call, inside the queues' `expireInSeconds` (spec 03 §2.1).
 */
export const CLASSIFICATION_JOB_BUDGET_MS = 10 * 60_000;

export type WorkerModelConfig = WorkerEngineConfig &
  Pick<
    Config,
    | 'libretranslateUrl'
    | 'providerMasterKeyId'
    | 'providerMasterKeys'
    | 'typesafeApiKey'
    | 'ollamaApiKey'
  >;

export interface WorkerModels {
  classification: ClassificationDeps;
  providerValidation: NonNullable<WorkerDeps['providerValidation']>;
  credentials: WorkerCredentialResolver;
  /** Closes the translators' own connection pools. */
  close(): Promise<void>;
}

export function createWorkerModels(
  db: Database,
  config: WorkerModelConfig,
  logger: EngineLogger,
): WorkerModels {
  const credentials = credentialResolverFromConfig(db, config, logger);
  const router = createWorkerEngineRouter({ db, config, credentials, logger });
  const libretranslate = createLibreTranslateClient({ baseUrl: config.libretranslateUrl });
  const ollama = createOllamaTranslator({
    baseUrl: config.ollamaBaseUrl,
    maxConnections: config.ollamaMaxConcurrency,
  });
  return {
    credentials,
    classification: {
      router,
      primaryModel: config.typesafeModel,
      leaseMs: CLASSIFICATION_LEASE_MS,
      callDeadlineMs: CLASSIFICATION_CALL_DEADLINE_MS,
      jobBudgetMs: CLASSIFICATION_JOB_BUDGET_MS,
      translation: {
        libretranslate,
        ollama,
        credentials,
        modelFast: config.ollamaModelFast,
        modelStrong: config.ollamaModelStrong,
        supportedSources: createSupportedSourcesCache(libretranslate),
      },
    },
    providerValidation: { router, credentials, config },
    async close() {
      await Promise.all([libretranslate.close(), ollama.close()]);
    },
  };
}
