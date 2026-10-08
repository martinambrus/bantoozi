import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApiClient, parseRetryAfter, type ApiClient } from '../../src/api/client.js';
import { ApiError } from '../../src/api/errors.js';
import type { AnyRoute, CallOptions } from '../../src/api/route.js';
import { routes } from '../../src/api/routes.js';
import { makeMe } from '../session/fixtures.js';
import {
  UUID_V4,
  failure,
  fakeFetch,
  json,
  noContent,
  text,
  type FakeHandler,
} from './fake-fetch.js';
import { needsIdempotencyKey } from './operations.js';

function setup(handler?: FakeHandler) {
  const fake = fakeFetch(handler);
  const onUnauthorized = vi.fn();
  const client = createApiClient({ fetch: fake.fetch, onUnauthorized });
  return { ...fake, client, onUnauthorized };
}

/** `call` without the per-route input types, for the table over every route. */
type LooseCall = (route: AnyRoute, input?: unknown, options?: CallOptions) => Promise<unknown>;
const looseCall = (client: ApiClient) => client.call as unknown as LooseCall;

/** For tests of the request, where the answer does not matter. */
const settle = (promise: Promise<unknown>) => promise.catch(() => undefined);

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

/** A 200 whose body fails after the headers arrived, as a dropped connection or an abort does. */
function brokenBody(fail: () => unknown) {
  const body = new ReadableStream(
    {
      pull() {
        throw fail();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200 });
}

const entries = Object.entries(routes) as [string, AnyRoute][];
const operationOf = (route: AnyRoute) => `${route.method} ${route.path}`;

function paramsOf(route: AnyRoute): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [, name] of route.path.matchAll(/:(\w+)/g)) {
    if (name !== undefined) params[name] = `${name}-1`;
  }
  return params;
}

function inputOf(route: AnyRoute) {
  const params = paramsOf(route);
  return {
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(route.body === 'multipart' ? { body: { file: new Blob(['<opml/>']) } } : {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(entries)('%s', (_name, route) => {
  it('sends the request its route describes', async () => {
    const { client, requests } = setup();
    await settle(looseCall(client)(route, inputOf(route)));

    expect(requests).toHaveLength(1);
    const [request] = requests;
    const params = paramsOf(route);
    const path = route.path.replace(/:(\w+)/g, (_match, name: string) =>
      encodeURIComponent(params[name] ?? ''),
    );
    expect(request?.method).toBe(route.method);
    expect(request?.url).toBe(`/api/v1${path}`);
    expect(request?.credentials).toBe('same-origin');

    if (route.method !== 'GET') expect(request?.headers.get('x-bantoozi-client')).toBe('web');

    const key = request?.headers.get('idempotency-key') ?? null;
    if (needsIdempotencyKey(operationOf(route))) expect(key).toMatch(UUID_V4);
    else expect(key).toBeNull();

    if (route.method === 'GET' || route.method === 'DELETE') {
      expect(request?.body).toBeNull();
      expect(request?.headers.get('content-type')).toBeNull();
    } else if (route.body === 'multipart') {
      expect(request?.body).toBeInstanceOf(FormData);
      expect(request?.headers.get('content-type')).toBeNull();
    } else {
      expect(request?.body).toBe('{}');
      expect(request?.headers.get('content-type')).toBe('application/json');
    }
  });

  it(`${route.auth === 'public' ? 'keeps' : 'ends'} the session on a 401`, async () => {
    const { client, onUnauthorized } = setup(() => failure(401, 'UNAUTHENTICATED'));
    const error = await failureOf(looseCall(client)(route, inputOf(route)));

    expect(error).toMatchObject({ kind: 'http', status: 401, code: 'UNAUTHENTICATED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(route.auth === 'public' ? 0 : 1);
  });
});

describe('request', () => {
  it('serializes a JSON body', async () => {
    const { client, requests } = setup(() => json(200, { user: makeMe() }));
    await client.call(routes.authVerify, { body: { email: 'a@example.com', code: '123456' } });

    expect(requests[0]?.body).toBe('{"email":"a@example.com","code":"123456"}');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('sends {} with a JSON content type for a POST without a body', async () => {
    const { client, requests } = setup(() => noContent());
    await client.call(routes.authLogout);

    expect(requests[0]?.body).toBe('{}');
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('sends a DELETE without body or content type', async () => {
    const { client, requests } = setup(() => noContent());
    await client.call(routes.subscriptionsDelete, { params: { feedId: '42' } });

    expect(requests[0]?.body).toBeNull();
    expect(requests[0]?.headers.get('content-type')).toBeNull();
    expect(requests[0]?.headers.get('x-bantoozi-client')).toBe('web');
  });

  it('puts the fence of a DELETE in the query string', async () => {
    const { client, requests } = setup();
    await settle(
      client.call(routes.articleUnbookmark, {
        params: { id: '7' },
        query: { stateVersion: '3', contentRevision: '12', snapshotId: '9' },
      }),
    );

    expect(requests[0]?.pathname).toBe('/api/v1/articles/7/bookmark');
    expect(Object.fromEntries(requests[0]?.query ?? [])).toEqual({
      stateVersion: '3',
      contentRevision: '12',
      snapshotId: '9',
    });
    expect(requests[0]?.body).toBeNull();
  });

  it('sends the OPML upload as one multipart part named file', async () => {
    const { client, requests } = setup();
    const file = new File(['<opml version="2.0"/>'], 'feeds.opml', { type: 'text/x-opml' });
    await settle(client.call(routes.subscriptionsImportOpml, { body: { file } }));

    const body = requests[0]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect([...(body as FormData).keys()]).toEqual(['file']);
    expect((body as FormData).get('file')).toMatchObject({ name: 'feeds.opml' });
    expect(requests[0]?.headers.get('content-type')).toBeNull();
    expect(requests[0]?.headers.get('idempotency-key')).toMatch(UUID_V4);
  });

  it('encodes path parameters', async () => {
    const { client, requests } = setup();
    await settle(client.call(routes.articleGet, { params: { id: 'a b/c?d#e%f' } }));

    expect(requests[0]?.url).toBe('/api/v1/articles/a%20b%2Fc%3Fd%23e%25f');
    expect(Object.fromEntries(requests[0]?.query ?? [])).toEqual({});
  });

  it('serializes the query, encoded and without undefined values', async () => {
    const { client, requests } = setup();
    await settle(
      client.call(routes.articleList, {
        query: { lane: 'maybe', folder: 'Správy / SK', cursor: undefined, limit: 20 },
      }),
    );

    expect(requests[0]?.url).toBe(
      '/api/v1/articles?lane=maybe&folder=Spr%C3%A1vy%20%2F%20SK&limit=20',
    );
  });

  it('adds no question mark when the query is empty', async () => {
    const { client, requests } = setup();
    await settle(client.call(routes.articleList, { query: { cursor: undefined } }));
    await settle(client.call(routes.articleList));

    expect(requests.map((request) => request.url)).toEqual([
      '/api/v1/articles',
      '/api/v1/articles',
    ]);
  });

  it('passes the signal and keepalive to fetch', async () => {
    const { client, requests } = setup();
    const controller = new AbortController();
    await settle(
      client.call(routes.healthz, undefined, { signal: controller.signal, keepalive: true }),
    );
    await settle(client.call(routes.healthz));

    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[0]?.keepalive).toBe(true);
    expect(requests[1]?.signal).toBeNull();
    expect(requests[1]?.keepalive).toBeUndefined();
  });

  it('uses the global fetch of the moment and /api/v1 by default', async () => {
    const fake = fakeFetch();
    const client = createApiClient();
    vi.stubGlobal('fetch', fake.fetch);
    await settle(client.call(routes.healthz));

    expect(fake.requests.map((request) => request.url)).toEqual(['/api/v1/healthz']);
  });

  it('honours another base URL', async () => {
    const fake = fakeFetch();
    const client = createApiClient({ fetch: fake.fetch, baseUrl: 'https://api.test/api/v2' });
    await settle(client.call(routes.healthz));

    expect(fake.requests[0]?.url).toBe('https://api.test/api/v2/healthz');
  });
});

describe('Idempotency-Key', () => {
  const remove = { params: { feedId: '1' } };

  it('is a new uuid for each call that gives none', async () => {
    const { client, requests } = setup(() => noContent());
    await client.call(routes.subscriptionsDelete, remove);
    await client.call(routes.subscriptionsDelete, remove);

    const keys = requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('is the caller key verbatim', async () => {
    const { client, requests } = setup(() => noContent());
    await client.call(routes.subscriptionsDelete, remove, { idempotencyKey: 'k-1' });
    await client.call(routes.subscriptionsDelete, remove, { idempotencyKey: 'k-1' });

    const keys = requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual(['k-1', 'k-1']);
  });

  it('is never sent on a route without one, even if the caller gives one', async () => {
    const { client, requests } = setup();
    const email = { body: { email: 'a@example.com' } };
    await settle(client.call(routes.authRequestCode, email, { idempotencyKey: 'k' }));
    await settle(client.call(routes.meGet, undefined, { idempotencyKey: 'k' }));

    const keys = requests.map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual([null, null]);
  });
});

describe('response', () => {
  it('returns the validated body', async () => {
    const me = makeMe();
    const { client } = setup(() => json(200, me));

    await expect(client.call(routes.meGet)).resolves.toEqual(me);
  });

  it('returns undefined for a route without content', async () => {
    const { client } = setup(() => noContent());

    await expect(client.call(routes.authLogout)).resolves.toBeUndefined();
  });

  it('ignores the body of a route without content', async () => {
    const { client } = setup(() => json(200, { ok: true }));

    await expect(client.call(routes.authLogout)).resolves.toBeUndefined();
  });

  it('returns the text of a text route', async () => {
    const opml = '<?xml version="1.0"?><opml version="2.0"/>';
    const { client } = setup(() => text(200, opml, { 'content-type': 'text/x-opml' }));

    await expect(client.call(routes.subscriptionsExportOpml)).resolves.toBe(opml);
  });

  it('rejects a body that does not match the schema as invalid_response', async () => {
    const { client } = setup(() => json(200, { id: 1 }));
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({
      kind: 'invalid_response',
      code: 'INVALID_RESPONSE',
      status: 200,
    });
    expect(error.cause).toBeInstanceOf(z.ZodError);
  });

  it('rejects a body that is not JSON as invalid_response', async () => {
    const { client } = setup(() =>
      text(200, '<html>Sign in to the network</html>', { 'content-type': 'text/html' }),
    );
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
  });

  it('rejects an empty body where the schema needs one', async () => {
    const { client } = setup(() => noContent());
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ kind: 'invalid_response', status: 204 });
  });
});

describe('errors', () => {
  it('turns the error envelope into an ApiError', async () => {
    const details = { reason: 'stale_version', stateVersion: '5' };
    const { client } = setup(() => failure(409, 'STALE_STATE', details));
    const error = await failureOf(
      client.call(routes.articleUnread, {
        params: { id: '7' },
        body: { stateVersion: '3', contentRevision: '1' },
      }),
    );

    expect(error).toMatchObject({
      kind: 'http',
      status: 409,
      code: 'STALE_STATE',
      message: 'STALE_STATE (test)',
      details,
      retryAfterMs: null,
      reason: 'stale_version',
    });
  });

  it('leaves details undefined when the envelope has none', async () => {
    const { client } = setup(() => failure(404, 'NOT_FOUND'));
    const error = await failureOf(client.call(routes.meGet));

    expect(error.details).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it('reports an answer without the envelope as an HTTP error named after its status', async () => {
    const { client } = setup(() => text(502, '<html>Bad gateway</html>'));
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ kind: 'http', status: 502, code: 'HTTP_502' });
    expect(error.message).not.toBe('');
  });

  it('reads Retry-After in seconds', async () => {
    const { client } = setup(() => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '7' }));
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterMs: 7000 });
  });

  it('reads Retry-After as an HTTP date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const retryAfter = 'Thu, 08 Oct 2026 12:00:30 GMT';
    const { client } = setup(() =>
      failure(503, 'ENGINE_UNAVAILABLE', undefined, { 'retry-after': retryAfter }),
    );
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ status: 503, retryAfterMs: 30_000 });
  });

  it('maps a rejected fetch to a network error', async () => {
    const cause = new TypeError('Failed to fetch');
    const { client } = setup(() => {
      throw cause;
    });
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ kind: 'network', status: null, code: 'NETWORK', cause });
  });

  it('maps a body that fails to arrive to a network error', async () => {
    const { client } = setup(() => brokenBody(() => new TypeError('network error')));
    const error = await failureOf(client.call(routes.meGet));

    expect(error).toMatchObject({ kind: 'network', status: null });
  });

  it('maps the caller aborting to an aborted error', async () => {
    const { client } = setup(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = failureOf(client.call(routes.meGet, undefined, { signal: controller.signal }));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      kind: 'aborted',
      status: null,
      code: 'ABORTED',
    });
  });

  it('maps an already aborted signal to an aborted error, whatever its reason', async () => {
    const { client } = setup();
    const signal = AbortSignal.abort(new Error('route changed'));
    const error = await failureOf(client.call(routes.meGet, undefined, { signal }));

    expect(error).toMatchObject({ kind: 'aborted', code: 'ABORTED' });
  });

  it('maps an abort while the body is read to an aborted error', async () => {
    const controller = new AbortController();
    const { client } = setup(() =>
      brokenBody(() => {
        controller.abort();
        return controller.signal.reason;
      }),
    );
    const error = await failureOf(
      client.call(routes.meGet, undefined, { signal: controller.signal }),
    );

    expect(error).toMatchObject({ kind: 'aborted' });
  });
});

describe('401', () => {
  it('does not end the session on request-code or verify', async () => {
    const { client, onUnauthorized } = setup(() => failure(401, 'INVALID_CODE'));
    await settle(client.call(routes.authRequestCode, { body: { email: 'a@example.com' } }));
    await settle(
      client.call(routes.authVerify, { body: { email: 'a@example.com', code: '123456' } }),
    );

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls the hook before the error is thrown', async () => {
    const order: string[] = [];
    const fake = fakeFetch(() => failure(401, 'UNAUTHENTICATED'));
    const client = createApiClient({ fetch: fake.fetch, onUnauthorized: () => order.push('hook') });
    await client.call(routes.meGet).catch(() => order.push('thrown'));

    expect(order).toEqual(['hook', 'thrown']);
  });

  it('still throws without a hook', async () => {
    const fake = fakeFetch(() => failure(401, 'UNAUTHENTICATED'));
    const error = await failureOf(createApiClient({ fetch: fake.fetch }).call(routes.meGet));

    expect(error.status).toBe(401);
  });

  it.each([400, 403, 404, 409, 429, 500, 503])('ignores a %i', async (status) => {
    const { client, onUnauthorized } = setup(() => failure(status, 'INTERNAL'));
    await settle(client.call(routes.meGet));

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');

  it.each([
    ['0', 0],
    ['7', 7000],
    ['120', 120_000],
    [' 5 ', 5000],
    ['Thu, 08 Oct 2026 12:01:00 GMT', 60_000],
    ['Thu, 08 Oct 2026 11:00:00 GMT', 0],
    [null, null],
    ['', null],
    ['-3', null],
    ['1.5', null],
    ['soon', null],
  ] as const)('reads %j as %j ms', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});
