import type { Question, Answer } from '@bantoozi/questions';
import type {
  BreakerState,
  CallKind,
  CallStatus,
  Clock,
  EngineName,
  EngineStore,
  ExternalCall,
  InferenceAuthorization,
  JsonValue,
} from '@bantoozi/shared';
import type { CredentialResolver, ProviderAuth } from '@bantoozi/shared/server';

import type { BreakerParams, CircuitStore } from './breaker.js';
import type { RequestLimits } from './normalize.js';

/**
 * Public types of the decision engine (spec 04 §1). Question/answer shapes live in
 * `@bantoozi/questions` (the builders produce them; spec 01 §2 lets engine import questions for types
 * only) and the persistence ports in `@bantoozi/shared`; both are re-exported here under the spec's
 * names.
 */
export type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  Criteria,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
} from '@bantoozi/questions';
export type {
  BreakerState,
  CallKind,
  CallStatus,
  EngineCallRow,
  EngineName,
  EngineStore,
  ExternalCall,
  InferenceAuthorization,
  UsageRow,
} from '@bantoozi/shared';
export type { CredentialResolver, ProviderAuth } from '@bantoozi/shared/server';

export type Priority = 'interactive' | 'bulk';

export interface EngineRequest {
  /** Translation and credential probes use ExternalCall instead. */
  kind: Exclude<CallKind, 'translate' | 'credential_probe'>;
  state: JsonValue;
  /** Keys: `[a-zA-Z0-9_.-]{1,64}`. */
  questions: Record<string, Question>;
  /** For logging. */
  questionSetId?: string;
  questionSetSha: string;
  articleId?: string;
  /** Immutable snapshot; decimal bigint string. */
  articleRevision?: string;
  /** Hash of the exact canonical serialized state. */
  stateSha256: string;
  cardIds?: string[];
  /** Cost attribution. */
  userId?: string;
  priority: Priority;
  /** Server-produced capability, not model state. */
  authorization: InferenceAuthorization;
  /**
   * Absolute deadline of the calling job (epoch ms). A retry delay that would end after it returns a
   * deferred outcome with `retryAt` instead of waiting (spec 04 §4).
   */
  deadlineMs?: number;
}

export type EngineOutcome =
  | {
      ok: true;
      engine: EngineName;
      model: string;
      answers: Record<string, Answer>;
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: 'no_key' | 'budget' | 'circuit_open' | 'error' | 'invalid_request' | 'no_demand';
      detail?: string;
      retryAt?: Date;
    };

export type EngineAttempt =
  | Extract<EngineOutcome, { ok: true }>
  | {
      ok: false;
      status: Exclude<CallStatus, 'ok'>;
      retryable: boolean;
      retryAfterMs?: number;
      detail?: string;
      usage?: { inputTokens: number; outputTokens: number };
      billing: 'known' | 'uncertain';
    };

/** Adapters perform exactly ONE wire attempt; the router owns retries (spec 04 §4). */
export interface DecisionEngine {
  readonly name: EngineName;
  /** Router calls remote adapters inside `useActive`; local Laya has no auth object. */
  ask(req: EngineRequest, signal: AbortSignal, auth?: ProviderAuth): Promise<EngineAttempt>;
}

export interface RouterStatus {
  credentials: Record<
    'typesafe' | 'ollama',
    { source: 'none' | 'env' | 'db'; enabled: boolean; activeVersion?: string }
  >;
  breakers: { typesafe: BreakerState; llm: BreakerState };
  spendTodayUsd: number;
  budgetUsd: number;
  llmCallsToday: number;
}

/** The ONLY thing handlers use (spec 04 §1). */
export interface EngineRouter {
  ask(req: EngineRequest, signal?: AbortSignal): Promise<EngineOutcome>;
  status(): Promise<RouterStatus>;
  /** Advisory only, never authorization to send. */
  canSpend(estimateUsd: number, priority: Priority): Promise<boolean>;
  /** Paid external calls MUST reserve before HTTP. */
  reserveExternalCall(input: {
    engine: ExternalCall['engine'];
    kind: ExternalCall['kind'];
    estimateUsd: number;
    priority: Priority;
    userId?: string;
    authorization: InferenceAuthorization;
  }): Promise<string | null>;
  /** A failed attempt also settles conservatively. */
  recordExternalCall(call: ExternalCall, reservationId?: string): Promise<void>;
}

/** The structured logger subset the engine uses (pino in production). */
export interface EngineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Host configuration of the router (spec 01 §3 env, spec 04). Settings-table values (budget, caps,
 * breaker state) are read through the store at run time and win over these defaults.
 */
export interface EngineConfig {
  typesafe: {
    baseUrl: string;
    /** TYPESAFE_MODEL: always a pinned version in production. */
    model: string;
    pricePerMTokUsd: number;
    /**
     * This process's static share of the account rate limits, in (0, 1] (spec 04 §3: the shares of
     * all processes sum to at most 1). Default 1.
     */
    rateLimitShare?: number;
    /** Account request limit per minute; default 1,000 (spec 04 §3). */
    requestsPerMinute?: number;
    /** Account input-token limit per second; default 200,000 (spec 04 §3). */
    inputTokensPerSecond?: number;
    /**
     * Tests and E2E only: accept the fake server's `jev-fake` model (spec 04 §3, §10). The router
     * refuses to start with it in production.
     */
    allowFakeModel?: boolean;
    /**
     * Outbound request limits (spec 04 §2), checked by the router before any spend and by the
     * adapter before its wire attempt; unset fields keep `DEFAULT_REQUEST_LIMITS` (1 MiB, …).
     */
    limits?: Partial<RequestLimits>;
  };
  ollama: {
    baseUrl: string;
    modelFast: string;
    modelStrong: string;
    maxConcurrency: number;
    /**
     * The decision fallback's `num_predict`: the output cap every LLM attempt reserves at output
     * prices and packs are split to fit (spec 04 §5 step 4, §6.1). Default 2,048.
     */
    maxOutputTokens?: number;
  };
  /** ENGINE_CONCURRENCY: process-wide in-flight engine calls. */
  concurrency: number;
  /** DAILY_BUDGET_USD: used when `settings['engine.daily_budget_usd']` is missing. */
  dailyBudgetUsd: number;
  /** LLM_FALLBACK_ENABLED. */
  llmFallbackEnabled: boolean;
  /** NODE_ENV === 'production': model pins are enforced, `jev-fake` is refused. */
  production: boolean;
  /**
   * The longest retry delay the router waits in-process; a longer one (e.g. a long `Retry-After`)
   * returns a deferred outcome with `retryAt` even before the job deadline. Default 60 s.
   */
  maxRetryWaitMs?: number;
}

export interface CreateEngineRouterDeps {
  config: EngineConfig;
  store: EngineStore;
  logger: EngineLogger;
  clock: Clock;
  /** Server-only; resolves the current active key for each wire attempt. */
  credentials: CredentialResolver;
  /** Inject fakes (tests, E2E, eval dry run). */
  engines?: Partial<Record<EngineName, DecisionEngine>>;
  /** Eval only (spec 04 §1 "Eval routers"). */
  budgetOverrideUsd?: number;
  /** Eval: ignore llm/tier-2 daily caps. */
  ignoreDailyCaps?: boolean;
  /** Eval: pin, no automatic fallback. */
  requiredEngine?: EngineName;
  /** Randomness for retry jitter (tests pass a deterministic one). */
  random?: () => number;
  /**
   * The authoritative shared breaker state, `settings['engine.circuit']` (spec 04 §5). Default: the
   * store itself when it implements `readCircuit`/`updateCircuit` (the PostgreSQL store does),
   * otherwise a process-local circuit.
   */
  circuit?: CircuitStore;
  /** Breaker parameters (tests); the defaults are those of spec 04 §5. */
  breakerParams?: Partial<BreakerParams>;
  /** Logical request ids; default UUID v7. */
  newId?: () => string;
}
