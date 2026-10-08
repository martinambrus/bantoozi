import type { Me } from '@bantoozi/shared';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { afterEach } from 'vitest';

import { createQueryClient } from '../../src/api/query-client.js';
import { createI18n } from '../../src/i18n/index.js';
import { onAccountReset, type ResetReason } from '../../src/session/reset.js';
import { createSession, type Session } from '../../src/session/session.js';
import {
  failure,
  fakeFetch,
  json,
  noContent,
  type FakeHandler,
  type RecordedRequest,
} from '../api/fake-fetch.js';

/** What the server knows: who the session cookie belongs to, who a code verifies as, and logout. */
export interface Server {
  me: Me | null;
  verifiesAs?: Me;
  /** Answers `POST /auth/logout`; the default signs the cookie out. */
  logout?: (request: RecordedRequest) => Response | Promise<Response>;
  /** Refuses every request as a browser without a connection does. */
  offline?: boolean;
}

function handlerFor(server: Server): FakeHandler {
  return (request) => {
    if (server.offline === true) throw new TypeError('Failed to fetch');
    const operation = `${request.method} ${request.pathname.replace('/api/v1', '')}`;
    switch (operation) {
      case 'GET /me':
        return server.me === null ? failure(401, 'UNAUTHENTICATED') : json(200, server.me);
      case 'POST /auth/verify':
        if (server.verifiesAs === undefined) return failure(400, 'INVALID_CODE');
        server.me = server.verifiesAs;
        return json(200, { user: server.me });
      case 'POST /auth/logout': {
        if (server.logout !== undefined) return server.logout(request);
        if (server.me === null) return failure(401, 'UNAUTHENTICATED');
        server.me = null;
        return noContent();
      }
      default:
        return server.me === null ? failure(401, 'UNAUTHENTICATED') : json(200, {});
    }
  };
}

/** Sessions of one test file against a fake API; they are disposed after each test. */
export function trackSessions() {
  const sessions: Session[] = [];
  const unregister: Array<() => void> = [];

  afterEach(() => {
    onlineManager.setOnline(true);
    for (const session of sessions.splice(0)) session.dispose();
    for (const stop of unregister.splice(0)) stop();
  });

  return {
    /** A new session, as the page makes one when it starts. Queries do not retry. */
    start(server: Server, options: { retry?: boolean } = {}) {
      const fake = fakeFetch(handlerFor(server));
      const queryClient =
        options.retry === true
          ? createQueryClient()
          : new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            });
      const session = createSession({ queryClient, i18n: createI18n('en'), fetch: fake.fetch });
      sessions.push(session);
      return { ...fake, queryClient, session, server };
    },
    recordResets() {
      const reasons: ResetReason[] = [];
      unregister.push(
        onAccountReset((reason) => {
          reasons.push(reason);
        }),
      );
      return reasons;
    },
    onReset(hook: Parameters<typeof onAccountReset>[0]) {
      unregister.push(onAccountReset(hook));
    },
  };
}

export const requestsTo = (requests: RecordedRequest[], operation: string) =>
  requests.filter((request) => `${request.method} ${request.pathname}` === operation);

/** The operations asked for, in order, e.g. `POST /auth/logout`. */
export const operationsOf = (requests: RecordedRequest[]) =>
  requests.map((request) => `${request.method} ${request.pathname.replace('/api/v1', '')}`);
