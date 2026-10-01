import type { SessionContext, TenantTx } from '@bantoozi/db';
import type { JobSender } from '@bantoozi/shared';

/**
 * Who may call a route (spec 08 §1 "Authorization"). Every route declares one in its `config`;
 * a route without one is treated as `user`, so a forgotten declaration fails closed.
 * - `public`: no session (request-code, verify, waitlist, health)
 * - `user`: an active, unrevoked session of a non-deleted user
 * - `admin`: a `user` session whose current DB role is `admin`
 * - `metrics`: the `METRICS_TOKEN` bearer only (exempt from CSRF; `POST /admin/ops-event`)
 * - `admin_or_metrics`: an admin session or the bearer (`GET /metrics`)
 */
export type AuthMode = 'public' | 'user' | 'admin' | 'metrics' | 'admin_or_metrics';

/** One limit of spec 08 §11 applied to a route group. */
export interface RateLimitRule {
  /** Stable group name, part of the bucket key. */
  group: string;
  max: number;
  windowSeconds: number;
  /** The subject the bucket is keyed by. */
  per: 'ip' | 'user';
}

/** The authenticated caller (spec 08 §2.1): resolved from the session cookie on every request. */
export interface AuthContext extends SessionContext {
  /** The raw cookie token: needed only to re-issue the sliding cookie; never logged or stored. */
  readonly token: string;
}

/** Context handed to an idempotent mutation (spec 08 §1.1). */
export interface MutationContext {
  /** The client's `Idempotency-Key` (a UUID), which is also the receipt id and `mutationId`. */
  readonly mutationId: string;
  /** Outbox writer bound to this transaction's tenant. */
  readonly outbox: JobSender;
  /** Transaction start time from the injected clock. */
  readonly now: Date;
}

/** What an idempotent mutation returns; it is saved as the receipt before commit. */
export interface MutationOutcome<T = unknown> {
  status: number;
  body: T;
  /** Allowlisted prior reader fields for exact undo (spec 08 §5.4); omitted when not undoable. */
  undo?: unknown;
  /**
   * Runs in the same transaction right after the receipt is saved, for rows that reference it
   * (e.g. `bookmark_snapshot_pins` of an unbookmark, spec 02 §3.5); not run on a replay.
   */
  afterSave?: (tx: TenantTx) => Promise<void>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthMode;
    /** Route-specific limits in addition to the global per-IP and per-user mutation limits. */
    rateLimits?: readonly RateLimitRule[];
    /** Skip the per-user mutation limit and the idempotency requirement (auth login/logout). */
    authFlow?: boolean;
    /** `healthz`/`readyz`: the per-IP limit fails open when the database is unreachable. */
    healthProbe?: boolean;
  }

  interface FastifyRequest {
    /** Set by the auth plugin for `user`/`admin` routes (and for an admin `admin_or_metrics` caller). */
    auth: AuthContext | null;
    /** True when the request was authenticated by the `METRICS_TOKEN` bearer. */
    metricsBearer: boolean;
    /**
     * Run `fn` in a transaction bound to the caller's tenant (spec 08 §1 "Tenancy"). Nothing is
     * opened until the first call; each call is its own READ COMMITTED transaction.
     */
    withTx<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
    /**
     * Run an idempotent mutation (spec 08 §1.1): reserve the `Idempotency-Key`, replay a saved
     * receipt, or run `fn` and save its outcome in the same transaction.
     */
    mutate<T>(
      fn: (tx: TenantTx, ctx: MutationContext) => Promise<MutationOutcome<T>>,
    ): Promise<MutationOutcome<T>>;
    /**
     * The saved receipt of this request's `Idempotency-Key`, or `null` when there is none. Routes
     * that do slow outbound work before `mutate` (discovery) call it first, so a retry of a
     * committed request is answered from its receipt without repeating that work. It waits for an
     * in-flight mutation with the same key to finish. A receipt of a different request is an
     * `IDEMPOTENCY_CONFLICT`, as in `mutate`.
     */
    savedOutcome<T>(): Promise<MutationOutcome<T> | null>;
    /**
     * Run `fn` while holding this caller's `Idempotency-Key` in this API process: a duplicate
     * request waits until `fn` settles. Routes that do slow outbound work before `mutate` wrap the
     * whole handler in it, so a concurrent duplicate replays the first request's receipt instead of
     * repeating discovery.
     */
    holdingKey<T>(fn: () => Promise<T>): Promise<T>;
  }
}
