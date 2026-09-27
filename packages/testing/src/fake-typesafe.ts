import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { estimateTokens, normalizeText } from '@bantoozi/shared';

import {
  checkLatency,
  closeServer,
  fakeHandler,
  fakeLatency,
  isRecord,
  listenLoopback,
  own,
  readFakeRequest,
  sendFakeResponse,
  type FakeHttpRequest,
  type FakeHttpResponse,
} from './fake-http.js';

/**
 * Deterministic fake TypeSafe server (spec 04 §10): `POST /v1/systemone` with the documented
 * response shape, so any question set gets a plausible, repeatable answer. Engine unit tests, the
 * classification/breaker integration tests, E2E (through `TYPESAFE_BASE_URL`) and the load test use
 * it. It listens on 127.0.0.1 on a random port (node:http only).
 *
 * Answer rules (spec 04 §10):
 * - **noul about a card or label** (object instructions with an `interest` string, or a
 *   `definition` string for labels): 0.9 if any ≥ 4-character token of that text (normalized with
 *   `normalizeText`) occurs in a `title` or `excerpt` string anywhere in the state; else 0.2 if a
 *   `not_for` token does; else 0.1
 * - **other noul:** 0.3
 * - **choice:** the first option whose key or description shares a ≥ 4-character normalized token
 *   with the state's strings gets 0.7 and the rest share 0.3 equally; no match gives a uniform
 *   distribution; confidence `1 − H(p)/ln(k)` (spec 04 §2)
 * - **score:** probability 1.0 on the middle level `floor(levels / 2)`
 *
 * `usage.input_tokens` is the spec 04 §6.1 estimate and `model` is always `jev-fake`. Article text
 * is only data here: nothing in the state changes how the rules are applied.
 */

export const FAKE_TYPESAFE_MODEL = 'jev-fake';
export const FAKE_TYPESAFE_PATH = '/v1/systemone';

/**
 * A scripted response. With `body` undefined a 200 gets the normal answer and any other status a
 * default provider error body; a string body is sent verbatim (e.g. malformed JSON).
 */
export type FakeTypeSafeResponse = FakeHttpResponse;
export type FakeTypeSafeRequest = FakeHttpRequest;

export interface FakeTypeSafeOptions {
  /** Delay before every response. Default 0 (no timer at all, so fake-timer tests are unaffected). */
  latencyMs?: number | undefined;
  /**
   * Share of LOGICAL requests that fail, chosen deterministically by `sha256(body)`: every retry of
   * a failing request fails again (spec 04 §10). Default 0.
   */
  failRate?: number | undefined;
  /** Status of those failures. Default 503. */
  failStatus?: number | undefined;
  /** Per-request override, e.g. force 401/422 or a 429 with `Retry-After`; undefined → normal. */
  statusOverride?: ((body: unknown) => FakeTypeSafeResponse | undefined) | undefined;
  /** Record every request in `requests`. Default true. */
  recordRequests?: boolean | undefined;
  /** When set, a request without `Authorization: Bearer <apiKey>` gets 401. */
  apiKey?: string | undefined;
}

export interface FakeTypeSafeServer {
  /** Base URL for `TYPESAFE_BASE_URL`; the endpoint is `${url}/v1/systemone`. */
  url: string;
  requests: FakeTypeSafeRequest[];
  /** Every request received, recorded or not. */
  requestCount(): number;
  setOptions(patch: Partial<FakeTypeSafeOptions>): void;
  close(): Promise<void>;
}

/** The fake's decision for one question, before it is shaped as a Jev or an LLM answer. */
export type FakeDecision =
  | { type: 'noul'; p: number }
  | { type: 'choice'; options: string[]; probabilities: number[] }
  | { type: 'score'; probabilities: number[]; legend: string[] };

const CARD_MATCH_P = 0.9;
const NOT_FOR_MATCH_P = 0.2;
const CARD_NO_MATCH_P = 0.1;
const OTHER_NOUL_P = 0.3;
const CHOICE_HIT_P = 0.7;
const MIN_TOKEN_LENGTH = 4;
const MAX_DEPTH = 64;
const REQUEST_FIELDS = new Set(['model', 'state', 'questions']);

/** Every string leaf of a JSON value (object keys excluded). */
function collectStrings(value: unknown, out: string[], depth = 0): string[] {
  if (depth > MAX_DEPTH) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (isRecord(value)) {
    for (const key of Object.keys(value)) collectStrings(value[key], out, depth + 1);
  }
  return out;
}

/** The `title` and `excerpt` strings found at any depth of the state (e.g. `state.article.title`). */
function collectTitlesAndExcerpts(value: unknown, out: string[], depth = 0): string[] {
  if (depth > MAX_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTitlesAndExcerpts(item, out, depth + 1);
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const item = value[key];
      if ((key === 'title' || key === 'excerpt') && typeof item === 'string') out.push(item);
      else collectTitlesAndExcerpts(item, out, depth + 1);
    }
  }
  return out;
}

/** Normalized tokens of at least four characters. */
function tokens(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const token of normalizeText(text).split(' ')) {
      if ([...token].length >= MIN_TOKEN_LENGTH) out.add(token);
    }
  }
  return out;
}

function shares(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/** `1 − H(p)/ln(k)` with `0·ln(0) = 0` (spec 04 §2). */
function entropyConfidence(probabilities: readonly number[]): number {
  const k = probabilities.length;
  if (k < 2) return 1;
  let entropy = 0;
  for (const p of probabilities) if (p > 0) entropy -= p * Math.log(p);
  return Math.min(1, Math.max(0, 1 - entropy / Math.log(k)));
}

function argmax(probabilities: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if ((probabilities[i] ?? 0) > (probabilities[best] ?? 0)) best = i;
  }
  return best;
}

function noulProbability(state: unknown, instructions: unknown): number {
  if (!isRecord(instructions)) return OTHER_NOUL_P;
  const interest = own(instructions, 'interest');
  const definition = own(instructions, 'definition');
  const subject =
    typeof interest === 'string'
      ? interest
      : typeof definition === 'string'
        ? definition
        : undefined;
  if (subject === undefined) return OTHER_NOUL_P;
  const seen = tokens(collectTitlesAndExcerpts(state, []));
  if (shares(tokens([subject]), seen)) return CARD_MATCH_P;
  const notFor = own(instructions, 'not_for');
  if (typeof notFor === 'string' && shares(tokens([notFor]), seen)) return NOT_FOR_MATCH_P;
  return CARD_NO_MATCH_P;
}

function questionsProblem(questions: unknown): string | undefined {
  if (!isRecord(questions) || Object.keys(questions).length === 0) return 'questions_missing';
  for (const key of Object.keys(questions)) {
    const question = questions[key];
    if (!isRecord(question)) return 'question_invalid';
    const type = own(question, 'type');
    const criteria = own(question, 'criteria');
    if (type === 'noul') continue;
    if (type === 'choice') {
      const options = isRecord(criteria) ? Object.keys(criteria).length : 0;
      if (options < 2 || options > 255) return 'choice_options_out_of_range';
      continue;
    }
    if (type === 'score') {
      const levels = Array.isArray(criteria) ? criteria.length : 0;
      if (levels < 2 || levels > 10) return 'score_levels_out_of_range';
      continue;
    }
    return 'question_type_unknown';
  }
  return undefined;
}

/** Why a body is not a valid `systemone` request (the fake answers such a request with 422). */
function requestProblem(body: unknown): string | undefined {
  if (!isRecord(body)) return 'body_not_object';
  for (const key of Object.keys(body)) if (!REQUEST_FIELDS.has(key)) return 'unknown_field';
  const model = own(body, 'model');
  if (typeof model !== 'string' || model === '') return 'model_missing';
  if (own(body, 'state') === undefined) return 'state_missing';
  return questionsProblem(own(body, 'questions'));
}

/**
 * The spec 04 §10 decision for each question of a valid question set (a TypeError for an invalid
 * one). The fake Ollama server shapes the same decisions as LLM answers.
 */
export function fakeTypeSafeDecisions(
  state: unknown,
  questions: unknown,
): Record<string, FakeDecision> {
  const problem = questionsProblem(questions);
  if (problem !== undefined || !isRecord(questions)) {
    throw new TypeError(`fake TypeSafe: invalid questions (${problem ?? 'questions_missing'})`);
  }
  const stateTokens = tokens(collectStrings(state, []));
  const entries: Array<[string, FakeDecision]> = [];
  for (const key of Object.keys(questions)) {
    const question = questions[key] as Record<string, unknown>;
    const type = own(question, 'type');
    const criteria = own(question, 'criteria');
    if (type === 'noul') {
      entries.push([
        key,
        { type: 'noul', p: noulProbability(state, own(question, 'instructions')) },
      ]);
    } else if (type === 'choice' && isRecord(criteria)) {
      const options = Object.keys(criteria);
      const hit = options.findIndex((option) =>
        shares(tokens(collectStrings(criteria[option], [option])), stateTokens),
      );
      const rest = (1 - CHOICE_HIT_P) / (options.length - 1);
      const probabilities = options.map((_, i) =>
        hit === -1 ? 1 / options.length : i === hit ? CHOICE_HIT_P : rest,
      );
      entries.push([key, { type: 'choice', options, probabilities }]);
    } else if (Array.isArray(criteria)) {
      const middle = Math.floor(criteria.length / 2);
      entries.push([
        key,
        {
          type: 'score',
          probabilities: criteria.map((_, level) => (level === middle ? 1 : 0)),
          legend: criteria.map((level: unknown) =>
            typeof level === 'string' ? level : JSON.stringify(level ?? null),
          ),
        },
      ]);
    }
  }
  return Object.fromEntries(entries);
}

/** One decision as a Jev `systemone` answer (spec 04 §3 response shape). */
function jevAnswer(decision: FakeDecision): unknown {
  if (decision.type === 'noul') return { type: 'noul', noul: decision.p };
  if (decision.type === 'choice') {
    return {
      type: 'choice',
      choice: decision.options[argmax(decision.probabilities)],
      probabilities: Object.fromEntries(
        decision.options.map((option, i) => [option, decision.probabilities[i]]),
      ),
      confidence: entropyConfidence(decision.probabilities),
    };
  }
  return {
    type: 'score',
    score: decision.probabilities.reduce((total, p, level) => total + level * p, 0),
    legend: Object.fromEntries(decision.legend.map((text, level) => [String(level), text])),
    probabilities: Object.fromEntries(decision.probabilities.map((p, i) => [String(i), p])),
    confidence: entropyConfidence(decision.probabilities),
  };
}

/**
 * The fake's 200 response JSON for a `systemone` request body (pure; a TypeError for an invalid
 * request, which the server answers with 422 instead).
 */
export function fakeTypeSafeAnswer(requestBody: unknown): unknown {
  const problem = requestProblem(requestBody);
  if (problem !== undefined || !isRecord(requestBody)) {
    throw new TypeError(`fake TypeSafe: invalid request (${problem ?? 'body_not_object'})`);
  }
  const state = own(requestBody, 'state');
  const questions = own(requestBody, 'questions') as Record<string, unknown>;
  const answers = Object.fromEntries(
    Object.entries(fakeTypeSafeDecisions(state, questions)).map(([key, decision]) => [
      key,
      jevAnswer(decision),
    ]),
  );
  return {
    model: FAKE_TYPESAFE_MODEL,
    answers,
    usage: {
      input_tokens: estimateTokens(state, questions),
      output_tokens: Math.ceil(JSON.stringify(answers).length / 3.5),
    },
  };
}

/**
 * The deterministic failure roll of a request body in [0, 1): the first 52 bits of
 * `sha256(body)`. A request fails when its roll is below `failRate`, so every retry of the same
 * body fails again (spec 04 §10: failures are per logical request).
 */
export function fakeTypeSafeRoll(rawBody: string | Uint8Array): number {
  const hex = createHash('sha256').update(rawBody).digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** A plausible provider error body for a status (never an echo of the request). */
export function fakeTypeSafeErrorBody(status: number): unknown {
  const known: Record<number, [string, string]> = {
    400: ['invalid_request_error', 'bad_request'],
    401: ['authentication_error', 'invalid_api_key'],
    403: ['permission_error', 'forbidden'],
    404: ['not_found_error', 'not_found'],
    413: ['invalid_request_error', 'request_too_large'],
    422: ['invalid_request_error', 'invalid_request'],
    429: ['rate_limit_error', 'rate_limited'],
    529: ['overloaded_error', 'overloaded'],
  };
  const [type, code] = known[status] ?? [
    status >= 500 ? 'api_error' : 'invalid_request_error',
    `http_${status}`,
  ];
  return { error: { type, code, message: `fake TypeSafe status ${status}` } };
}

function checkOptions(options: FakeTypeSafeOptions): void {
  const { failRate } = options;
  if (failRate !== undefined && !(failRate >= 0 && failRate <= 1)) {
    throw new RangeError('fake TypeSafe: failRate must be in [0, 1]');
  }
  checkLatency(options.latencyMs, 'fake TypeSafe');
}

/** Starts the fake on 127.0.0.1 with a random port. */
export async function startFakeTypeSafe(
  options: FakeTypeSafeOptions = {},
): Promise<FakeTypeSafeServer> {
  checkOptions(options);
  let current: FakeTypeSafeOptions = { ...options };
  const requests: FakeTypeSafeRequest[] = [];
  let count = 0;

  /** Override, then the deterministic failure roll, then validation, then the §10 answer. */
  const answer = (request: FakeTypeSafeRequest): FakeTypeSafeResponse => {
    const { body } = request;
    const problem = requestProblem(body);
    const override = current.statusOverride?.(body);
    if (override !== undefined) {
      if (override.body !== undefined) return override;
      const normal = override.status === 200 && problem === undefined;
      return {
        ...override,
        body: normal ? fakeTypeSafeAnswer(body) : fakeTypeSafeErrorBody(override.status),
      };
    }
    const failRate = current.failRate ?? 0;
    if (failRate > 0 && fakeTypeSafeRoll(request.rawBody) < failRate) {
      const status = current.failStatus ?? 503;
      return { status, body: fakeTypeSafeErrorBody(status) };
    }
    if (problem !== undefined) {
      return {
        status: 422,
        body: { error: { type: 'invalid_request_error', code: problem, message: 'fake' } },
      };
    }
    return { status: 200, body: fakeTypeSafeAnswer(body) };
  };

  const server = createServer(
    fakeHandler(async (req, res) => {
      count += 1;
      const { request, tooLarge, json } = await readFakeRequest(req);
      if (current.recordRequests !== false) requests.push(request);
      await fakeLatency(current.latencyMs);
      const send = (response: FakeTypeSafeResponse): void => sendFakeResponse(res, response);

      if (request.path !== FAKE_TYPESAFE_PATH) {
        send({ status: 404, body: fakeTypeSafeErrorBody(404) });
      } else if (request.method !== 'POST') {
        send({ status: 405, headers: { allow: 'POST' }, body: fakeTypeSafeErrorBody(405) });
      } else if (
        current.apiKey !== undefined &&
        req.headers.authorization !== `Bearer ${current.apiKey}`
      ) {
        send({ status: 401, body: fakeTypeSafeErrorBody(401) });
      } else if (tooLarge) {
        send({ status: 413, body: fakeTypeSafeErrorBody(413) });
      } else if (!json) {
        send({ status: 400, body: fakeTypeSafeErrorBody(400) });
      } else {
        send(answer(request));
      }
    }),
  );

  const url = await listenLoopback(server);
  return {
    url,
    requests,
    requestCount: () => count,
    setOptions(patch) {
      const next = { ...current, ...patch };
      checkOptions(next);
      current = next;
    },
    close: () => closeServer(server),
  };
}
