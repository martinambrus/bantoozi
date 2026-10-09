import { ErrorResponseSchema } from '@bantoozi/shared';
import type { z } from 'zod';

import { ApiError } from './errors.js';
import type { AnyRoute, CallArgs, CallOptions, MultipartBody, RouteOutput } from './route.js';

const DEFAULT_BASE_URL = '/api/v1';

export interface ApiClientOptions {
  /** Looked up on the global at each call when absent, so a test or a polyfill can swap it. */
  fetch?: typeof fetch | undefined;
  baseUrl?: string | undefined;
  /** Read as each request is sent: the session it is sent in, which `onUnauthorized` is told. */
  session?: (() => unknown) | undefined;
  /**
   * Runs on a 401 from a route that depends on the session, before the error is thrown, with the
   * session the request was sent in: a 401 to a session that has ended since is no news.
   */
  onUnauthorized?: ((sentIn: unknown) => void) | undefined;
}

export interface ApiClient {
  call<R extends AnyRoute>(route: R, ...args: CallArgs<R>): Promise<RouteOutput<R>>;
}

interface RequestInput {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * The only way the web app talks to the API (spec 09 §1): it applies spec 08's header and body
 * rules, validates what comes back and reports every failure as an `ApiError`.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(
    route: AnyRoute,
    input: RequestInput = {},
    callOptions: CallOptions = {},
  ): Promise<unknown> {
    const url = baseUrl + pathOf(route, input.params) + queryOf(input.query);
    const sentIn = options.session?.();
    let response: Response;
    let body = '';
    try {
      response = await doFetch(url, requestInit(route, input.body, callOptions));
      if (!response.ok || route.response !== null) body = await response.text();
    } catch (error) {
      throw transportError(error, callOptions.signal);
    }

    if (!response.ok) {
      if (response.status === 401 && route.auth !== 'public') options.onUnauthorized?.(sentIn);
      throw httpError(response, body);
    }
    if (route.response === null) return undefined;
    if (route.response === 'text') return body;
    return parseBody(route, route.response, response.status, body);
  }

  return { call: send as ApiClient['call'] };
}

function pathOf(route: AnyRoute, params: Record<string, string> = {}): string {
  return route.path.replace(/:(\w+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new TypeError(`${route.method} ${route.path} needs the path parameter "${name}"`);
    }
    return encodeURIComponent(value);
  });
}

function queryOf(query: Record<string, unknown> = {}): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

function requestInit(route: AnyRoute, body: unknown, options: CallOptions): RequestInit {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;

  if (route.method !== 'GET') headers['X-Bantoozi-Client'] = 'web';
  if (route.idempotent) headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();

  // Fastify rejects a JSON content type with an empty body, so a bodiless POST still sends `{}`.
  if (route.method !== 'GET' && route.method !== 'DELETE') {
    if (route.body === 'multipart') {
      // No Content-Type: the browser adds it with the multipart boundary.
      payload = new FormData();
      payload.append('file', (body as MultipartBody).file);
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
    }
  }

  return {
    method: route.method,
    headers,
    credentials: 'same-origin',
    ...(payload === undefined ? {} : { body: payload }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

function transportError(error: unknown, signal: AbortSignal | undefined): ApiError {
  // fetch rejects with the signal's reason, which is any value the caller gave to `abort()`.
  if (signal?.aborted === true || isAbortError(error)) {
    return new ApiError({
      kind: 'aborted',
      status: null,
      code: 'ABORTED',
      message: 'The request was aborted.',
      cause: error,
    });
  }
  return new ApiError({
    kind: 'network',
    status: null,
    code: 'NETWORK',
    message: 'The request could not reach the server.',
    cause: error,
  });
}

function httpError(response: Response, body: string): ApiError {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const envelope = parseEnvelope(body);
  if (envelope === null) {
    return new ApiError({
      kind: 'http',
      status: response.status,
      code: `HTTP_${response.status}`,
      message: `The server answered ${response.status}.`,
      retryAfterMs,
    });
  }
  return new ApiError({
    kind: 'http',
    status: response.status,
    code: envelope.code,
    message: envelope.message,
    details: envelope.details,
    retryAfterMs,
  });
}

function parseEnvelope(body: string) {
  try {
    const parsed = ErrorResponseSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

function parseBody(route: AnyRoute, schema: z.ZodType, status: number, body: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new ApiError({
      kind: 'invalid_response',
      status,
      code: 'INVALID_RESPONSE',
      message: `${route.method} ${route.path} did not answer with JSON.`,
      cause,
    });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError({
      kind: 'invalid_response',
      status,
      code: 'INVALID_RESPONSE',
      message: `${route.method} ${route.path} answered with an unexpected body.`,
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * `Retry-After` (RFC 9110 §10.2.3) as milliseconds: a count of seconds or an HTTP date, never
 * negative. Anything else is null.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  // Date.parse accepts plenty of non-dates ("1.5"); an HTTP date always spells its month.
  if (!/[a-z]/i.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
