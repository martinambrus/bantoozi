import { createPgEngineStore, type Database } from '@bantoozi/db';
import {
  createEngineRouter,
  JEV_FAKE_MODEL,
  type BreakerParams,
  type DecisionEngine,
  type EngineConfig,
  type EngineLogger,
  type EngineName,
  type EngineRouter,
} from '@bantoozi/engine';
import { systemClock, type Clock } from '@bantoozi/shared';
import type { Config, CredentialResolver } from '@bantoozi/shared/server';

/**
 * The worker's engine router (spec 04 §1): the real router over the PostgreSQL engine store (spend
 * ledger, demand rechecks and the shared breaker state in `settings['engine.circuit']`) and the
 * server-only credential resolver. Handlers reach every model only through it.
 */

/** The worker configuration the router reads (spec 01 §3 names). */
export type WorkerEngineConfig = Pick<
  Config,
  | 'nodeEnv'
  | 'typesafeBaseUrl'
  | 'typesafeModel'
  | 'typesafePricePerMtokUsd'
  | 'engineConcurrency'
  | 'dailyBudgetUsd'
  | 'ollamaBaseUrl'
  | 'ollamaModelFast'
  | 'ollamaModelStrong'
  | 'ollamaMaxConcurrency'
  | 'llmFallbackEnabled'
>;

export interface EngineConfigOptions {
  /**
   * This process's static share of the Jev account rate limits, in (0, 1]; the shares of all
   * processes calling Jev must sum to at most 1 (spec 04 §3). Default 1 (one worker).
   */
  rateLimitShare?: number;
}

/**
 * The router configuration of a worker. `TYPESAFE_MODEL=jev-fake` outside production is the
 * explicit test configuration of spec 04 §3 (the fake TypeSafe server, E2E); production config
 * validation already refuses any unpinned model.
 */
export function engineConfigFromWorker(
  config: WorkerEngineConfig,
  options: EngineConfigOptions = {},
): EngineConfig {
  const production = config.nodeEnv === 'production';
  return {
    typesafe: {
      baseUrl: config.typesafeBaseUrl,
      model: config.typesafeModel,
      pricePerMTokUsd: config.typesafePricePerMtokUsd,
      ...(options.rateLimitShare === undefined ? {} : { rateLimitShare: options.rateLimitShare }),
      ...(!production && config.typesafeModel === JEV_FAKE_MODEL ? { allowFakeModel: true } : {}),
    },
    ollama: {
      baseUrl: config.ollamaBaseUrl,
      modelFast: config.ollamaModelFast,
      modelStrong: config.ollamaModelStrong,
      maxConcurrency: config.ollamaMaxConcurrency,
    },
    concurrency: config.engineConcurrency,
    dailyBudgetUsd: config.dailyBudgetUsd,
    llmFallbackEnabled: config.llmFallbackEnabled,
    production,
  };
}

export interface WorkerEngineRouterOptions extends EngineConfigOptions {
  db: Database;
  config: WorkerEngineConfig;
  /** The worker's credential resolver (`credentialResolverFromConfig`). */
  credentials: CredentialResolver;
  logger: EngineLogger;
  clock?: Clock;
  /** Injected engines (tests, E2E, eval dry runs). */
  engines?: Partial<Record<EngineName, DecisionEngine>>;
  /** Retry jitter (tests pass a deterministic one). */
  random?: () => number;
  /** Breaker parameters (tests); the defaults are spec 04 §5's. */
  breakerParams?: Partial<BreakerParams>;
}

/** Compose the production router of a worker process. */
export function createWorkerEngineRouter(options: WorkerEngineRouterOptions): EngineRouter {
  const store = createPgEngineStore(options.db, { dailyBudgetUsd: options.config.dailyBudgetUsd });
  return createEngineRouter({
    config: engineConfigFromWorker(options.config, options),
    store,
    logger: options.logger,
    clock: options.clock ?? systemClock,
    credentials: options.credentials,
    ...(options.engines === undefined ? {} : { engines: options.engines }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.breakerParams === undefined ? {} : { breakerParams: options.breakerParams }),
  });
}
