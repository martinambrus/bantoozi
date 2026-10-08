import { vi } from 'vitest';

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RecordedRequest {
  /** The URL exactly as the client passed it to `fetch`. */
  url: string;
  /** Pathname and query parsed from `url`. */
  pathname: string;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: string | FormData | null;
  signal: AbortSignal | null;
  keepalive: boolean | undefined;
  credentials: RequestCredentials | undefined;
}

export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function text(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

export function noContent() {
  return new Response(null, { status: 204 });
}

/** The error envelope of spec 08 §1. */
export function failure(
  status: number,
  code: string,
  details?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return json(
    status,
    { error: { code, message: `${code} (test)`, ...(details === undefined ? {} : { details }) } },
    headers,
  );
}

/**
 * A `fetch` that records each request and answers with `handler`. Like the real one it rejects with
 * the signal's reason when the request's signal aborts before the handler has answered.
 */
export function fakeFetch(handler: FakeHandler = () => json(200, {})) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const parsed = new URL(url, 'http://localhost');
    const signal = init.signal ?? null;
    const request: RecordedRequest = {
      url,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: (init.body as string | FormData | null | undefined) ?? null,
      signal,
      keepalive: init.keepalive,
      credentials: init.credentials,
    };
    requests.push(request);
    return new Promise<Response>((resolve, reject) => {
      if (signal !== null) {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }
      Promise.resolve(handler(request)).then(resolve, reject);
    });
  });
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock, requests };
}
