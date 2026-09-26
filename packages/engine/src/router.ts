import {
  conservativeRequestTokens,
  isAppError,
  isBigIntString,
  isUuid,
  newUuid,
  parseSetting,
  settingDefault,
  utcDay,
  type CallKind,
  type EngineCallRow,
  type EngineName,
  type SettingEnvDefaults,
  type UsageRow,
} from '@bantoozi/shared';

import {
  createBreakerCoordinator,
  createMemoryCircuitStore,
  type BreakerAdmission,
  type BreakerOutcome,
  type CircuitStore,
} from './breaker.js';
import {
  createLlmFallbackEngine,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  estimateLlmCostUsd,
  estimateLlmInputTokens,
  estimateLlmOutputTokens,
  llmCostUsd,
} from './llm-fallback-engine.js';
import { validateRequest } from './normalize.js';
import { createRateLimiter, type RateLimiter } from './rate-limiter.js';
import { decideRetry, sleep } from './retry.js';
import { createPrioritySemaphore, type PrioritySemaphore } from './semaphore.js';
import {
  admitsSpend,
  attributionUserId,
  capGroupCalls,
  committedSpendUsd,
  effectiveDailyBudgetUsd,
  InvocationBudget,
  nextUtcDay,
  USD_EPSILON,
} from './spend-guard.js';
import { createTypeSafeEngine, typesafeCostUsd } from './typesafe-engine.js';
import type {
  Answer,
  CreateEngineRouterDeps,
  DecisionEngine,
  EngineAttempt,
  EngineOutcome,
  EngineRequest,
  EngineRouter,
  ExternalCall,
  ProviderAuth,
  Question,
  RouterStatus,
} from './types.js';

/**
 * The engine router (spec 04 §1, §4–§7): the only door from handlers to a decision model. One
 * `ask` is one **logical request** with its own `logicalRequestId`:
 *
 * 1. validate the request (spec 04 §2) and its live demand (§1.1, `authorizeInference`); a lost
 *    demand is the quiet `no_demand`;
 * 2. TypeSafe (Jev) unless it has no usable credential: breaker admission (a half-open probe lease
 *    when due), then per wire attempt the rate limiter, the concurrency semaphore, the credential
 *    (`useActive`, re-read and decrypted for this attempt only) and an atomic spend reservation
 *    (`reserveSpend`, which rechecks demand, budget and call caps) immediately before the send;
 *    every attempt is settled as one `engine_calls` row with its `usage_daily` rollup;
 * 3. on failure, the LLM fallback only when `LLM_FALLBACK_ENABLED`, the request is interactive, the
 *    LLM breaker admits it and a daily-cap slot is reserved with the LLM's own spend (input plus the
 *    full output cap at LLM prices), splitting the pack so each part's answer fits the output cap;
 *    it succeeds only when every original key has an answer;
 * 4. otherwise the primary outcome: `no_key`, `budget` (retry at the next UTC day),
 *    `circuit_open` (retry when the breaker allows a probe), `invalid_request`, or `error`.
 *
 * **Outcome contract for callers** (spec 05 §5.5): `error` **with** `retryAt` is a deferral (a
 * `Retry-After` or local wait beyond the job deadline, or a cancellation) that must not consume a
 * failure attempt; `error` without `retryAt` is actual retry exhaustion or a permanent failure.
 *
 * Retries (§4): at most 4 TypeSafe / 2 LLM attempts per (sub)pack, `500 ms × 2^(n−2)` ± 20 %
 * jitter, never sooner than a valid `Retry-After`; backoff holds no semaphore slot. Attempt
 * ordinals increase per engine across all subpacks of the logical request. Eval routers
 * (`budgetOverrideUsd`) record everything as `kind = 'eval'` under their own invocation cap.
 *
 * Provider and HTTP failures never throw; infrastructure failures of the store (the database) do,
 * so the queue retries the job. Secrets never leave the `useActive` callback: only the credential
 * version is kept, as call metadata.
 */

/** Default of `EngineConfig.maxRetryWaitMs`. */
export const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
/** Retry hint of a deferral caused by local concurrency (a full semaphore at the job deadline). */
const CAPACITY_RETRY_MS = 1_000;
/** Settlement is tried this often before the reservation is left charged for housekeeping. */
const SETTLE_TRIES = 3;
/** Reservations of external calls remembered for their settlement (attribution, eval cap). */
const MAX_TRACKED_RESERVATIONS = 10_000;
const MAX_DETAIL_LENGTH = 200;
const MAX_CARD_IDS = 10_000;
const DIGEST = /^[A-Za-z0-9+/=_-]{1,128}$/;
const REASON = /^[a-z][a-z0-9_]{0,31}$/;
const ASK_KINDS: ReadonlySet<string> = new Set(['enrich', 'match', 'cluster', 'suggest', 'eval']);
/** `settingDefault` of the cap keys does not depend on the environment. */
const NO_ENV: SettingEnvDefaults = { dailyBudgetUsd: 0, languageModes: {}, signupMode: 'invite' };

type FailedOutcome = Extract<EngineOutcome, { ok: false }>;
type SuccessOutcome = Extract<EngineOutcome, { ok: true }>;
type SuccessAttempt = Extract<EngineAttempt, { ok: true }>;
type FailedAttempt = Extract<EngineAttempt, { ok: false }>;
type PaidEngine = 'typesafe' | 'llm';
type CredentialProvider = 'typesafe' | 'ollama';
interface Usage {
  inputTokens: number;
  outputTokens: number;
}
type Questions = Record<string, Question>;

/** A remote, paid engine with its limits and prices. */
interface Lane {
  name: PaidEngine;
  provider: CredentialProvider;
  engine: DecisionEngine;
  /** Injected (tests, E2E, eval dry run): may run without a credential. */
  injected: boolean;
  /** The configured model, recorded for attempts that report none. */
  model: string;
  /** Acquired in this order around each wire attempt. */
  semaphores: readonly PrioritySemaphore[];
  limiter: RateLimiter | undefined;
  /** Upper cost of one attempt, reserved before it is sent. */
  estimateUsd(req: EngineRequest): number;
  /** Cost of reported usage (failed attempts carry usage but no cost). */
  costUsd(usage: Usage): number;
  /** Input tokens the rate limiter charges for one attempt. */
  rateTokens(req: EngineRequest): number;
}

/** One logical request in flight. */
interface AskContext {
  req: EngineRequest;
  /** The recorded kind: `eval` on eval routers. */
  kind: CallKind;
  signal: AbortSignal;
  logicalRequestId: string;
  /** Attempt ordinals per engine across all subpacks (spec 04 §4). */
  ordinals: Record<EngineName, number>;
}

/** One engine's part of a logical request. */
interface LaneRun {
  lane: Lane;
  /** The half-open probe lease this logical request holds, if any. */
  probeToken: string | undefined;
  /** The daily call cap reserved with each attempt (the LLM decision cap). */
  callCap: number | undefined;
  /** An injected engine used while no credential is available. */
  withoutCredential: boolean;
  spent: Usage & { costUsd: number };
}

type AttemptResult =
  | {
      kind: 'sent';
      attempt: EngineAttempt;
      ordinal: number;
      reservationId: string;
      reservedUsd: number;
      createdAt: Date;
      credentialVersion: string | undefined;
      /** A credential was sent (only then can a 401/403 condemn it). */
      authenticated: boolean;
    }
  | { kind: 'no_credential'; reason: string }
  | { kind: 'denied' }
  | { kind: 'eval_budget' }
  | { kind: 'cancelled' }
  | { kind: 'deferred'; retryAt: Date; detail: string };

type PackResult =
  | { ok: true; attempt: SuccessAttempt }
  | { ok: false; outcome: FailedOutcome; breaker: BreakerOutcome };

type LaneResult = { ok: true; outcome: SuccessOutcome } | { ok: false; outcome: FailedOutcome };

const capDetail = (detail: string): string =>
  detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 3)}...` : detail;

function failed(reason: FailedOutcome['reason'], detail?: string, retryAt?: Date): FailedOutcome {
  return {
    ok: false,
    reason,
    ...(detail === undefined ? {} : { detail: capDetail(detail) }),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

const isPositiveId = (value: unknown): boolean =>
  typeof value === 'string' && isBigIntString(value) && BigInt(value) > 0n;

/** An error's class or code, never its message (which could quote driver parameters). */
function errorLabel(error: unknown): string {
  if (isAppError(error)) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

/** The typed reason a credential resolver gave (`AppError` ENGINE_UNAVAILABLE details). */
function unavailableReason(error: unknown): string {
  if (isAppError(error) && error.code === 'ENGINE_UNAVAILABLE') {
    const reason = error.details?.reason;
    if (typeof reason === 'string' && REASON.test(reason)) return reason;
  }
  return 'unavailable';
}

function isCircuitStore(value: unknown): value is CircuitStore {
  const candidate = value as Partial<CircuitStore> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.readCircuit === 'function' &&
    typeof candidate.updateCircuit === 'function'
  );
}

/**
 * Split a question set into packs whose complete LLM answer fits `maxOutputTokens` (spec 04 §5
 * step 4, spec 05 §5.2 "repack for the fallback engine's smaller limits"), keeping key order. Null
 * when a single question cannot fit: the LLM cannot answer that set.
 */
export function splitQuestionsForLlm(
  questions: Questions,
  maxOutputTokens: number,
): Questions[] | null {
  const packs: Questions[] = [];
  let current: Array<[string, Question]> = [];
  for (const entry of Object.entries(questions)) {
    if (estimateLlmOutputTokens(Object.fromEntries([entry])) > maxOutputTokens) return null;
    const candidate = [...current, entry];
    if (
      current.length > 0 &&
      estimateLlmOutputTokens(Object.fromEntries(candidate)) > maxOutputTokens
    ) {
      packs.push(Object.fromEntries(current));
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) packs.push(Object.fromEntries(current));
  return packs;
}

export function createEngineRouter(deps: CreateEngineRouterDeps): EngineRouter {
  const { config, store, logger, clock, credentials } = deps;
  if (config.production && config.typesafe.allowFakeModel === true) {
    // The fake server's model is a test configuration only (spec 04 §3): refuse, never degrade.
    throw new TypeError('EngineRouter: typesafe.allowFakeModel is not allowed in production');
  }
  const requestLimits = config.typesafe.limits ?? {};
  const random = deps.random ?? Math.random;
  const newId = deps.newId ?? newUuid;
  const evalBudget =
    deps.budgetOverrideUsd === undefined ? undefined : new InvocationBudget(deps.budgetOverrideUsd);
  const evalRouter = evalBudget !== undefined;
  const ignoreDailyCaps = deps.ignoreDailyCaps === true;
  const pinned = deps.requiredEngine;
  const maxRetryWaitMs = config.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
  const maxOutputTokens = config.ollama.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS;
  const nowMs = (): number => clock.now().getTime();

  const breaker = createBreakerCoordinator({
    store: deps.circuit ?? (isCircuitStore(store) ? store : createMemoryCircuitStore()),
    clock,
    logger,
    ...(deps.breakerParams === undefined ? {} : { params: deps.breakerParams }),
  });
  const engineSlots = createPrioritySemaphore({ capacity: config.concurrency, now: nowMs });
  const llmSlots = createPrioritySemaphore({
    capacity: config.ollama.maxConcurrency,
    now: nowMs,
  });
  const limiter = createRateLimiter({
    share: config.typesafe.rateLimitShare ?? 1,
    ...(config.typesafe.requestsPerMinute === undefined
      ? {}
      : { requestsPerMinute: config.typesafe.requestsPerMinute }),
    ...(config.typesafe.inputTokensPerSecond === undefined
      ? {}
      : { inputTokensPerSecond: config.typesafe.inputTokensPerSecond }),
    now: nowMs,
  });
  /** External-call reservations of this process: attribution and the eval reserve at settlement. */
  const external = new Map<string, { estimateUsd: number; userId: string | undefined }>();

  function adapterError(engine: EngineName, error: unknown): undefined {
    logger.error(
      { engine, err: error instanceof Error ? error.message : 'unknown' },
      'engine adapter is not configured; the engine is unavailable',
    );
    return undefined;
  }

  function buildTypesafeLane(): Lane | undefined {
    const injected = deps.engines?.typesafe;
    let engine = injected;
    if (engine === undefined) {
      try {
        engine = createTypeSafeEngine({
          baseUrl: config.typesafe.baseUrl,
          model: config.typesafe.model,
          pricePerMTokUsd: config.typesafe.pricePerMTokUsd,
          production: config.production,
          limits: requestLimits,
          ...(config.typesafe.allowFakeModel === true ? { allowFakeModel: true } : {}),
        });
      } catch (error) {
        return adapterError('typesafe', error);
      }
    }
    const price = config.typesafe.pricePerMTokUsd;
    return {
      name: 'typesafe',
      provider: 'typesafe',
      engine,
      injected: injected !== undefined,
      model: config.typesafe.model,
      semaphores: [engineSlots],
      limiter,
      // Output tokens are free (spec 04 §3); input is the conservative §6.1 bound.
      estimateUsd: (req) =>
        typesafeCostUsd(conservativeRequestTokens(req.state, req.questions), price),
      costUsd: (usage) => typesafeCostUsd(usage.inputTokens, price),
      rateTokens: (req) => conservativeRequestTokens(req.state, req.questions),
    };
  }

  function buildLlmLane(): Lane | undefined {
    const injected = deps.engines?.llm;
    if (!config.llmFallbackEnabled && pinned !== 'llm' && injected === undefined) return undefined;
    const model = config.ollama.modelFast;
    let engine = injected;
    try {
      // An unpriced model cannot be admitted (spec 04 §8).
      estimateLlmCostUsd(0, 0, model);
      engine ??= createLlmFallbackEngine({
        baseUrl: config.ollama.baseUrl,
        model,
        maxOutputTokens,
        production: config.production,
      });
    } catch (error) {
      return adapterError('llm', error);
    }
    return {
      name: 'llm',
      provider: 'ollama',
      engine,
      injected: injected !== undefined,
      model,
      semaphores: [llmSlots, engineSlots],
      limiter: undefined,
      // Input (with the system prompt and schema) plus the FULL output cap (spec 04 §6.1).
      estimateUsd: (req) =>
        estimateLlmCostUsd(
          estimateLlmInputTokens(req.state, req.questions),
          maxOutputTokens,
          model,
        ),
      costUsd: (usage) => llmCostUsd(usage, model),
      rateTokens: () => 0,
    };
  }

  const typesafeLane = buildTypesafeLane();
  const llmLane = buildLlmLane();

  // ── Settings read at admission ────────────────────────────────────────────────────────────────

  async function dailyCap(key: 'engine.llm_daily_cap' | 'translate.tier2_daily_cap') {
    const fallback = settingDefault(key, NO_ENV) ?? 0;
    const stored = await store.getSetting<unknown>(key);
    if (stored === undefined) return fallback;
    try {
      return parseSetting(key, stored);
    } catch {
      logger.warn({ key }, 'stored setting is malformed; using its default');
      return fallback;
    }
  }

  async function budgetUsd(): Promise<number> {
    const stored = await store.getSetting<unknown>('engine.daily_budget_usd');
    try {
      return effectiveDailyBudgetUsd(stored, config.dailyBudgetUsd);
    } catch {
      logger.warn(
        { key: 'engine.daily_budget_usd' },
        'stored setting is malformed; using the host default',
      );
      return config.dailyBudgetUsd;
    }
  }

  // ── Validation ────────────────────────────────────────────────────────────────────────────────

  /** Why a request cannot be sent to any provider (a log-safe detail), or undefined. */
  function requestProblem(req: EngineRequest): string | undefined {
    if (typeof req !== 'object' || req === null) return 'request: not an object';
    if (!ASK_KINDS.has(req.kind)) return 'kind: unknown';
    if (req.kind === 'eval' && !evalRouter) return 'kind: eval needs an eval router';
    if (req.priority !== 'interactive' && req.priority !== 'bulk') return 'priority: unknown';
    const authorization: unknown = req.authorization;
    if (typeof authorization !== 'object' || authorization === null)
      return 'authorization: missing';
    const type = (authorization as { type?: unknown }).type;
    // Eval spend is separately authorized; production routers serve article and suggest demand.
    if (evalRouter ? type !== 'eval' : type !== 'article' && type !== 'suggest') {
      return 'authorization: not valid for this router';
    }
    if (typeof req.stateSha256 !== 'string' || !DIGEST.test(req.stateSha256)) {
      return 'stateSha256: invalid';
    }
    if (typeof req.questionSetSha !== 'string' || !DIGEST.test(req.questionSetSha)) {
      return 'questionSetSha: invalid';
    }
    if (req.userId !== undefined && !(typeof req.userId === 'string' && isUuid(req.userId))) {
      return 'userId: not a UUID';
    }
    if (req.articleId !== undefined && !isPositiveId(req.articleId)) return 'articleId: invalid';
    if (req.articleRevision !== undefined && !isPositiveId(req.articleRevision)) {
      return 'articleRevision: invalid';
    }
    if (req.questionSetId !== undefined && !isPositiveId(req.questionSetId)) {
      return 'questionSetId: invalid';
    }
    if (
      req.cardIds !== undefined &&
      !(
        Array.isArray(req.cardIds) &&
        req.cardIds.length <= MAX_CARD_IDS &&
        req.cardIds.every(isPositiveId)
      )
    ) {
      return 'cardIds: invalid';
    }
    if (req.deadlineMs !== undefined && !Number.isFinite(req.deadlineMs)) {
      return 'deadlineMs: invalid';
    }
    const check = validateRequest(req, requestLimits);
    return check.ok ? undefined : check.detail;
  }

  // ── Credentials and breaker ───────────────────────────────────────────────────────────────────

  /** Whether a provider has a usable credential (metadata only; spec 04 §5 step 1). */
  async function credentialState(
    provider: CredentialProvider,
  ): Promise<{ available: true } | { available: false; reason: string }> {
    try {
      const meta = await credentials.metadata(provider);
      if (meta.source === 'env') return { available: true };
      if (meta.source === 'db' && meta.enabled && meta.activeVersion !== undefined) {
        return { available: true };
      }
      return { available: false, reason: meta.source === 'none' ? 'none' : 'not_active' };
    } catch {
      return { available: false, reason: 'lookup_failed' };
    }
  }

  function circuitOpen(
    engine: PaidEngine,
    admission: Extract<BreakerAdmission, { ok: false }>,
  ): FailedOutcome {
    return failed(
      'circuit_open',
      `${engine}:${admission.auth ? 'auth' : 'open'}`,
      admission.retryAt,
    );
  }

  const cancelledOutcome = (): FailedOutcome => failed('error', 'cancelled', clock.now());

  // ── One wire attempt ──────────────────────────────────────────────────────────────────────────

  async function reserveAndSend(
    run: LaneRun,
    sub: EngineRequest,
    ctx: AskContext,
    auth: ProviderAuth | undefined,
  ): Promise<AttemptResult> {
    if (ctx.signal.aborted) return { kind: 'cancelled' };
    const { lane } = run;
    const estimateUsd = lane.estimateUsd(sub);
    // The eval cap is checked and taken synchronously: the router mutex (spec 04 §1).
    if (evalBudget !== undefined && !evalBudget.tryReserve(estimateUsd)) {
      return { kind: 'eval_budget' };
    }
    let reservationId: string | null;
    try {
      reservationId = await store.reserveSpend({
        day: utcDay(clock.now()),
        engine: lane.name,
        kind: ctx.kind,
        ...(sub.userId === undefined ? {} : { userId: sub.userId }),
        estimateUsd,
        priority: sub.priority,
        ...(run.callCap === undefined ? {} : { callCap: run.callCap }),
        authorization: sub.authorization,
      });
    } catch (error) {
      evalBudget?.cancel(estimateUsd);
      throw error;
    }
    if (reservationId === null) {
      evalBudget?.cancel(estimateUsd);
      return { kind: 'denied' };
    }
    ctx.ordinals[lane.name] += 1;
    const ordinal = ctx.ordinals[lane.name];
    const createdAt = clock.now();
    let attempt: EngineAttempt;
    try {
      attempt = await lane.engine.ask(sub, ctx.signal, auth);
    } catch {
      // Adapters report failures instead of throwing; this one may still have reached the wire.
      attempt = {
        ok: false,
        status: 'error',
        retryable: true,
        detail: 'engine_exception',
        billing: 'uncertain',
      };
    }
    return {
      kind: 'sent',
      attempt,
      ordinal,
      reservationId,
      reservedUsd: estimateUsd,
      createdAt,
      credentialVersion: auth?.credentialVersion,
      authenticated: auth !== undefined,
    };
  }

  /** Resolve the credential for this attempt only; the secret stays inside the callback. */
  async function withCredential(
    run: LaneRun,
    sub: EngineRequest,
    ctx: AskContext,
  ): Promise<AttemptResult> {
    if (run.withoutCredential) return reserveAndSend(run, sub, ctx, undefined);
    let invoked = false;
    try {
      return await credentials.useActive(run.lane.provider, ctx.signal, (auth) => {
        invoked = true;
        return reserveAndSend(run, sub, ctx, auth);
      });
    } catch (error) {
      if (invoked) throw error;
      if (run.lane.injected) return reserveAndSend(run, sub, ctx, undefined);
      return { kind: 'no_credential', reason: unavailableReason(error) };
    }
  }

  async function attemptOnce(
    run: LaneRun,
    sub: EngineRequest,
    ctx: AskContext,
  ): Promise<AttemptResult> {
    const { lane } = run;
    const { signal } = ctx;
    if (signal.aborted) return { kind: 'cancelled' };
    const wait = sub.deadlineMs === undefined ? { signal } : { signal, deadlineMs: sub.deadlineMs };
    if (lane.limiter !== undefined) {
      const rate = await lane.limiter.acquire({
        tokens: lane.rateTokens(sub),
        priority: sub.priority,
        ...wait,
      });
      if (!rate.ok) {
        return rate.reason === 'cancelled'
          ? { kind: 'cancelled' }
          : { kind: 'deferred', retryAt: rate.retryAt, detail: 'deferred:rate_limit' };
      }
    }
    const releases: Array<() => void> = [];
    try {
      for (const semaphore of lane.semaphores) {
        const slot = await semaphore.acquire(sub.priority, wait);
        if (!slot.ok) {
          return slot.reason === 'cancelled'
            ? { kind: 'cancelled' }
            : {
                kind: 'deferred',
                retryAt: new Date(nowMs() + CAPACITY_RETRY_MS),
                detail: 'deferred:concurrency',
              };
        }
        releases.push(slot.release);
      }
      return await withCredential(run, sub, ctx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async function settleWithRetry(
    id: string,
    call: EngineCallRow,
    usage: UsageRow,
    billing: 'known' | 'uncertain',
  ): Promise<void> {
    for (let tries = 1; ; tries += 1) {
      try {
        await store.settleReservation(id, call, usage, billing);
        return;
      } catch (error) {
        if (tries >= SETTLE_TRIES) {
          // The reservation stays charged (reserved, later uncertain) until housekeeping settles it.
          logger.error(
            {
              engine: call.engine,
              reservationId: id,
              logicalRequestId: call.logicalRequestId,
              err: errorLabel(error),
            },
            'engine attempt settlement failed; its reservation stays charged',
          );
          return;
        }
      }
    }
  }

  /** Settle one sent attempt: its call row, rollup and reservation (spec 04 §6). */
  async function settle(
    run: LaneRun,
    sub: EngineRequest,
    ctx: AskContext,
    sent: Extract<AttemptResult, { kind: 'sent' }>,
  ): Promise<{ overrun: boolean }> {
    const { lane } = run;
    const { attempt } = sent;
    const usage: Usage | undefined = attempt.usage;
    const billing = attempt.ok ? 'known' : attempt.billing;
    const known = billing === 'known';
    // Unknown billing is never invented: the reservation stays charged as uncertain instead.
    const cost = !known
      ? 0
      : attempt.ok
        ? attempt.costUsd
        : usage === undefined
          ? 0
          : lane.costUsd(usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const call: EngineCallRow = {
      engine: lane.name,
      kind: ctx.kind,
      model: attempt.ok ? attempt.model : lane.model,
      ...(sub.articleId === undefined ? {} : { articleId: sub.articleId }),
      ...(sub.questionSetId === undefined ? {} : { questionSetId: sub.questionSetId }),
      ...(sub.cardIds === undefined ? {} : { cardIds: sub.cardIds }),
      ...(sub.userId === undefined ? {} : { userId: sub.userId }),
      nQuestions: Object.keys(sub.questions).length,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs: attempt.ok ? attempt.latencyMs : Math.max(0, nowMs() - sent.createdAt.getTime()),
      billing,
      logicalRequestId: ctx.logicalRequestId,
      reservationId: sent.reservationId,
      ...(sub.articleRevision === undefined ? {} : { articleRevision: sub.articleRevision }),
      stateSha256: sub.stateSha256,
      ...(sent.credentialVersion === undefined
        ? {}
        : { credentialVersion: sent.credentialVersion }),
      attempts: sent.ordinal,
      status: attempt.ok ? 'ok' : attempt.status,
      ...(attempt.ok || attempt.detail === undefined ? {} : { error: attempt.detail }),
      createdAt: sent.createdAt,
    };
    const usageRow: UsageRow = {
      day: utcDay(sent.createdAt),
      userId: attributionUserId(sub.userId),
      engine: lane.name,
      kind: ctx.kind,
      calls: 1,
      inputTokens,
      outputTokens,
      costUsd: cost,
    };
    await settleWithRetry(sent.reservationId, call, usageRow, billing);
    evalBudget?.settle(sent.reservedUsd, known ? cost : null);
    run.spent.inputTokens += inputTokens;
    run.spent.outputTokens += outputTokens;
    run.spent.costUsd += cost;
    const overrun = known && cost > sent.reservedUsd + USD_EPSILON;
    if (overrun) {
      // Spec 04 §6: actual usage above a reserve stops further calls (of this request) and alerts.
      logger.warn(
        {
          engine: lane.name,
          logicalRequestId: ctx.logicalRequestId,
          reservedUsd: sent.reservedUsd,
          actualUsd: cost,
        },
        'engine attempt cost exceeded its reservation',
      );
    }
    return { overrun };
  }

  /** Why a reservation was refused: demand, the daily call cap, or the budget. */
  async function denialReason(
    run: LaneRun,
    ctx: AskContext,
  ): Promise<'no_demand' | 'cap' | 'budget'> {
    if (!(await store.authorizeInference(ctx.req.authorization))) return 'no_demand';
    if (run.callCap !== undefined) {
      const snapshot = await store.getBudgetSnapshot(utcDay(clock.now()), {
        excludeKinds: 'none',
      });
      if (capGroupCalls(snapshot.callsByEngineKind, run.lane.name, ctx.kind) >= run.callCap) {
        return 'cap';
      }
    }
    return 'budget';
  }

  const attemptDetail = (lane: Lane, attempt: FailedAttempt): string =>
    `${lane.name}:${attempt.status}${attempt.detail === undefined ? '' : `:${attempt.detail}`}`;

  // ── A (sub)pack with its retries ──────────────────────────────────────────────────────────────

  async function runPack(run: LaneRun, questions: Questions, ctx: AskContext): Promise<PackResult> {
    const { lane } = run;
    const sub: EngineRequest =
      questions === ctx.req.questions ? ctx.req : { ...ctx.req, questions };
    const fail = (outcome: FailedOutcome, verdict: BreakerOutcome): PackResult => ({
      ok: false,
      outcome,
      breaker: verdict,
    });
    let invalidResponseRetries = 0;
    let delayMs = 0;
    for (let n = 1; ; n += 1) {
      if (n > 1) {
        const retryAtMs = nowMs() + delayMs;
        const deadline = sub.deadlineMs;
        if ((deadline !== undefined && retryAtMs > deadline) || delayMs > maxRetryWaitMs) {
          // Defer to the queue instead of waiting past the job deadline (spec 04 §4).
          return fail(failed('error', 'deferred:retry_after', new Date(retryAtMs)), 'failure');
        }
        if (!(await sleep(delayMs, ctx.signal))) return fail(cancelledOutcome(), 'neutral');
        if (run.probeToken === undefined) {
          // Check the shared state again before every paid attempt (spec 04 §5).
          const admission = await breaker.admit(lane.name);
          if (!admission.ok) return fail(circuitOpen(lane.name, admission), 'failure');
          run.probeToken = admission.probeToken;
        }
      }
      const result = await attemptOnce(run, sub, ctx);
      switch (result.kind) {
        case 'cancelled':
          return fail(cancelledOutcome(), 'neutral');
        case 'deferred':
          return fail(
            failed('error', result.detail, result.retryAt),
            n > 1 ? 'failure' : 'neutral',
          );
        case 'no_credential':
          return fail(failed('no_key', `${lane.provider}:${result.reason}`), 'neutral');
        case 'eval_budget':
          return fail(failed('budget', 'eval_budget'), 'neutral');
        case 'denied': {
          const why = await denialReason(run, ctx);
          if (why === 'no_demand') return fail(failed('no_demand', 'demand_lost'), 'neutral');
          const detail = why === 'cap' ? `${lane.name}_daily_cap` : 'daily_budget';
          return fail(failed('budget', detail, nextUtcDay(clock.now())), 'neutral');
        }
        case 'sent':
          break;
      }
      const { overrun } = await settle(run, sub, ctx, result);
      const attempt = result.attempt;
      if (attempt.ok) return { ok: true, attempt };
      if (ctx.signal.aborted) return fail(cancelledOutcome(), 'neutral');
      if (attempt.status === 'auth_error') {
        // Auth mode (spec 04 §5), unless this credential version was superseded meanwhile.
        if (result.authenticated) {
          await breaker.authFailure(lane.name, {
            provider: lane.provider,
            version: result.credentialVersion ?? null,
          });
        }
        return fail(failed('error', attemptDetail(lane, attempt)), 'neutral');
      }
      if (attempt.status === 'invalid_request') {
        return fail(failed('invalid_request', attemptDetail(lane, attempt)), 'neutral');
      }
      if (attempt.status === 'rate_limited') lane.limiter?.penalize(attempt.retryAfterMs);
      const decision = overrun
        ? ({ retry: false } as const)
        : decideRetry(
            {
              engine: lane.name,
              attempt: n,
              status: attempt.status,
              retryable: attempt.retryable,
              ...(attempt.retryAfterMs === undefined ? {} : { retryAfterMs: attempt.retryAfterMs }),
              invalidResponseRetries,
            },
            random,
          );
      if (attempt.status === 'invalid_response') invalidResponseRetries += 1;
      if (!decision.retry) return fail(failed('error', attemptDetail(lane, attempt)), 'failure');
      delayMs = decision.delayMs;
    }
  }

  // ── One engine for the logical request ────────────────────────────────────────────────────────

  async function runLane(lane: Lane, packs: Questions[], ctx: AskContext): Promise<LaneResult> {
    if (ctx.signal.aborted) return { ok: false, outcome: cancelledOutcome() };
    const credential = await credentialState(lane.provider);
    if (!credential.available && !lane.injected) {
      return { ok: false, outcome: failed('no_key', `${lane.provider}:${credential.reason}`) };
    }
    const admission = await breaker.admit(lane.name);
    if (!admission.ok) return { ok: false, outcome: circuitOpen(lane.name, admission) };
    const run: LaneRun = {
      lane,
      probeToken: admission.probeToken,
      callCap: undefined,
      withoutCredential: !credential.available,
      spent: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    // The logical request's verdict for this provider's breaker window (spec 04 §5).
    let verdict: BreakerOutcome = 'neutral';
    try {
      if (lane.name === 'llm' && !ignoreDailyCaps)
        run.callCap = await dailyCap('engine.llm_daily_cap');
      const answers: Array<[string, Answer]> = [];
      let latencyMs = 0;
      let model = lane.model;
      for (const pack of packs) {
        const result = await runPack(run, pack, ctx);
        if (!result.ok) {
          verdict = result.breaker;
          return { ok: false, outcome: result.outcome };
        }
        answers.push(...Object.entries(result.attempt.answers));
        latencyMs += result.attempt.latencyMs;
        model = result.attempt.model;
      }
      const merged = Object.fromEntries(answers);
      if (!Object.keys(ctx.req.questions).every((key) => Object.hasOwn(merged, key))) {
        verdict = 'failure';
        return { ok: false, outcome: failed('error', `${lane.name}:incomplete_answers`) };
      }
      verdict = 'success';
      return {
        ok: true,
        outcome: {
          ok: true,
          engine: lane.name,
          model,
          answers: merged,
          // Every wire attempt of this engine in the logical request, failed ones included.
          usage: { inputTokens: run.spent.inputTokens, outputTokens: run.spent.outputTokens },
          costUsd: run.spent.costUsd,
          latencyMs,
        },
      };
    } finally {
      try {
        await breaker.record(lane.name, verdict, run.probeToken);
      } catch (error) {
        logger.warn({ engine: lane.name, err: errorLabel(error) }, 'engine breaker update failed');
      }
    }
  }

  /** Local Laya (M9): free, one attempt, recorded as a zero-cost call. */
  async function runLaya(ctx: AskContext): Promise<EngineOutcome> {
    const engine = deps.engines?.laya;
    if (engine === undefined) return failed('error', 'laya:not_configured');
    const { req } = ctx;
    const wait =
      req.deadlineMs === undefined
        ? { signal: ctx.signal }
        : { signal: ctx.signal, deadlineMs: req.deadlineMs };
    const slot = await engineSlots.acquire(req.priority, wait);
    if (!slot.ok) {
      return slot.reason === 'cancelled'
        ? cancelledOutcome()
        : failed('error', 'deferred:concurrency', new Date(nowMs() + CAPACITY_RETRY_MS));
    }
    ctx.ordinals.laya += 1;
    const createdAt = clock.now();
    let attempt: EngineAttempt;
    try {
      attempt = await engine.ask(req, ctx.signal);
    } catch {
      attempt = {
        ok: false,
        status: 'error',
        retryable: false,
        detail: 'engine_exception',
        billing: 'known',
      };
    } finally {
      slot.release();
    }
    await store.insertCall({
      engine: 'laya',
      kind: ctx.kind,
      ...(attempt.ok ? { model: attempt.model } : {}),
      ...(req.articleId === undefined ? {} : { articleId: req.articleId }),
      ...(req.questionSetId === undefined ? {} : { questionSetId: req.questionSetId }),
      ...(req.cardIds === undefined ? {} : { cardIds: req.cardIds }),
      ...(req.userId === undefined ? {} : { userId: req.userId }),
      nQuestions: Object.keys(req.questions).length,
      inputTokens: attempt.usage?.inputTokens ?? 0,
      outputTokens: attempt.usage?.outputTokens ?? 0,
      costUsd: 0,
      latencyMs: attempt.ok ? attempt.latencyMs : Math.max(0, nowMs() - createdAt.getTime()),
      billing: 'known',
      logicalRequestId: ctx.logicalRequestId,
      ...(req.articleRevision === undefined ? {} : { articleRevision: req.articleRevision }),
      stateSha256: req.stateSha256,
      attempts: ctx.ordinals.laya,
      status: attempt.ok ? 'ok' : attempt.status,
      ...(attempt.ok || attempt.detail === undefined ? {} : { error: attempt.detail }),
      createdAt,
    });
    if (attempt.ok) return { ...attempt, costUsd: 0 };
    if (ctx.signal.aborted) return cancelledOutcome();
    return attempt.status === 'invalid_request'
      ? failed('invalid_request', `laya:${attempt.status}`)
      : failed('error', `laya:${attempt.status}`);
  }

  async function runPinned(engine: EngineName, ctx: AskContext): Promise<EngineOutcome> {
    if (engine === 'laya') return runLaya(ctx);
    if (engine === 'typesafe') {
      if (typesafeLane === undefined) return failed('no_key', 'typesafe:not_configured');
      return (await runLane(typesafeLane, [ctx.req.questions], ctx)).outcome;
    }
    if (llmLane === undefined) return failed('no_key', 'ollama:not_configured');
    const packs = splitQuestionsForLlm(ctx.req.questions, maxOutputTokens);
    if (packs === null) return failed('invalid_request', 'llm: a question exceeds the output cap');
    return (await runLane(llmLane, packs, ctx)).outcome;
  }

  /** Whether a primary failure may move on to the fallback (spec 04 §5 steps 4–5). */
  function fallbackAfter(outcome: FailedOutcome): boolean {
    // Never route an invalid request elsewhere; lost demand and cancellation end the request; a
    // budget refusal of the cheaper Jev reservation would refuse the LLM's too.
    return (
      outcome.reason !== 'invalid_request' &&
      outcome.reason !== 'no_demand' &&
      outcome.reason !== 'budget' &&
      outcome.detail !== 'cancelled'
    );
  }

  // ── The router ────────────────────────────────────────────────────────────────────────────────

  return {
    async ask(req, signal) {
      const abort = signal ?? new AbortController().signal;
      const problem = requestProblem(req);
      if (problem !== undefined) return failed('invalid_request', problem);
      if (abort.aborted) return cancelledOutcome();
      // Live demand before any dispatch (spec 04 §1.1); paid admission rechecks it atomically.
      if (!(await store.authorizeInference(req.authorization))) {
        return failed('no_demand', 'demand_lost');
      }
      const ctx: AskContext = {
        req,
        kind: evalRouter ? 'eval' : req.kind,
        signal: abort,
        logicalRequestId: newId(),
        ordinals: { typesafe: 0, llm: 0, laya: 0 },
      };
      if (pinned !== undefined) return runPinned(pinned, ctx);

      const primary: LaneResult =
        typesafeLane === undefined
          ? { ok: false, outcome: failed('no_key', 'typesafe:not_configured') }
          : await runLane(typesafeLane, [req.questions], ctx);
      if (primary.ok) return primary.outcome;
      const outcome = primary.outcome;
      if (
        llmLane === undefined ||
        !config.llmFallbackEnabled ||
        req.priority !== 'interactive' ||
        !fallbackAfter(outcome)
      ) {
        return outcome;
      }
      const packs = splitQuestionsForLlm(req.questions, maxOutputTokens);
      if (packs === null) {
        logger.warn(
          { logicalRequestId: ctx.logicalRequestId, kind: req.kind },
          'engine LLM fallback skipped: a question exceeds its output cap',
        );
        return outcome;
      }
      const fallback = await runLane(llmLane, packs, ctx);
      if (fallback.ok) {
        logger.info(
          {
            logicalRequestId: ctx.logicalRequestId,
            kind: req.kind,
            primary: outcome.reason,
            packs: packs.length,
          },
          'engine request answered by the LLM fallback',
        );
        return fallback.outcome;
      }
      if (fallback.outcome.reason === 'no_demand') return fallback.outcome;
      logger.warn(
        {
          logicalRequestId: ctx.logicalRequestId,
          kind: req.kind,
          primary: outcome.reason,
          fallback: fallback.outcome.reason,
          detail: fallback.outcome.detail,
        },
        'engine LLM fallback failed',
      );
      // Jev's state decides when the work is retried; the fallback's answers are provisional anyway.
      return outcome;
    },

    async status(): Promise<RouterStatus> {
      const metadata = async (provider: CredentialProvider) => {
        try {
          const meta = await credentials.metadata(provider);
          return {
            source: meta.source,
            enabled: meta.enabled,
            ...(meta.activeVersion === undefined ? {} : { activeVersion: meta.activeVersion }),
          };
        } catch {
          return { source: 'none' as const, enabled: false };
        }
      };
      const [typesafe, ollama, breakers, snapshot, budget] = await Promise.all([
        metadata('typesafe'),
        metadata('ollama'),
        breaker.states(),
        store.getBudgetSnapshot(utcDay(clock.now()), { excludeKinds: ['eval'] }),
        budgetUsd(),
      ]);
      return {
        credentials: { typesafe, ollama },
        breakers,
        spendTodayUsd: committedSpendUsd(snapshot),
        budgetUsd: budget,
        llmCallsToday: capGroupCalls(snapshot.callsByEngineKind, 'llm', 'enrich'),
      };
    },

    async canSpend(estimateUsd, priority) {
      if (!Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
      if (evalBudget !== undefined) return estimateUsd <= evalBudget.remainingUsd + USD_EPSILON;
      const [snapshot, budget] = await Promise.all([
        store.getBudgetSnapshot(utcDay(clock.now()), { excludeKinds: ['eval'] }),
        budgetUsd(),
      ]);
      return admitsSpend({
        committedUsd: committedSpendUsd(snapshot),
        estimateUsd,
        budgetUsd: budget,
        priority,
      });
    },

    async reserveExternalCall(input) {
      if (!Number.isFinite(input.estimateUsd) || input.estimateUsd < 0) {
        throw new RangeError('estimateUsd must be a finite non-negative amount');
      }
      // Eval spend is only admitted by an eval router, under its invocation cap.
      if (!evalRouter && input.kind === 'eval') return null;
      const kind: CallKind = evalRouter ? 'eval' : input.kind;
      if (evalBudget !== undefined && !evalBudget.tryReserve(input.estimateUsd)) return null;
      let id: string | null;
      try {
        const callCap =
          input.engine === 'llm' && input.kind === 'translate' && !ignoreDailyCaps
            ? await dailyCap('translate.tier2_daily_cap')
            : undefined;
        id = await store.reserveSpend({
          day: utcDay(clock.now()),
          engine: input.engine,
          kind,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
          estimateUsd: input.estimateUsd,
          priority: input.priority,
          ...(callCap === undefined ? {} : { callCap }),
          authorization: input.authorization,
        });
      } catch (error) {
        evalBudget?.cancel(input.estimateUsd);
        throw error;
      }
      if (id === null) {
        evalBudget?.cancel(input.estimateUsd);
        return null;
      }
      if (external.size >= MAX_TRACKED_RESERVATIONS) {
        const oldest = external.keys().next();
        if (oldest.done !== true) external.delete(oldest.value);
      }
      external.set(id, { estimateUsd: input.estimateUsd, userId: input.userId });
      return id;
    },

    async recordExternalCall(call: ExternalCall, reservationId?: string) {
      const kind: CallKind = evalRouter ? 'eval' : call.kind;
      const known = call.billing === 'known';
      const tracked = reservationId === undefined ? undefined : external.get(reservationId);
      const userId = tracked?.userId;
      // `created_at` is the send time (spec 04 §6): the attempt began `latencyMs` ago.
      const createdAt = new Date(nowMs() - Math.max(0, Math.round(call.latencyMs)));
      const cost = known ? call.costUsd : 0;
      const row: EngineCallRow = {
        engine: call.engine,
        kind,
        ...(call.model === undefined ? {} : { model: call.model }),
        ...(call.articleId === undefined ? {} : { articleId: call.articleId }),
        ...(userId === undefined ? {} : { userId }),
        nQuestions: 0,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costUsd: cost,
        latencyMs: call.latencyMs,
        billing: call.billing,
        logicalRequestId: call.logicalRequestId,
        ...(reservationId === undefined ? {} : { reservationId }),
        ...(call.articleRevision === undefined ? {} : { articleRevision: call.articleRevision }),
        ...(call.stateSha256 === undefined ? {} : { stateSha256: call.stateSha256 }),
        ...(call.credentialVersion === undefined
          ? {}
          : { credentialVersion: call.credentialVersion }),
        attempts: call.attempt,
        status: call.status,
        ...(call.error === undefined ? {} : { error: capDetail(call.error) }),
        createdAt,
      };
      if (reservationId === undefined) {
        // Paid external calls MUST reserve before HTTP (spec 04 §1); only free calls land here.
        if (call.engine !== 'libretranslate' || call.costUsd !== 0) {
          throw new RangeError('a paid external call must be recorded with its reservation');
        }
        await store.insertCall(row);
        return;
      }
      await store.settleReservation(
        reservationId,
        row,
        {
          day: utcDay(createdAt),
          userId: attributionUserId(userId),
          engine: call.engine,
          kind,
          calls: 1,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          costUsd: cost,
        },
        call.billing,
      );
      if (tracked !== undefined) {
        external.delete(reservationId);
        evalBudget?.settle(tracked.estimateUsd, known ? cost : null);
      }
    },
  };
}
