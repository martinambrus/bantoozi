/**
 * Ports shared between consumer packages (`packages/engine`, `packages/feeds`) and their
 * `packages/db` implementations (spec 01 §2, spec 04 §1, spec 03 §4). Types only: `packages/db`
 * implements them by importing these from `@bantoozi/shared`.
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

/**
 * Result of reserving a request start at one origin (spec 03 §8.2). Nothing is reserved unless
 * `granted`; the holder releases exactly its `token` when the request ends.
 */
export type OriginReservation =
  | { status: 'granted'; token: string }
  /** Both request leases are held or the next start slot is later: try again at `retryAt`. */
  | { status: 'wait'; retryAt: Date }
  /** A persisted 429/503 cooldown: defer the work until `until` instead of sleeping in a worker. */
  | { status: 'blocked'; until: Date };

/**
 * The per-origin politeness throttle shared by every safe-fetch caller: API discovery, feed fetch,
 * robots and page extraction, across processes (spec 03 §4, §8.2). At most two concurrent requests
 * and one second between request starts per origin (`scheme://host:port`), plus persisted
 * cooldowns. `packages/feeds` consumes it; `packages/db` implements it on `origin_fetch_state` with
 * short transactions that are never held open across an HTTP request. Lease expiry must exceed the
 * total request deadline, so a crashed holder's lease is reclaimed.
 */
export interface OriginLimiter {
  /** Try to reserve a request start under a lease of `leaseMs`; never waits itself. */
  reserve(origin: string, options: { leaseMs: number }): Promise<OriginReservation>;
  /** Release exactly this lease; releasing an unknown or expired token is a no-op. */
  release(origin: string, token: string): Promise<void>;
  /** Persist a cooldown until `until` (clamped to 24 h); never shortens a longer existing one. */
  block(origin: string, until: Date): Promise<void>;
}
