import { createServer } from 'node:http';

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
import { fakeTypeSafeDecisions, type FakeDecision } from './fake-typesafe.js';

/**
 * A small fake Ollama `POST /api/chat` server (spec 04 §8, spec 07 §3) for the LLM fallback engine
 * and the tier-2 translator tests. It listens on 127.0.0.1 on a random port (node:http only).
 *
 * Unless `reply` gives it, the reply content depends on the last user message (the JSON the client
 * sent), and `ok` mode sends it as is:
 * - a decision request `{state, questions}` gets the answers the fake TypeSafe server would give
 *   (spec 04 §10 rules), shaped as the fallback's schema requires: `{p}` for noul and
 *   `{probabilities: {…}}` for choice/score, as compact JSON
 * - any other JSON object (a translation request) is echoed back unchanged; tests that need a
 *   realistic translation pass `reply`
 *
 * `malformed` wraps that content in chatty non-JSON text, `truncated` sends its first half with
 * `done_reason: 'length'` (and `eval_count` = the request's `num_predict`), and `status` answers
 * with an HTTP error (`{"error": "…"}`, Ollama's shape).
 */

export type FakeOllamaMode = 'ok' | 'malformed' | 'truncated' | 'status';
export type FakeOllamaRequest = FakeHttpRequest;
export type FakeOllamaResponse = FakeHttpResponse;

export const FAKE_OLLAMA_PATH = '/api/chat';
/** Fixed `created_at`, so responses are byte-for-byte repeatable. */
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const CHARS_PER_TOKEN = 3.5;

export interface FakeOllamaOptions {
  /** Default `ok`. */
  mode?: FakeOllamaMode | undefined;
  /** HTTP status in `status` mode. Default 503. */
  status?: number | undefined;
  /** Extra response headers in `status` mode (e.g. `retry-after`). */
  headers?: Record<string, string> | undefined;
  /** The reply content instead of the default one (`malformed`/`truncated` then damage it). */
  reply?: ((body: unknown) => string) | undefined;
  /** Per-request override of the whole response (fixture tests); undefined → the mode's. */
  statusOverride?: ((body: unknown) => FakeOllamaResponse | undefined) | undefined;
  /** Delay before every response. Default 0 (no timer). */
  latencyMs?: number | undefined;
  /** Record every request in `requests`. Default true. */
  recordRequests?: boolean | undefined;
  /** When set, a request without `Authorization: Bearer <apiKey>` gets 401. */
  apiKey?: string | undefined;
}

export interface FakeOllamaServer {
  /** Base URL for `OLLAMA_BASE_URL`; the endpoint is `${url}/api/chat`. */
  url: string;
  requests: FakeOllamaRequest[];
  /** Every request received, recorded or not. */
  requestCount(): number;
  setOptions(patch: Partial<FakeOllamaOptions>): void;
  close(): Promise<void>;
}

function messages(body: unknown): Array<Record<string, unknown>> {
  const list = isRecord(body) ? own(body, 'messages') : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/** The content of the last user message. */
function userContent(body: unknown): string {
  const last = messages(body)
    .filter((message) => own(message, 'role') === 'user')
    .at(-1);
  const content = last === undefined ? undefined : own(last, 'content');
  return typeof content === 'string' ? content : '';
}

/** One decision as the fallback schema's answer (spec 04 §8). */
function llmAnswer(decision: FakeDecision): unknown {
  if (decision.type === 'noul') return { p: decision.p };
  const keys =
    decision.type === 'choice'
      ? decision.options
      : decision.probabilities.map((_, level) => String(level));
  return {
    probabilities: Object.fromEntries(keys.map((key, i) => [key, decision.probabilities[i]])),
  };
}

/** The default reply content for a request body (pure): what `ok` mode sends without `reply`. */
export function fakeOllamaContent(body: unknown): string {
  let data: unknown;
  try {
    data = JSON.parse(userContent(body));
  } catch {
    return '{}';
  }
  if (!isRecord(data)) return '{}';
  if (!Object.hasOwn(data, 'questions')) return JSON.stringify(data);
  try {
    const decisions = fakeTypeSafeDecisions(own(data, 'state'), own(data, 'questions'));
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(decisions).map(([key, decision]) => [key, llmAnswer(decision)]),
      ),
    );
  } catch {
    return '{}';
  }
}

const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** A `/api/chat` 200 response JSON in the given mode (pure; `status` mode has none). */
export function fakeOllamaResponse(
  body: unknown,
  options: { mode?: Exclude<FakeOllamaMode, 'status'>; reply?: (body: unknown) => string } = {},
): unknown {
  const mode = options.mode ?? 'ok';
  const content = options.reply === undefined ? fakeOllamaContent(body) : options.reply(body);
  const promptTokens = messages(body).reduce((total, message) => {
    const text = own(message, 'content');
    return total + (typeof text === 'string' ? tokensOf(text) : 0);
  }, 0);
  const model = isRecord(body) ? own(body, 'model') : undefined;
  const requestOptions = isRecord(body) ? own(body, 'options') : undefined;
  const numPredict = isRecord(requestOptions) ? own(requestOptions, 'num_predict') : undefined;
  const sent =
    mode === 'malformed'
      ? `Sure! Here are the answers you asked for: ${content}`
      : mode === 'truncated'
        ? content.slice(0, Math.floor(content.length / 2))
        : content;
  return {
    model: typeof model === 'string' ? model : 'fake',
    created_at: CREATED_AT,
    message: { role: 'assistant', content: sent },
    done: true,
    done_reason: mode === 'truncated' ? 'length' : 'stop',
    total_duration: 1_000_000,
    load_duration: 0,
    prompt_eval_count: promptTokens,
    prompt_eval_duration: 500_000,
    eval_count:
      mode === 'truncated' && typeof numPredict === 'number' ? numPredict : tokensOf(sent),
    eval_duration: 500_000,
  };
}

/** Starts the fake on 127.0.0.1 with a random port. */
export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllamaServer> {
  checkLatency(options.latencyMs, 'fake Ollama');
  let current: FakeOllamaOptions = { ...options };
  const requests: FakeOllamaRequest[] = [];
  let count = 0;

  const answer = (body: unknown): FakeOllamaResponse => {
    const override = current.statusOverride?.(body);
    if (override !== undefined) return override;
    const mode = current.mode ?? 'ok';
    if (mode === 'status') {
      const status = current.status ?? 503;
      return {
        status,
        ...(current.headers === undefined ? {} : { headers: current.headers }),
        body: { error: `fake Ollama status ${status}` },
      };
    }
    const { reply } = current;
    return {
      status: 200,
      body: fakeOllamaResponse(body, { mode, ...(reply === undefined ? {} : { reply }) }),
    };
  };

  const server = createServer(
    fakeHandler(async (req, res) => {
      count += 1;
      const { request, tooLarge, json } = await readFakeRequest(req);
      if (current.recordRequests !== false) requests.push(request);
      await fakeLatency(current.latencyMs);
      const send = (response: FakeOllamaResponse): void => sendFakeResponse(res, response);

      if (request.path !== FAKE_OLLAMA_PATH) {
        send({ status: 404, body: { error: '404 page not found' } });
      } else if (request.method !== 'POST') {
        send({ status: 405, headers: { allow: 'POST' }, body: { error: 'method not allowed' } });
      } else if (
        current.apiKey !== undefined &&
        req.headers.authorization !== `Bearer ${current.apiKey}`
      ) {
        send({ status: 401, body: { error: 'unauthorized' } });
      } else if (tooLarge) {
        send({ status: 413, body: { error: 'request too large' } });
      } else if (!json) {
        send({ status: 400, body: { error: 'invalid JSON' } });
      } else {
        send(answer(request.body));
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
      checkLatency(next.latencyMs, 'fake Ollama');
      current = next;
    },
    close: () => closeServer(server),
  };
}
