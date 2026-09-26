/**
 * Ports shared between `packages/engine` (consumer) and `packages/db` (implementation) — spec 04 §1.
 * Types only: `packages/db` implements `EngineStore` by importing these from `@bantoozi/shared`.
 */

export type EngineName = 'typesafe' | 'llm' | 'laya';

export type CallKind =
  'enrich' | 'match' | 'cluster' | 'suggest' | 'translate' | 'eval' | 'credential_probe';

export type InferenceAuthorization =
  | {
      type: 'article';
      articleId: string;
      articleRevision: string;
      witnesses: Array<
        | { kind: 'automatic'; userId: string; feedId: string; inferenceVersion: string }
        | { kind: 'manual'; analysisRequestId: string }
      >;
    }
  | { type: 'suggest'; userId: string; eligibleArticleIds: string[]; leaseToken: string } // spec 05 §7
  | { type: 'credential_probe'; provider: 'typesafe' | 'ollama'; candidateVersion: string }
  | { type: 'eval'; runId: string }; // separately authorized eval; never inferred from a feed fetch

export type CallStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_request'
  | 'invalid_response'
  | 'auth_error';

/** Mirrors `engine_calls` (spec 02 §3.1). One row per wire attempt. */
export interface EngineCallRow {
  engine: EngineName | 'libretranslate';
  kind: CallKind;
  model?: string;
  articleId?: string;
  questionSetId?: string;
  cardIds?: string[];
  userId?: string;
  nQuestions: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs?: number;
  billing: 'known' | 'uncertain';
  logicalRequestId: string;
  /** Unique, for idempotent settlement. */
  reservationId?: string;
  articleRevision?: string;
  stateSha256?: string;
  /** Metadata only; never the key or encrypted envelope. */
  credentialVersion?: string;
  /** Attempt ordinal: increases monotonically for this engine across all subpacks of the request. */
  attempts: number;
  status: CallStatus;
  error?: string;
  createdAt: Date;
}

/** Mirrors `usage_daily`. */
export interface UsageRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** A user id or the platform sentinel. */
  userId: string;
  engine: string;
  kind: CallKind;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The platform sentinel user id of `usage_daily` (spec 02 §3.1). */
export const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Non-engine calls logged through the router (translation, spec 07 §2). */
export interface ExternalCall {
  engine: 'libretranslate' | 'llm' | 'typesafe';
  kind: 'translate' | 'eval' | 'credential_probe';
  model?: string;
  articleId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  status: CallStatus;
  error?: string;
  billing: 'known' | 'uncertain';
  logicalRequestId: string;
  attempt: number;
  articleRevision?: string;
  stateSha256?: string;
  credentialVersion?: string;
}

export interface BudgetSnapshot {
  settledUsd: number;
  reservedUsd: number;
  uncertainUsd: number;
  /** Keys `${engine}:${kind}`; each attempt once. */
  callsByEngineKind: Record<string, number>;
}

/** Implemented in `packages/db`. */
export interface EngineStore {
  /** Rechecks live demand atomically; returns a reservation id or null when denied. */
  reserveSpend(input: {
    day: string;
    engine: string;
    kind: CallKind;
    userId?: string;
    estimateUsd: number;
    priority: 'interactive' | 'bulk';
    callCap?: number;
    authorization: InferenceAuthorization;
  }): Promise<string | null>;
  /** Free/local call fence. */
  authorizeInference(authorization: InferenceAuthorization): Promise<boolean>;
  /** One transaction: call + rollup + reservation. */
  settleReservation(
    id: string,
    call: EngineCallRow,
    usage: UsageRow,
    billing: 'known' | 'uncertain',
  ): Promise<void>;
  /** Zero-cost calls only; idempotent. */
  insertCall(row: EngineCallRow): Promise<void>;
  /** Used inside settlement, never independently for paid calls. */
  upsertUsage(row: UsageRow): Promise<void>;
  spendSince(fromUtc: Date, opts: { excludeKinds: CallKind[] | 'none' }): Promise<number>;
  /**
   * Actual settled cost plus separate outstanding/uncertain reservation amounts; never count one
   * reservation and its audit row twice. Counts include admitted in-flight attempts. Production
   * status/caps exclude eval; admission still locks/reserves atomically.
   */
  getBudgetSnapshot(
    dayUtc: string,
    opts: { excludeKinds: CallKind[] | 'none' },
  ): Promise<BudgetSnapshot>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
}
