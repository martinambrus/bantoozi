import { systemClock, type Clock } from '@bantoozi/shared';
import type { Dispatcher } from 'undici';

import { normalizeAnswers, validateRequest, type RequestLimits } from './normalize.js';
import {
  capDetail,
  checkPositiveInteger,
  checkTimeout,
  DEFAULT_MAX_RESPONSE_BYTES,
  field,
  httpStatusFailure,
  isUsableApiKey,
  notSent,
  parseJsonBody,
  postJson,
  providerEndpoint,
  tokenCount,
  type AttemptFailure,
} from './provider-http.js';
import type {
  DecisionEngine,
  EngineAttempt,
  EngineRequest,
  ProviderAuth,
  Question,
} from './types.js';

/** Jev's decision endpoint (spec 04 §3). */
export const TYPESAFE_PATH = '/v1/systemone';
/** Per-attempt timeout (spec 04 §3). */
export const TYPESAFE_TIMEOUT_MS = 30_000;
/** The model id the deterministic fake server answers with (spec 04 §10); never valid in production. */
export const JEV_FAKE_MODEL = 'jev-fake';
/** Mirrors the production pin check of `loadConfig` (spec 01 §3). */
const PINNED_MODEL = /^[a-z][a-z0-9.-]*-\d+\.\d+\.\d+$/;

export interface TypeSafeEngineOptions {
  /** TYPESAFE_BASE_URL; `https:` in production. */
  baseUrl: string;
  /** TYPESAFE_MODEL: sent with every request and required back in every response. */
  model: string;
  /** TYPESAFE_PRICE_PER_MTOK_USD: input tokens only; output is free. */
  pricePerMTokUsd: number;
  /** NODE_ENV === 'production': https only, a pinned model, never `jev-fake`. */
  production: boolean;
  /** Default {@link TYPESAFE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected transport (tests); must not follow redirects. Default: undici's global dispatcher. */
  dispatcher?: Dispatcher;
  /**
   * Explicit test configuration (spec 04 §3): accept responses from the `jev-fake` model of the fake
   * server (and allow `model: 'jev-fake'`). Refused in production.
   */
  allowFakeModel?: boolean;
  /** Cap on the response body. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Outbound request limits (spec 04 §2). */
  limits?: Partial<RequestLimits>;
  /** For `Retry-After` dates and latency. Default: the system clock. */
  clock?: Clock;
}

/** The exact request body of spec 04 §3: `{model, state, questions}` and nothing else. */
export function typesafeRequestBody(
  model: string,
  req: Pick<EngineRequest, 'state' | 'questions'>,
): { model: string; state: EngineRequest['state']; questions: Record<string, Question> } {
  return { model, state: req.state, questions: req.questions };
}

/** Spec 04 §3: `input_tokens × TYPESAFE_PRICE_PER_MTOK_USD / 1e6`; output tokens are free. */
export function typesafeCostUsd(inputTokens: number, pricePerMTokUsd: number): number {
  return (inputTokens * pricePerMTokUsd) / 1_000_000;
}

/** Usage of a parsed response, or undefined when it is missing or malformed. */
function parseUsage(json: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const usage = field(json, 'usage');
  const inputTokens = tokenCount(field(usage, 'input_tokens'));
  const outputTokens = tokenCount(field(usage, 'output_tokens'));
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

/** Shows a provider-supplied model id in a detail only when it looks like one. */
function shownModel(model: string): string {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(model) ? model : 'unrecognized';
}

/**
 * The TypeSafe (Jev) engine (spec 04 §3): exactly ONE wire attempt per `ask`; the router owns
 * retries, the rate limiter, the breaker and spend. `POST {baseUrl}/v1/systemone` with the resolved
 * credential as a bearer token and the body `{model, state, questions}`.
 *
 * Outcomes: 200 → answers normalized per spec 04 §2 (an unusable body is a retryable
 * `invalid_response`); 401/403 → `auth_error`; 400/413/422 → `invalid_request` with a sanitized
 * provider error code only; 429 → `rate_limited` with `retryAfterMs`; 5xx, network errors and the
 * 30 s timeout → retryable; other statuses (redirects are never followed) → a permanent `error`.
 * A response's `model` must equal the pinned model (in every environment); `jev-fake` is accepted
 * only with `allowFakeModel`, which production refuses. Billing is `uncertain` only when the
 * request may have reached the provider without a readable usage block.
 */
export function createTypeSafeEngine(options: TypeSafeEngineOptions): DecisionEngine {
  const engine = 'TypeSafeEngine';
  const { model, production } = options;
  if (typeof model !== 'string' || model === '') {
    throw new TypeError(`${engine}: model is required`);
  }
  if (production && !PINNED_MODEL.test(model)) {
    throw new TypeError(`${engine}: model must be a pinned version in production`);
  }
  if (production && options.allowFakeModel === true) {
    throw new TypeError(`${engine}: allowFakeModel is a test-only setting`);
  }
  const acceptFake = options.allowFakeModel === true && !production;
  if (model === JEV_FAKE_MODEL && !acceptFake) {
    throw new TypeError(`${engine}: model ${JEV_FAKE_MODEL} requires allowFakeModel (tests only)`);
  }
  if (!Number.isFinite(options.pricePerMTokUsd) || options.pricePerMTokUsd < 0) {
    throw new RangeError(`${engine}: pricePerMTokUsd must be a nonnegative number`);
  }
  const url = providerEndpoint(options.baseUrl, TYPESAFE_PATH, { production, engine });
  const timeoutMs = checkTimeout(options.timeoutMs ?? TYPESAFE_TIMEOUT_MS, engine);
  const maxResponseBytes = checkPositiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
    engine,
  );
  const clock = options.clock ?? systemClock;
  const price = options.pricePerMTokUsd;

  const invalidResponse = (
    detail: string,
    usage: { inputTokens: number; outputTokens: number } | undefined,
  ): AttemptFailure => ({
    ok: false,
    status: 'invalid_response',
    retryable: true,
    detail: capDetail(detail),
    // Without a usage block the provider may have billed an unknown amount.
    ...(usage === undefined
      ? { billing: 'uncertain' as const }
      : { usage, billing: 'known' as const }),
  });

  return {
    name: 'typesafe',
    async ask(
      req: EngineRequest,
      signal: AbortSignal,
      auth?: ProviderAuth,
    ): Promise<EngineAttempt> {
      if (auth === undefined) return notSent('auth_error', 'no_credential');
      if (!isUsableApiKey(auth.apiKey)) return notSent('auth_error', 'unusable_credential');
      const check = validateRequest(req, options.limits);
      if (!check.ok) return notSent('invalid_request', capDetail(check.detail));

      const startedMs = clock.now().getTime();
      const outcome = await postJson({
        url,
        apiKey: auth.apiKey,
        body: JSON.stringify(typesafeRequestBody(model, req)),
        timeoutMs,
        signal,
        maxResponseBytes,
        dispatcher: options.dispatcher,
      });
      if (outcome.kind === 'failed') return outcome.failure;
      const nowMs = clock.now().getTime();
      if (outcome.status < 200 || outcome.status > 299) {
        return httpStatusFailure(outcome.status, outcome.headers, outcome.body, nowMs);
      }
      if (outcome.tooLarge) return invalidResponse('response_too_large', undefined);
      const json = parseJsonBody(outcome.body);
      if (!json.ok) return invalidResponse('response_not_json', undefined);
      const usage = parseUsage(json.value);
      if (usage === undefined) return invalidResponse('usage_missing_or_invalid', undefined);

      const answeredBy = field(json.value, 'model');
      if (typeof answeredBy !== 'string') return invalidResponse('model_missing', usage);
      // `jev-fake` answers only an explicit test configuration, whatever model was requested.
      const pinned = answeredBy === JEV_FAKE_MODEL ? acceptFake : answeredBy === model;
      if (!pinned) return invalidResponse(`model_mismatch:${shownModel(answeredBy)}`, usage);
      const normalized = normalizeAnswers(field(json.value, 'answers'), req.questions, {
        format: 'jev',
      });
      if (!normalized.ok) return invalidResponse(normalized.detail, usage);
      return {
        ok: true,
        engine: 'typesafe',
        model: answeredBy,
        answers: normalized.answers,
        usage,
        costUsd: typesafeCostUsd(usage.inputTokens, price),
        latencyMs: Math.max(0, nowMs - startedMs),
      };
    },
  };
}
