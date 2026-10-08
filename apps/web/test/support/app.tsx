import type { Me } from '@bantoozi/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App, createAppServices } from '../../src/app.js';
import { createI18n, type Language } from '../../src/i18n/index.js';
import { failure, fakeFetch, json, type RecordedRequest } from '../api/fake-fetch.js';

/** Answers one API operation; `params` holds the `:name` segments of its pattern. */
export type ApiRouteHandler = (
  request: RecordedRequest,
  params: Record<string, string>,
) => Response | Promise<Response>;

export interface FakeServer {
  /** `GET /me`: null answers 401 (signed out). */
  me: Me | null;
  /** Keyed by `METHOD /path` without `/api/v1`, e.g. `'POST /articles/:id/rating'`. */
  routes: Record<string, ApiRouteHandler>;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? '';
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

/**
 * A fake API: `GET /me` from `server.me`, every other operation from `server.routes`, and 404
 * `NOT_FOUND` for anything unhandled (listed in `unhandled`, so a test can assert there was none).
 * Mutate `server` during a test to change later answers.
 */
export function createFakeServer(server: FakeServer) {
  const unhandled: string[] = [];
  const handler = (request: RecordedRequest) => {
    const path = request.pathname.replace(/^\/api\/v1/, '');
    const operation = `${request.method} ${path}`;
    if (operation === 'GET /me') {
      return server.me === null ? failure(401, 'UNAUTHENTICATED') : json(200, server.me);
    }
    for (const [key, route] of Object.entries(server.routes)) {
      const [method, pattern = ''] = key.split(' ');
      if (method !== request.method) continue;
      const params = matchPath(pattern, path);
      if (params !== null) return route(request, params);
    }
    unhandled.push(operation);
    return failure(404, 'NOT_FOUND');
  };
  return { server, handler, unhandled };
}

/** The JSON body of a recorded request. */
export function bodyOf(request: RecordedRequest): unknown {
  return typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
}

/**
 * Boots the real app (providers, router, guards, layouts) at `path` against a fake API, as main.tsx
 * does in the browser. Queries do not retry, so error states show at once.
 */
export async function renderApp(options: {
  path: string;
  server: FakeServer;
  language?: Language;
}) {
  const fake = createFakeServer(options.server);
  const fetched = fakeFetch(fake.handler);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const services = createAppServices({
    i18n: createI18n(options.language ?? 'en'),
    fetch: fetched.fetch,
    history: createMemoryHistory({ initialEntries: [options.path] }),
    queryClient,
  });
  await services.router.load();
  const user = userEvent.setup();
  const view = render(<App services={services} />);
  return {
    ...view,
    ...services,
    user,
    requests: fetched.requests,
    unhandled: fake.unhandled,
    /** Requests of one operation, e.g. `calls('POST /articles/:id/rating')`. */
    calls: (key: string) => {
      const [method, pattern = ''] = key.split(' ');
      return fetched.requests.filter(
        (request) =>
          request.method === method &&
          matchPath(pattern, request.pathname.replace(/^\/api\/v1/, '')) !== null,
      );
    },
  };
}
