import type { Question, Answer } from '@bantoozi/questions';
import type {
  BreakerState,
  CallKind,
  CallStatus,
  EngineName,
  ExternalCall,
  InferenceAuthorization,
  JsonValue,
} from '@bantoozi/shared';
import type { ProviderAuth } from '@bantoozi/shared/server';

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
