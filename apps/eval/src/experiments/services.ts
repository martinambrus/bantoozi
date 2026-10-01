import { createPgEngineStore, type Database } from '@bantoozi/db';
import {
  createEngineRouter,
  createMemoryCircuitStore,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  JEV_FAKE_MODEL,
  type DecisionEngine,
  type EngineConfig,
  type EngineLogger,
  type EngineName,
  type EngineRouter,
} from '@bantoozi/engine';
import { newUuid, systemClock, type Clock } from '@bantoozi/shared';
import type { CredentialResolver, ProcessConfig } from '@bantoozi/shared/server';
import {
  createLibreTranslateClient,
  createOllamaTranslator,
  type LibreTranslateClient,
  type OllamaTranslator,
} from '@bantoozi/translate';

import { createEvalCredentialResolver } from './credentials.js';

/**
 * What one `eval run`/`eval replay` invocation talks to (spec 10 §3): its own eval `EngineRouter`
 * (spec 04 §1 "Eval routers") and the production translation clients. Tests and the dry run
 * (M3a-T8) inject fakes through {@link EvalServiceOverrides}; nothing here reaches a provider on
 * its own.
 */

/** Injection points (tests, the dry run): engines, clients, credentials, randomness. */
export interface EvalServiceOverrides {
  engines?: Partial<Record<EngineName, DecisionEngine>>;
  credentials?: CredentialResolver;
  libretranslate?: LibreTranslateClient;
  ollama?: OllamaTranslator;
  /** Retry jitter of the router (deterministic in tests). */
  random?: () => number;
  clock?: Clock;
}

/** The eval process configuration the services read (spec 01 §3 names). */
export type EvalServiceConfig = Pick<
  ProcessConfig<'eval'>,
  | 'nodeEnv'
  | 'typesafeBaseUrl'
  | 'typesafeModel'
  | 'typesafePricePerMtokUsd'
  | 'typesafeApiKey'
  | 'engineConcurrency'
  | 'dailyBudgetUsd'
  | 'ollamaBaseUrl'
  | 'ollamaModelFast'
  | 'ollamaModelStrong'
  | 'ollamaMaxConcurrency'
  | 'ollamaApiKey'
  | 'providerMasterKeyId'
  | 'providerMasterKeys'
  | 'libretranslateUrl'
>;

export interface EvalRouterOptions {
  db: Database;
  config: EvalServiceConfig;
  logger: EngineLogger;
  /** `--max-usd`: the invocation cap (spec 10 §3). */
  maxUsd: number;
  /** The pinned comparison engine; no automatic fallback (spec 04 §1). */
  requiredEngine: 'typesafe' | 'llm';
  /** The Jev model (`TYPESAFE_MODEL`, or a replay's `--model`). */
  typesafeModel: string;
  /** The LLM model of an `--engine llm` replay (`OLLAMA_MODEL_FAST` by default). */
  llmModel: string;
  credentials: CredentialResolver;
  overrides: EvalServiceOverrides;
  /** Called with every logical request id the router assigns (the run's own spend, below). */
  onLogicalRequest: (id: string) => void;
}

/**
 * The eval router of one invocation: the production router over the PostgreSQL store with
 * `budgetOverrideUsd = --max-usd`, `ignoreDailyCaps: true` and `requiredEngine` (spec 04 §1, spec 10
 * §3). Every call, translations included, is recorded as `kind = 'eval'`, so it never counts against
 * the production budget or caps. Its breaker is process-local (D-111): an evaluation outage must
 * neither open nor be blocked by the production breaker in `settings['engine.circuit']`, and a
 * pinned run records an unavailable engine as missing observations instead.
 */
export function createEvalRouter(options: EvalRouterOptions): EngineRouter {
  const { config } = options;
  const production = config.nodeEnv === 'production';
  const engineConfig: EngineConfig = {
    typesafe: {
      baseUrl: config.typesafeBaseUrl,
      model: options.typesafeModel,
      pricePerMTokUsd: config.typesafePricePerMtokUsd,
      // The fake server's model is the explicit test configuration outside production (spec 04 §3).
      ...(!production && options.typesafeModel === JEV_FAKE_MODEL ? { allowFakeModel: true } : {}),
    },
    ollama: {
      baseUrl: config.ollamaBaseUrl,
      modelFast: options.llmModel,
      modelStrong: config.ollamaModelStrong,
      maxConcurrency: config.ollamaMaxConcurrency,
      maxOutputTokens: DEFAULT_LLM_MAX_OUTPUT_TOKENS,
    },
    concurrency: config.engineConcurrency,
    dailyBudgetUsd: config.dailyBudgetUsd,
    llmFallbackEnabled: false,
    production,
  };
  return createEngineRouter({
    config: engineConfig,
    store: createPgEngineStore(options.db, { dailyBudgetUsd: config.dailyBudgetUsd }),
    logger: options.logger,
    clock: options.overrides.clock ?? systemClock,
    credentials: options.credentials,
    circuit: createMemoryCircuitStore(),
    budgetOverrideUsd: options.maxUsd,
    ignoreDailyCaps: true,
    requiredEngine: options.requiredEngine,
    newId: () => {
      const id = newUuid();
      options.onLogicalRequest(id);
      return id;
    },
    ...(options.overrides.engines === undefined ? {} : { engines: options.overrides.engines }),
    ...(options.overrides.random === undefined ? {} : { random: options.overrides.random }),
  });
}

/** The credential resolver of an invocation: an injected one, or the encrypted-row resolver. */
export function evalCredentials(
  db: Database,
  config: EvalServiceConfig,
  overrides: EvalServiceOverrides,
): CredentialResolver {
  return (
    overrides.credentials ??
    createEvalCredentialResolver({
      db,
      masterKeyId: config.providerMasterKeyId,
      masterKeys: config.providerMasterKeys,
      envKeys: { typesafe: config.typesafeApiKey, ollama: config.ollamaApiKey },
    })
  );
}

/** Lazily created translation clients; `close` releases only the ones created here. */
export interface EvalTranslators {
  libretranslate(): LibreTranslateClient;
  ollama(): OllamaTranslator;
  close(): Promise<void>;
}

export function evalTranslators(
  config: EvalServiceConfig,
  overrides: EvalServiceOverrides,
): EvalTranslators {
  let lt: LibreTranslateClient | undefined;
  let ollama: OllamaTranslator | undefined;
  const owned: Array<{ close(): Promise<void> }> = [];
  return {
    libretranslate() {
      if (overrides.libretranslate !== undefined) return overrides.libretranslate;
      if (lt === undefined) {
        lt = createLibreTranslateClient({ baseUrl: config.libretranslateUrl });
        owned.push(lt);
      }
      return lt;
    },
    ollama() {
      if (overrides.ollama !== undefined) return overrides.ollama;
      if (ollama === undefined) {
        ollama = createOllamaTranslator({ baseUrl: config.ollamaBaseUrl });
        owned.push(ollama);
      }
      return ollama;
    },
    async close() {
      await Promise.all(owned.map((client) => client.close()));
    },
  };
}

/** A UUID for a logical request the runner records itself (translation attempts). */
export const newLogicalRequestId = (): string => newUuid();
