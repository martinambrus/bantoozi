import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../src/api/query-client.js';
import { routes } from '../../src/api/routes.js';
import { createI18n } from '../../src/i18n/index.js';
import { createAppRouter } from '../../src/router.js';
import { SESSION_CHANNEL, createSession, type Session } from '../../src/session/session.js';
import { failure, fakeFetch, json, noContent } from '../api/fake-fetch.js';
import { makeMe } from './fixtures.js';

const sessions: Session[] = [];
const channels: BroadcastChannel[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const channel of channels.splice(0)) channel.close();
});

/** What main.tsx does: a router whose guards ask the session, and which a sign-in or out wakes. */
async function openApp(path: string) {
  let signedIn = true;
  const fake = fakeFetch((request) => {
    if (request.pathname.endsWith('/auth/logout')) {
      signedIn = false;
      return noContent();
    }
    return signedIn ? json(200, makeMe()) : failure(401, 'UNAUTHENTICATED');
  });
  const queryClient = createQueryClient();
  const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
  sessions.push(session);
  const router = createAppRouter(
    { queryClient, loadMe: session.loadMe },
    createMemoryHistory({ initialEntries: [path] }),
  );
  session.subscribe(() => void router.invalidate());
  await router.load();
  expect(router.state.location.href).toBe(path);
  return { router, session, expire: () => (signedIn = false) };
}

const loginWithRedirect = (path: string) => `/login?redirect=${encodeURIComponent(path)}`;

describe('the router follows the session', () => {
  it('goes to /login when a request finds the session ended', async () => {
    const { router, session, expire } = await openApp('/read/maybe');
    expire();

    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });

    await vi.waitFor(() =>
      expect(router.state.location.href).toBe(loginWithRedirect('/read/maybe')),
    );
  });

  it('goes to /login when the user signs out', async () => {
    const { router, session } = await openApp('/read/maybe');

    await session.logout();

    await vi.waitFor(() =>
      expect(router.state.location.href).toBe(loginWithRedirect('/read/maybe')),
    );
  });

  it('goes to /login when another tab signs out', async () => {
    const { router } = await openApp('/read/maybe');
    const tab = new BroadcastChannel(SESSION_CHANNEL);
    channels.push(tab);

    tab.postMessage({ type: 'reset' });

    await vi.waitFor(() =>
      expect(router.state.location.href).toBe(loginWithRedirect('/read/maybe')),
    );
  });
});
