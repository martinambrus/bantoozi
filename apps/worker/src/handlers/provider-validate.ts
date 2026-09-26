import {
  claimCredentialValidation,
  completeCredentialValidation,
  type Database,
  type ValidationResult,
} from '@bantoozi/db';
import {
  backoffDelayMs,
  createLlmFallbackEngine,
  createTypeSafeEngine,
  estimateLlmCostUsd,
  estimateLlmInputTokens,
  JEV_FAKE_MODEL,
  llmCostUsd,
  sleep,
  typesafeCostUsd,
  type Answer,
  type DecisionEngine,
  type EngineAttempt,
  type EngineRequest,
  type EngineRouter,
  type ExternalCall,
  type Question,
} from '@bantoozi/engine';
import {
  canonicalJson,
  conservativeRequestTokens,
  isAppError,
  newUuid,
  type CandidateValidation,
} from '@bantoozi/shared';
import { sha256Hex, type Config, type CredentialResolver } from '@bantoozi/shared/server';

import { providerConfigFingerprint } from '../credentials/fingerprint.js';
import type { CredentialProvider } from '../credentials/resolver.js';
import type { HandlerLogger } from './deps.js';
import type { QueueHandler } from './index.js';

/**
 * `provider.validate {provider, candidateVersion}` (spec 04 §1.2 step 2): claim the candidate's
 * validation lease, probe the expected provider with **synthetic data only** through the candidate
 * key (`useCandidate`), and record `valid`/`invalid` with sanitized capability metadata and the
 * configuration fingerprint that activation compares.
 *
 * Bounds: at most 3 HTTP attempts, at most $0.02 of reserved spend in total (each attempt reserves
 * through the router's normal spend guard with `kind = 'credential_probe'` and the
 * `credential_probe` authorization, which the store admits only under the live lease), LLM output
 * capped at 512 tokens. A bound that stops the probe, an exhausted platform budget or an unavailable
 * provider records the candidate `pending` with a clear error code (inconclusive: the admin may
 * validate again); an authentication or request rejection records it `invalid`. The probe never
 * goes through `router.ask`, so it never touches the active credential's breaker. A lease lost
 * to revocation or re-staging discards the result.
 */

/** Spec 04 §1.2: attempts and reserved spend of one validation action. */
export const MAX_PROBE_ATTEMPTS = 3;
export const MAX_PROBE_SPEND_USD = 0.02;
/** `num_predict` of the Ollama probe (spec 04 §1.2). */
export const PROBE_MAX_OUTPUT_TOKENS = 512;
/** Covers three LLM attempts (60 s each) plus backoff. */
export const DEFAULT_VALIDATION_LEASE_MS = 5 * 60_000;
/** A server wait longer than this defers the validation instead of holding the lease. */
export const MAX_PROBE_WAIT_MS = 10_000;
/**
 * In-flight attempts are cancelled this long before the lease expires; a lease shorter than four
 * margins keeps a quarter of itself instead, so every accepted lease leaves time to probe.
 */
const LEASE_MARGIN_MS = 15_000;

/** Synthetic probe content (never reader data). */
export const PROBE_STATE = {
  article: {
    title: 'Solar panels on a school roof',
    excerpt: 'A synthetic sentence used to check a provider credential.',
  },
};

/** Jev: one question of each type (spec 04 §1.2). */
export const TYPESAFE_PROBE_QUESTIONS: Record<string, Question> = {
  noul: { type: 'noul', instructions: 'Is the text about energy?' },
  choice: {
    type: 'choice',
    instructions: 'What is the main topic of the text?',
    criteria: { energy: 'Energy', sport: 'Sport' },
  },
  score: {
    type: 'score',
    instructions: 'How technical is the text?',
    criteria: ['Not technical', 'Somewhat technical', 'Very technical'],
  },
};

/** Ollama: one tiny chat with a single yes/no question. */
export const OLLAMA_PROBE_QUESTIONS: Record<string, Question> = {
  noul: { type: 'noul', instructions: 'Is the text about energy?' },
};

/** The host configuration the probe uses (spec 01 §3 names). */
export type ProviderProbeConfig = Pick<
  Config,
  | 'nodeEnv'
  | 'typesafeBaseUrl'
  | 'typesafeModel'
  | 'typesafePricePerMtokUsd'
  | 'ollamaBaseUrl'
  | 'ollamaModelFast'
  | 'ollamaModelStrong'
>;

export interface ProviderValidateDeps {
  db: Database;
  /** The worker's router: reserves and records every probe attempt (spend guard, audit). */
  router: EngineRouter;
  /** The worker's credential resolver (`useCandidate`). */
  credentials: CredentialResolver;
  config: ProviderProbeConfig;
  logger: HandlerLogger;
  /** Test seams: probe adapters, the lease, the clock and retry jitter. */
  engines?: Partial<Record<CredentialProvider, DecisionEngine>>;
  leaseMs?: number;
  now?: () => Date;
  random?: () => number;
}

interface ProbeLane {
  engine: 'typesafe' | 'llm';
  adapter: DecisionEngine;
  model: string;
  questions: Record<string, Question>;
  /** The reserve of one attempt: the conservative input estimate (plus the LLM output cap). */
  estimateUsd: number;
  costUsd(usage: { inputTokens: number; outputTokens: number }): number;
  capabilities(answers: Record<string, Answer>): Record<string, boolean>;
}

type FailedAttempt = Extract<EngineAttempt, { ok: false }>;

type SendResult =
  | { kind: 'sent'; attempt: EngineAttempt; latencyMs: number }
  | { kind: 'denied' }
  | { kind: 'unavailable'; reason: string };

export function createProviderValidateHandler(
  deps: ProviderValidateDeps,
): QueueHandler<'provider.validate'> {
  const { db, router, credentials, config, logger } = deps;
  const leaseMs = deps.leaseMs ?? DEFAULT_VALIDATION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000) {
    throw new RangeError('leaseMs must be at least 5 seconds');
  }
  const abortAfterMs = leaseMs - Math.min(LEASE_MARGIN_MS, Math.floor(leaseMs / 4));
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const production = config.nodeEnv === 'production';
  const lanes: Partial<Record<CredentialProvider, ProbeLane>> = {
    ...optionalLane('typesafe', () => typesafeLane()),
    ...optionalLane('ollama', () => ollamaLane()),
  };

  function optionalLane(
    provider: CredentialProvider,
    build: () => ProbeLane,
  ): Partial<Record<CredentialProvider, ProbeLane>> {
    try {
      return { [provider]: build() };
    } catch (error) {
      logger.error(
        { provider, err: error instanceof Error ? error.message : 'unknown' },
        'provider probe is not configured; validations stay pending',
      );
      return {};
    }
  }

  function typesafeLane(): ProbeLane {
    const price = config.typesafePricePerMtokUsd;
    const adapter =
      deps.engines?.typesafe ??
      createTypeSafeEngine({
        baseUrl: config.typesafeBaseUrl,
        model: config.typesafeModel,
        pricePerMTokUsd: price,
        production,
        // The fake server's model is the explicit test configuration (spec 04 §3).
        ...(!production && config.typesafeModel === JEV_FAKE_MODEL ? { allowFakeModel: true } : {}),
      });
    return {
      engine: 'typesafe',
      adapter,
      model: config.typesafeModel,
      questions: TYPESAFE_PROBE_QUESTIONS,
      estimateUsd: typesafeCostUsd(
        conservativeRequestTokens(PROBE_STATE, TYPESAFE_PROBE_QUESTIONS),
        price,
      ),
      costUsd: (usage) => typesafeCostUsd(usage.inputTokens, price),
      capabilities: (answers) => ({
        systemone: true,
        noul: answers['noul']?.type === 'noul',
        choice: answers['choice']?.type === 'choice',
        score: answers['score']?.type === 'score',
      }),
    };
  }

  function ollamaLane(): ProbeLane {
    const model = config.ollamaModelFast;
    const adapter =
      deps.engines?.ollama ??
      createLlmFallbackEngine({
        baseUrl: config.ollamaBaseUrl,
        model,
        maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
        production,
      });
    return {
      engine: 'llm',
      adapter,
      model,
      questions: OLLAMA_PROBE_QUESTIONS,
      estimateUsd: estimateLlmCostUsd(
        estimateLlmInputTokens(PROBE_STATE, OLLAMA_PROBE_QUESTIONS),
        PROBE_MAX_OUTPUT_TOKENS,
        model,
      ),
      costUsd: (usage) => llmCostUsd(usage, model),
      capabilities: () => ({ chat: true, json_answers: true }),
    };
  }

  function probeRequest(
    provider: CredentialProvider,
    candidateVersion: string,
    questions: Record<string, Question>,
  ): EngineRequest {
    return {
      // Adapters ignore the kind; the attempt is recorded as `credential_probe` by the router.
      kind: 'eval',
      state: PROBE_STATE,
      questions,
      questionSetSha: sha256Hex(canonicalJson(questions)),
      stateSha256: sha256Hex(canonicalJson(PROBE_STATE)),
      priority: 'interactive',
      authorization: { type: 'credential_probe', provider, candidateVersion },
    };
  }

  function externalCall(
    lane: ProbeLane,
    attempt: EngineAttempt,
    latencyMs: number,
    logicalRequestId: string,
    ordinal: number,
    request: EngineRequest,
    candidateVersion: string,
  ): ExternalCall {
    const { usage } = attempt;
    return {
      engine: lane.engine,
      kind: 'credential_probe',
      model: attempt.ok ? attempt.model : lane.model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsd: attempt.ok ? attempt.costUsd : usage === undefined ? 0 : lane.costUsd(usage),
      latencyMs,
      status: attempt.ok ? 'ok' : attempt.status,
      ...(attempt.ok || attempt.detail === undefined ? {} : { error: attempt.detail }),
      billing: attempt.ok ? 'known' : attempt.billing,
      logicalRequestId,
      attempt: ordinal,
      stateSha256: request.stateSha256,
      credentialVersion: candidateVersion,
    };
  }

  /** One wire attempt with the candidate key: reserve, send, record (the router's order). */
  async function sendOnce(
    lane: ProbeLane,
    request: EngineRequest,
    provider: CredentialProvider,
    candidateVersion: string,
    validationToken: string,
    logicalRequestId: string,
    ordinal: number,
    signal: AbortSignal,
  ): Promise<SendResult> {
    let invoked = false;
    try {
      return await credentials.useCandidate(
        provider,
        candidateVersion,
        validationToken,
        signal,
        async (auth): Promise<SendResult> => {
          invoked = true;
          const reservationId = await router.reserveExternalCall({
            engine: lane.engine,
            kind: 'credential_probe',
            estimateUsd: lane.estimateUsd,
            priority: 'interactive',
            authorization: request.authorization,
          });
          if (reservationId === null) return { kind: 'denied' };
          const started = now().getTime();
          let attempt: EngineAttempt;
          try {
            attempt = await lane.adapter.ask(request, signal, auth);
          } catch {
            // Adapters report failures; this one may still have reached the wire.
            attempt = {
              ok: false,
              status: 'error',
              retryable: true,
              detail: 'engine_exception',
              billing: 'uncertain',
            };
          }
          const latencyMs = Math.max(0, now().getTime() - started);
          await router.recordExternalCall(
            externalCall(
              lane,
              attempt,
              latencyMs,
              logicalRequestId,
              ordinal,
              request,
              candidateVersion,
            ),
            reservationId,
          );
          return { kind: 'sent', attempt, latencyMs };
        },
      );
    } catch (error) {
      if (!invoked && isAppError(error) && error.code === 'ENGINE_UNAVAILABLE') {
        const reason = error.details?.['reason'];
        return { kind: 'unavailable', reason: typeof reason === 'string' ? reason : 'unavailable' };
      }
      throw error;
    }
  }

  function result(
    status: ValidationResult['status'],
    errorCode: string | undefined,
    validation: CandidateValidation,
  ): ValidationResult {
    return {
      status,
      validation: {
        ...validation,
        checkedAt: now().toISOString(),
        ...(errorCode === undefined ? {} : { errorCode }),
      },
      ...(errorCode === undefined ? {} : { errorCode }),
    };
  }

  /** The recorded outcome of retries that ended without an answer. */
  function exhausted(last: FailedAttempt | undefined, base: CandidateValidation) {
    switch (last?.status) {
      case 'invalid_response':
        return result('invalid', 'invalid_response', base);
      case 'rate_limited':
        return result('pending', 'rate_limited', base);
      case 'timeout':
        return result('pending', 'timeout', base);
      default:
        return result('pending', 'provider_unavailable', base);
    }
  }

  /** Probe once per validation action; null when the lease was lost (nothing to record). */
  async function probe(
    provider: CredentialProvider,
    candidateVersion: string,
    validationToken: string,
    signal: AbortSignal,
  ): Promise<ValidationResult | null> {
    const fingerprint = providerConfigFingerprint(provider, config);
    const lane = lanes[provider];
    if (lane === undefined) {
      return result('pending', 'not_configured', { configFingerprint: fingerprint, attempts: 0 });
    }
    const request = probeRequest(provider, candidateVersion, lane.questions);
    const logicalRequestId = newUuid();
    let reservedUsd = 0;
    let attempts = 0;
    let invalidResponses = 0;
    let last: FailedAttempt | undefined;
    const base = (): CandidateValidation => ({
      configFingerprint: fingerprint,
      model: lane.model,
      attempts,
    });

    while (attempts < MAX_PROBE_ATTEMPTS) {
      // The action's spend bound is checked before any wait: a probe that cannot afford another
      // attempt stops at once.
      if (reservedUsd + lane.estimateUsd > MAX_PROBE_SPEND_USD + 1e-12) {
        return result('pending', 'probe_budget_exceeded', base());
      }
      if (attempts > 0) {
        const delay = Math.max(backoffDelayMs(attempts + 1, random), last?.retryAfterMs ?? 0);
        // A long server wait defers the validation instead of holding the lease.
        if (delay > MAX_PROBE_WAIT_MS) break;
        if (!(await sleep(delay, signal))) return result('pending', 'timeout', base());
      }
      const sent = await sendOnce(
        lane,
        request,
        provider,
        candidateVersion,
        validationToken,
        logicalRequestId,
        attempts + 1,
        signal,
      );
      if (sent.kind === 'unavailable') {
        if (sent.reason === 'lease_lost') return null;
        // The stored candidate cannot be opened with this host's keyring: not a usable key.
        if (sent.reason === 'decrypt_failed') return result('invalid', 'decrypt_failed', base());
        return result('pending', reasonCode(sent.reason), base());
      }
      if (sent.kind === 'denied') return result('pending', 'budget_unavailable', base());
      reservedUsd += lane.estimateUsd;
      attempts += 1;
      const { attempt } = sent;
      if (attempt.ok) {
        return result('valid', undefined, {
          ...base(),
          model: attempt.model,
          capabilities: lane.capabilities(attempt.answers),
          latencyMs: Math.min(600_000, Math.round(sent.latencyMs)),
        });
      }
      last = attempt;
      if (attempt.status === 'auth_error') return result('invalid', 'auth_rejected', base());
      if (attempt.status === 'invalid_request') {
        return result('invalid', 'request_rejected', base());
      }
      // Cancelled at the lease margin: inconclusive, never a provider error.
      if (signal.aborted) return result('pending', 'timeout', base());
      if (attempt.status === 'invalid_response') {
        invalidResponses += 1;
        if (invalidResponses > 1) break;
      } else if (!attempt.retryable) {
        return result('invalid', 'provider_error', base());
      }
    }
    return exhausted(last, base());
  }

  return async (payload) => {
    const { provider, candidateVersion } = payload;
    const claim = await claimCredentialValidation(db, { provider, candidateVersion, leaseMs });
    if (claim === null) {
      logger.info(
        { provider, candidateVersion },
        'provider validation skipped: the candidate was replaced, revoked or is being validated',
      );
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), abortAfterMs);
    let outcome: ValidationResult | null;
    try {
      outcome = await probe(provider, candidateVersion, claim.validationToken, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === null) {
      logger.info(
        { provider, candidateVersion },
        'provider validation stopped: the lease was lost',
      );
      return;
    }
    const recorded = await completeCredentialValidation(db, {
      provider,
      candidateVersion,
      validationToken: claim.validationToken,
      result: outcome,
    });
    logger.info(
      {
        provider,
        candidateVersion,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        attempts: outcome.validation.attempts ?? 0,
        recorded,
      },
      recorded
        ? 'provider credential validation recorded'
        : 'provider validation result discarded: the lease was lost',
    );
  };
}

/** A resolver reason as a sanitized error code. */
function reasonCode(reason: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'credential_unavailable';
}
