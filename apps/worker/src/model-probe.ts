import {
  countActiveUserModels,
  retryTransaction,
  updateSettingLocked,
  type Database,
} from '@bantoozi/db';
import {
  backoffDelayMs,
  createTypeSafeEngine,
  JEV_FAKE_MODEL,
  sleep,
  typesafeCostUsd,
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
  ENGINE_MODEL_PROBES_MAX,
  EngineModelImpactSchema,
  EngineModelProbesSchema,
  EngineModelProbeSchema,
  isAppError,
  isModelAlias,
  isModelUnavailableDetail,
  MODEL_ID_PATTERN,
  MODEL_PROBE_MAX_SKEW_MS,
  newUuid,
  type EngineModelImpact,
  type EngineModelProbe,
  type InferenceAuthorization,
} from '@bantoozi/shared';
import { sha256Hex, type Config, type CredentialResolver } from '@bantoozi/shared/server';

import type { HandlerLogger } from './handlers/deps.js';

/**
 * The Jev model probe (visible-learning §4.1): one synthetic request asks Jev which concrete model
 * an id maps to. Every wire attempt is reserved under the normal spend guard and recorded as a
 * `model_probe` call; there are at most {@link MODEL_PROBE_MAX_ATTEMPTS} attempts and
 * {@link MODEL_PROBE_MAX_SPEND_USD} reserved in total. It never goes through `router.ask`, so it
 * never touches the circuit breaker, and it sends no user data.
 */

export const MODEL_PROBE_MAX_ATTEMPTS = 2;
export const MODEL_PROBE_MAX_SPEND_USD = 0.002;
/** A server wait longer than this ends the probe instead of holding the job. */
const MAX_PROBE_WAIT_MS = 5_000;

export const MODEL_PROBE_STATE = {
  article: {
    title: 'Solar panels on a school roof',
    excerpt: 'A synthetic sentence used to check a model.',
  },
};

export const MODEL_PROBE_QUESTIONS: Record<string, Question> = {
  noul: { type: 'noul', instructions: 'Is the text about energy?' },
};

export type ModelProbeConfig = Pick<
  Config,
  'nodeEnv' | 'typesafeBaseUrl' | 'typesafePricePerMtokUsd'
>;

export interface ModelProberDeps {
  ledger: Pick<EngineRouter, 'reserveExternalCall' | 'recordExternalCall' | 'releaseExternalCall'>;
  credentials: Pick<CredentialResolver, 'useActive'>;
  /** Read on every probe, so a changed price applies to the next one. */
  config: ModelProbeConfig;
  logger: HandlerLogger;
  now?: () => Date;
  random?: () => number;
}

export interface ModelProber {
  probe(requested: string, options?: { signal?: AbortSignal }): Promise<EngineModelProbe>;
}

type Sent =
  | { kind: 'sent'; attempt: EngineAttempt; latencyMs: number; overrun: boolean }
  | { kind: 'denied' }
  | { kind: 'cancelled' };

type FailedAttempt = Extract<EngineAttempt, { ok: false }>;

const MISMATCH = /^model_mismatch:(.+)$/;

export function createModelProber(deps: ModelProberDeps): ModelProber {
  const { ledger, credentials, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  const outcome = (
    requested: string,
    ok: boolean,
    extra: { answered?: string; error?: string } = {},
  ): EngineModelProbe => ({
    requested,
    ...(extra.answered === undefined ? {} : { answered: extra.answered }),
    ok,
    at: now().toISOString(),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });

  async function probe(
    requested: string,
    options: { signal?: AbortSignal },
  ): Promise<EngineModelProbe> {
    const fail = (error: string, answered?: string) =>
      outcome(requested, false, { error, ...(answered === undefined ? {} : { answered }) });
    if (!MODEL_ID_PATTERN.test(requested)) return fail('unsupported_model');
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return fail('timeout');

    const price = config.typesafePricePerMtokUsd;
    const production = config.nodeEnv === 'production';
    let adapter: DecisionEngine;
    try {
      adapter = createTypeSafeEngine({
        baseUrl: config.typesafeBaseUrl,
        model: requested,
        pricePerMTokUsd: price,
        production,
        resolveAlias: isModelAlias(requested),
        ...(!production && requested === JEV_FAKE_MODEL ? { allowFakeModel: true } : {}),
      });
    } catch {
      return fail('unsupported_model');
    }
    const estimateUsd = typesafeCostUsd(
      conservativeRequestTokens(MODEL_PROBE_STATE, MODEL_PROBE_QUESTIONS),
      price,
    );
    const authorization: InferenceAuthorization = { type: 'model_probe', model: requested };
    const request: EngineRequest = {
      kind: 'eval',
      state: MODEL_PROBE_STATE,
      questions: MODEL_PROBE_QUESTIONS,
      questionSetSha: sha256Hex(canonicalJson(MODEL_PROBE_QUESTIONS)),
      stateSha256: sha256Hex(canonicalJson(MODEL_PROBE_STATE)),
      priority: 'interactive',
      authorization,
    };
    const logicalRequestId = newUuid();

    const externalCall = (
      attempt: EngineAttempt,
      latencyMs: number,
      ordinal: number,
      credentialVersion: string | undefined,
    ): ExternalCall => {
      const { usage } = attempt;
      return {
        engine: 'typesafe',
        kind: 'model_probe',
        model: attempt.ok ? attempt.model : requested,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: attempt.ok
          ? attempt.costUsd
          : usage === undefined
            ? 0
            : typesafeCostUsd(usage.inputTokens, price),
        latencyMs,
        status: attempt.ok ? 'ok' : attempt.status,
        ...(attempt.ok || attempt.detail === undefined ? {} : { error: attempt.detail }),
        billing: attempt.ok ? 'known' : attempt.billing,
        logicalRequestId,
        attempt: ordinal,
        stateSha256: request.stateSha256,
        ...(credentialVersion === undefined ? {} : { credentialVersion }),
      };
    };

    /** One wire attempt: reserve, send, record (the router's order). */
    async function sendOnce(ordinal: number): Promise<Sent> {
      const reserved: { id: string | undefined; credentialVersion: string | undefined } = {
        id: undefined,
        credentialVersion: undefined,
      };
      try {
        return await credentials.useActive('typesafe', signal, async (auth): Promise<Sent> => {
          const reservationId = await ledger.reserveExternalCall({
            engine: 'typesafe',
            kind: 'model_probe',
            estimateUsd,
            priority: 'interactive',
            authorization,
          });
          if (reservationId === null) return { kind: 'denied' };
          reserved.id = reservationId;
          reserved.credentialVersion = auth.credentialVersion;
          if (signal.aborted) {
            await ledger.releaseExternalCall(reservationId);
            reserved.id = undefined;
            return { kind: 'cancelled' };
          }
          const started = now().getTime();
          let attempt: EngineAttempt;
          try {
            attempt = await adapter.ask(request, signal, auth);
          } catch {
            attempt = {
              ok: false,
              status: 'error',
              retryable: true,
              detail: 'engine_exception',
              billing: 'uncertain',
            };
          }
          const latencyMs = Math.max(0, now().getTime() - started);
          reserved.id = undefined;
          const { overrun } = await ledger.recordExternalCall(
            externalCall(attempt, latencyMs, ordinal, auth.credentialVersion),
            reservationId,
          );
          return { kind: 'sent', attempt, latencyMs, overrun };
        });
      } catch (error) {
        if (reserved.id !== undefined) {
          // It may have reached the provider: the reservation stays charged conservatively.
          await ledger.recordExternalCall(
            {
              engine: 'typesafe',
              kind: 'model_probe',
              model: requested,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              latencyMs: 0,
              status: 'error',
              error: 'send_failure',
              billing: 'uncertain',
              logicalRequestId,
              attempt: ordinal,
              ...(reserved.credentialVersion === undefined
                ? {}
                : { credentialVersion: reserved.credentialVersion }),
            },
            reserved.id,
          );
        }
        throw error;
      }
    }

    /** The final result of a failed attempt that is not retried, or undefined to retry. */
    function conclude(attempt: FailedAttempt): EngineModelProbe | undefined {
      const detail = attempt.detail ?? '';
      if (attempt.status === 'auth_error') return fail('auth_rejected');
      if (isModelUnavailableDetail(detail)) {
        return fail('model_unavailable');
      }
      const mismatch = MISMATCH.exec(detail);
      if (mismatch !== null) {
        const shown = mismatch[1]!;
        const answered =
          MODEL_ID_PATTERN.test(shown) && shown !== 'unrecognized' ? shown : undefined;
        return fail(isModelAlias(requested) ? 'alias_unresolved' : 'model_mismatch', answered);
      }
      if (attempt.status === 'invalid_request') return fail('request_rejected');
      if (!attempt.retryable) {
        return fail(/^http_4\d\d$/.test(detail) ? 'request_rejected' : 'provider_unavailable');
      }
      return undefined;
    }

    function exhausted(last: FailedAttempt | undefined): EngineModelProbe {
      switch (last?.status) {
        case 'invalid_response':
          return fail('invalid_response');
        case 'rate_limited':
          return fail('rate_limited');
        case 'timeout':
          return fail('timeout');
        default:
          return fail('provider_unavailable');
      }
    }

    let reservedUsd = 0;
    let attempts = 0;
    let last: FailedAttempt | undefined;
    while (attempts < MODEL_PROBE_MAX_ATTEMPTS) {
      if (reservedUsd + estimateUsd > MODEL_PROBE_MAX_SPEND_USD + 1e-12) {
        return fail('probe_budget_exceeded');
      }
      if (attempts > 0) {
        const delay = Math.max(backoffDelayMs(attempts + 1, random), last?.retryAfterMs ?? 0);
        if (delay > MAX_PROBE_WAIT_MS) break;
        if (!(await sleep(delay, signal))) return fail('timeout');
      }
      let sent: Sent;
      try {
        sent = await sendOnce(attempts + 1);
      } catch (error) {
        if (isAppError(error) && error.code === 'ENGINE_UNAVAILABLE') {
          if (signal.aborted) return fail('timeout');
          const reason = error.details?.['reason'];
          return fail(`no_key:${typeof reason === 'string' ? reason : 'unavailable'}`);
        }
        throw error;
      }
      if (sent.kind === 'denied') return fail('budget_unavailable');
      if (sent.kind === 'cancelled') return fail('timeout');
      reservedUsd += estimateUsd;
      attempts += 1;
      const { attempt } = sent;
      if (attempt.ok) return outcome(requested, true, { answered: attempt.model });
      last = attempt;
      if (signal.aborted) return fail('timeout');
      const final = conclude(attempt);
      if (final !== undefined) return final;
      if (sent.overrun) return fail('cost_overrun');
    }
    return exhausted(last);
  }

  return {
    async probe(requested, options = {}) {
      try {
        return await probe(requested, options);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'model probe failed unexpectedly',
        );
        return outcome(requested, false, { error: 'internal_error' });
      }
    },
  };
}

/**
 * Merges a probe result into `settings['engine.model_probe']`, newest {@link ENGINE_MODEL_PROBES_MAX} by `at`,
 * and records in the same transaction how many live users hold an active personal model
 * (`settings['engine.model_impact']`): the API cannot count other users' models under row-level security.
 */
export async function recordModelProbe(
  db: Database,
  probe: EngineModelProbe,
  logger?: Pick<HandlerLogger, 'warn'>,
): Promise<void> {
  const checked = EngineModelProbeSchema.parse(probe);
  let resetInvalid = false;
  await retryTransaction(db, async (tx) => {
    await updateSettingLocked(tx, 'engine.model_probe', {}, (current) => {
      const stored = EngineModelProbesSchema.safeParse(current);
      resetInvalid = !stored.success;
      const previous = stored.success ? stored.data[checked.requested] : undefined;
      const keepPrevious =
        previous !== undefined &&
        Date.parse(previous.at) > Date.parse(checked.at) &&
        Date.parse(previous.at) <= Date.now() + MODEL_PROBE_MAX_SKEW_MS;
      const merged: Record<string, EngineModelProbe> = {
        ...(stored.success ? stored.data : {}),
        [checked.requested]: keepPrevious ? previous : checked,
      };
      const newest = Object.entries(merged)
        .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, ENGINE_MODEL_PROBES_MAX);
      return Object.fromEntries(newest);
    });
    // Serialize with probe writers, and compare timestamps under the impact row's own lock.
    const activeModels = await countActiveUserModels(tx);
    await updateSettingLocked<EngineModelImpact | null>(
      tx,
      'engine.model_impact',
      null,
      (current) => {
        const stored = EngineModelImpactSchema.safeParse(current);
        if (stored.success && Date.parse(stored.data.at) > Date.parse(checked.at))
          return stored.data;
        return EngineModelImpactSchema.parse({ at: checked.at, activeModels });
      },
    );
  });
  // A retried transaction reports the reset once, after it commits, without any stored payload.
  if (resetInvalid) {
    logger?.warn(
      { key: 'engine.model_probe' },
      'invalid stored model probes; resetting the record',
    );
  }
}
