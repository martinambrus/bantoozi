import type { Me } from '@bantoozi/shared';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../src/api/query-client.js';
import { accountKey, meKey } from '../../src/api/query-keys.js';
import { routes } from '../../src/api/routes.js';
import { createI18n, type Language } from '../../src/i18n/index.js';
import { onAccountReset, type ResetReason } from '../../src/session/reset.js';
import { SESSION_CHANNEL, createSession, type Session } from '../../src/session/session.js';
import {
  failure,
  fakeFetch,
  json,
  noContent,
  type FakeHandler,
  type RecordedRequest,
} from '../api/fake-fetch.js';
import { USER_A_ID, USER_B_ID, makeMe } from './fixtures.js';

const userA = makeMe();
const userB = makeMe({ id: USER_B_ID, email: 'b@example.com' });

/** What the server knows: who the session cookie belongs to, and who a code verifies as. */
interface Server {
  me: Me | null;
  verifiesAs?: Me;
}

function api(server: Server): FakeHandler {
  return (request) => {
    const operation = `${request.method} ${request.pathname.replace('/api/v1', '')}`;
    switch (operation) {
      case 'GET /me':
        return server.me === null ? failure(401, 'UNAUTHENTICATED') : json(200, server.me);
      case 'POST /auth/request-code':
        return json(200, { next: 'check_email' });
      case 'POST /auth/verify':
        if (server.verifiesAs === undefined) return failure(400, 'INVALID_CODE');
        server.me = server.verifiesAs;
        return json(200, { user: server.me });
      case 'POST /auth/logout':
        if (server.me === null) return failure(401, 'UNAUTHENTICATED');
        server.me = null;
        return noContent();
      default:
        return server.me === null ? failure(401, 'UNAUTHENTICATED') : json(200, {});
    }
  };
}

const sessions: Session[] = [];
const channels: BroadcastChannel[] = [];
const unregister: (() => void)[] = [];

afterEach(() => {
  onlineManager.setOnline(true);
  for (const session of sessions.splice(0)) session.dispose();
  for (const channel of channels.splice(0)) channel.close();
  for (const stop of unregister.splice(0)) stop();
  document.documentElement.lang = '';
});

function start(server: Server = { me: null }, language: Language = 'en') {
  const fake = fakeFetch(api(server));
  const queryClient = createQueryClient();
  const i18n = createI18n(language);
  const session = createSession({ queryClient, i18n, fetch: fake.fetch });
  sessions.push(session);
  return { ...fake, queryClient, i18n, session, server };
}

/** A signed-in session with some private data in the cache. */
async function startSignedIn(me: Me = userA) {
  const started = start({ me });
  await started.session.loadMe();
  started.queryClient.setQueryData(accountKey(me.id, 'articles', 'list'), ['row']);
  return started;
}

/** What another tab of the browser hears and says on the session channel. */
function otherTab() {
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  const heard: unknown[] = [];
  channel.onmessage = (event: MessageEvent<unknown>) => heard.push(event.data);
  channels.push(channel);
  return { channel, heard };
}

function recordResets() {
  const reasons: ResetReason[] = [];
  unregister.push(
    onAccountReset((reason) => {
      reasons.push(reason);
    }),
  );
  return reasons;
}

const keysOf = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey);

const requestsTo = (requests: RecordedRequest[], operation: string) =>
  requests.filter((request) => `${request.method} ${request.pathname}` === operation);

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('loadMe', () => {
  it('resolves to the account and caches it', async () => {
    const { session, queryClient, requests } = start({ me: userA });

    await expect(session.loadMe()).resolves.toEqual(userA);
    await expect(session.loadMe()).resolves.toEqual(userA);

    expect(queryClient.getQueryData(meKey())).toEqual(userA);
    expect(requestsTo(requests, 'GET /api/v1/me')).toHaveLength(1);
  });

  it('resolves a 401 to null, caches it and resets nothing', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient, requests } = start({ me: null });

    await expect(session.loadMe()).resolves.toBeNull();
    await expect(session.loadMe()).resolves.toBeNull();
    await settle();

    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(requestsTo(requests, 'GET /api/v1/me')).toHaveLength(1);
    expect(resets).toEqual([]);
    expect(tab.heard).toEqual([]);
  });

  it('asks even while the browser believes it is offline', async () => {
    onlineManager.setOnline(false);
    const { session } = start({ me: userA });

    await expect(session.loadMe()).resolves.toEqual(userA);
  });

  it('rejects when the server cannot be reached', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
    sessions.push(session);

    await expect(session.loadMe()).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('language', () => {
  it('applies the locale of the account to i18next and the document', async () => {
    const { session, i18n } = start({ me: makeMe({ locale: 'sk' }) }, 'en');

    await session.loadMe();

    await vi.waitFor(() => expect(i18n.language).toBe('sk'));
    expect(document.documentElement.lang).toBe('sk');
  });

  it('follows the locale when the cached account changes', async () => {
    const { session, i18n, queryClient } = start({ me: makeMe({ locale: 'sk' }) }, 'en');
    await session.loadMe();

    queryClient.setQueryData(meKey(), makeMe({ locale: 'en' }));

    await vi.waitFor(() => expect(i18n.language).toBe('en'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps the language of the browser while nobody is signed in', async () => {
    const { session, i18n } = start({ me: null }, 'sk');
    document.documentElement.lang = 'sk';

    await session.loadMe();

    expect(i18n.language).toBe('sk');
    expect(document.documentElement.lang).toBe('sk');
  });
});

describe('requestCode', () => {
  it('posts the address, the invite code and the locale', async () => {
    const { session, requests } = start();

    await expect(
      session.requestCode({ email: 'a@example.com', inviteCode: 'ABCDEFGHJK', locale: 'sk' }),
    ).resolves.toEqual({ next: 'check_email' });

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.pathname).toBe('/api/v1/auth/request-code');
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      email: 'a@example.com',
      inviteCode: 'ABCDEFGHJK',
      locale: 'sk',
    });
    expect(requests[0]?.headers.get('idempotency-key')).toBeNull();
  });

  it.each([undefined, ''])('leaves out an invite code of %j', async (inviteCode) => {
    const { session, requests } = start();

    await session.requestCode({ email: 'a@example.com', inviteCode, locale: 'en' });

    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      email: 'a@example.com',
      locale: 'en',
    });
  });

  it('reports a rate limit as an error with its delay', async () => {
    const fake = fakeFetch(() => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '30' }));
    const session = createSession({
      queryClient: createQueryClient(),
      i18n: createI18n(),
      fetch: fake.fetch,
    });
    sessions.push(session);

    await expect(
      session.requestCode({ email: 'a@example.com', locale: 'en' }),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterMs: 30_000 });
  });
});

describe('verifyCode', () => {
  it('signs in: returns the account and seeds the cache', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient, requests } = start({ me: null, verifiesAs: userA });
    await session.loadMe();

    await expect(session.verifyCode({ email: 'a@example.com', code: '123456' })).resolves.toEqual(
      userA,
    );
    await settle();

    expect(queryClient.getQueryData(meKey())).toEqual(userA);
    expect(JSON.parse(String(requests.at(-1)?.body))).toEqual({
      email: 'a@example.com',
      code: '123456',
    });
    expect(resets).toEqual([]);
    expect(tab.heard).toEqual([]);
  });

  it('leaves the state alone when the code is wrong', async () => {
    const resets = recordResets();
    const { session, queryClient } = start({ me: null });
    await session.loadMe();

    await expect(
      session.verifyCode({ email: 'a@example.com', code: '000000' }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_CODE' });

    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(resets).toEqual([]);
  });

  it('drops the old account first when another one signs in', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient, server } = await startSignedIn(userA);
    server.verifiesAs = userB;

    await session.verifyCode({ email: 'b@example.com', code: '123456' });

    expect(resets).toEqual(['account_switch']);
    expect(queryClient.getQueryData(accountKey(USER_A_ID, 'articles', 'list'))).toBeUndefined();
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
    expect(keysOf(queryClient)).toEqual([meKey()]);
    await vi.waitFor(() => expect(tab.heard).toEqual([{ type: 'reset' }]));
  });

  it('drops the old account when a refetch of /me answers for another one', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { queryClient, server } = await startSignedIn(userA);
    server.me = userB;

    await queryClient.refetchQueries({ queryKey: meKey() });

    await vi.waitFor(() => expect(resets).toEqual(['account_switch']));
    expect(queryClient.getQueryData(accountKey(USER_A_ID, 'articles', 'list'))).toBeUndefined();
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
    await vi.waitFor(() => expect(tab.heard).toEqual([{ type: 'reset' }]));
  });

  it('is not a switch when a refetch of /me answers for the same account', async () => {
    const resets = recordResets();
    const { queryClient } = await startSignedIn(userA);

    await queryClient.refetchQueries({ queryKey: meKey() });
    await settle();

    expect(resets).toEqual([]);
    expect(queryClient.getQueryData(accountKey(USER_A_ID, 'articles', 'list'))).toEqual(['row']);
  });

  it('drops the old account when another one signs in after the session ended', async () => {
    const { session, queryClient, server, requests } = await startSignedIn(userA);
    server.me = null;
    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });
    const resets = recordResets();
    queryClient.setQueryData(accountKey(USER_A_ID, 'articles', 'list'), ['late response']);
    server.verifiesAs = userB;

    await session.verifyCode({ email: 'b@example.com', code: '123456' });

    expect(resets).toEqual(['account_switch']);
    expect(queryClient.getQueryData(accountKey(USER_A_ID, 'articles', 'list'))).toBeUndefined();
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
    expect(requestsTo(requests, 'POST /api/v1/auth/verify')).toHaveLength(1);
  });

  it('is not a switch when the same account signs back in after the session ended', async () => {
    const { session, queryClient, server } = await startSignedIn(userA);
    server.me = null;
    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });
    const resets = recordResets();
    server.verifiesAs = userA;

    await session.verifyCode({ email: 'a@example.com', code: '123456' });

    expect(resets).toEqual([]);
    expect(queryClient.getQueryData(meKey())).toEqual(userA);
  });

  it('does not remember an account across a logout', async () => {
    const { session, server } = await startSignedIn(userA);
    await session.logout();
    const resets = recordResets();
    server.verifiesAs = userB;

    await session.verifyCode({ email: 'b@example.com', code: '123456' });

    expect(resets).toEqual([]);
  });
});

describe('logout', () => {
  it('posts {} and resets', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient, requests, server } = await startSignedIn(userA);

    await session.logout();

    const request = requestsTo(requests, 'POST /api/v1/auth/logout')[0];
    expect(request?.body).toBe('{}');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('x-bantoozi-client')).toBe('web');
    expect(server.me).toBeNull();
    expect(resets).toEqual(['logout']);
    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(keysOf(queryClient)).toEqual([meKey()]);
    await vi.waitFor(() => expect(tab.heard).toEqual([{ type: 'reset' }]));
  });

  it('counts a 401 as signed out already', async () => {
    const { session, queryClient, server } = await startSignedIn(userA);
    server.me = null;
    const resets = recordResets();

    await expect(session.logout()).resolves.toBeUndefined();

    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(resets).toEqual(['unauthorized', 'logout']);
  });

  it('keeps everything when the server cannot be reached', async () => {
    const resets = recordResets();
    let offline = false;
    const fake = fakeFetch((request) => {
      if (offline) throw new TypeError('Failed to fetch');
      return api({ me: userA })(request);
    });
    const queryClient = createQueryClient();
    const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
    sessions.push(session);
    await session.loadMe();
    offline = true;

    await expect(session.logout()).rejects.toMatchObject({ kind: 'network' });

    expect(queryClient.getQueryData(meKey())).toEqual(userA);
    expect(resets).toEqual([]);
  });
});

describe('a 401', () => {
  it('ends the session: drops the state, tells the stores and the other tabs', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient, server } = await startSignedIn(userA);
    server.me = null;

    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });

    expect(resets).toEqual(['unauthorized']);
    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(keysOf(queryClient)).toEqual([meKey()]);
    await vi.waitFor(() => expect(tab.heard).toEqual([{ type: 'reset' }]));
  });

  it('changes nothing when nobody is signed in', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session } = start({ me: null });
    await session.loadMe();

    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });
    await settle();

    expect(resets).toEqual([]);
    expect(tab.heard).toEqual([]);
  });

  it('does not end the session when the code is wrong', async () => {
    const resets = recordResets();
    const { session, queryClient } = await startSignedIn(userA);

    await expect(
      session.verifyCode({ email: 'a@example.com', code: '000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });

    expect(resets).toEqual([]);
    expect(queryClient.getQueryData(meKey())).toEqual(userA);
  });
});

describe('resetAccountState', () => {
  it('clears the cache, runs the hooks, tells the other tabs and signs out', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { session, queryClient } = await startSignedIn(userA);

    await session.resetAccountState();

    expect(keysOf(queryClient)).toEqual([meKey()]);
    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(resets).toEqual(['logout']);
    await vi.waitFor(() => expect(tab.heard).toEqual([{ type: 'reset' }]));
  });

  it('settles after the asynchronous hooks have', async () => {
    const order: string[] = [];
    unregister.push(
      onAccountReset(async () => {
        await settle();
        order.push('hook done');
      }),
    );
    const { session } = start();

    await session.resetAccountState();
    order.push('reset done');

    expect(order).toEqual(['hook done', 'reset done']);
  });

  it('runs the other hooks when one fails', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    unregister.push(
      onAccountReset(() => {
        throw new Error('disk full');
      }),
    );
    const resets = recordResets();
    const { session } = start();

    await expect(session.resetAccountState()).resolves.toBeUndefined();

    expect(resets).toEqual(['logout']);
    expect(report).toHaveBeenCalledTimes(1);
    report.mockRestore();
  });

  it('stops calling a hook once it is unregistered', async () => {
    const hook = vi.fn();
    const stop = onAccountReset(hook);
    const { session } = start();

    await session.resetAccountState();
    stop();
    await session.resetAccountState();

    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe('another tab', () => {
  it('resets this one when it broadcasts a reset', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { queryClient } = await startSignedIn(userA);

    tab.channel.postMessage({ type: 'reset' });

    await vi.waitFor(() => expect(queryClient.getQueryData(meKey())).toBeNull());
    expect(keysOf(queryClient)).toEqual([meKey()]);
    expect(resets).toEqual(['remote']);
    await settle();
    expect(tab.heard).toEqual([]);
  });

  it('answers nobody when it ends the session while the first answer is on its way', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const fake = fakeFetch(async () => {
      await answered;
      return json(200, userA);
    });
    const queryClient = createQueryClient();
    const session = createSession({ queryClient, i18n: createI18n(), fetch: fake.fetch });
    sessions.push(session);
    const tab = otherTab();

    const loading = session.loadMe();
    tab.channel.postMessage({ type: 'reset' });

    await expect(loading).resolves.toBeNull();
    answer();
    await settle();
    expect(queryClient.getQueryData(meKey())).toBeNull();
  });

  it('ignores any other message', async () => {
    const resets = recordResets();
    const tab = otherTab();
    const { queryClient } = await startSignedIn(userA);

    tab.channel.postMessage({ type: 'hello' });
    tab.channel.postMessage('reset');
    tab.channel.postMessage(null);
    await settle();

    expect(queryClient.getQueryData(meKey())).toEqual(userA);
    expect(resets).toEqual([]);
  });

  it('signs out a second session of the browser once, without echoes', async () => {
    const first = await startSignedIn(userA);
    const second = await startSignedIn(userA);
    const resets = recordResets();
    const tab = otherTab();

    await first.session.logout();

    await vi.waitFor(() => expect(second.queryClient.getQueryData(meKey())).toBeNull());
    await settle();
    expect(resets).toEqual(['logout', 'remote']);
    expect(tab.heard).toEqual([{ type: 'reset' }]);
  });

  it('stops listening after dispose', async () => {
    const tab = otherTab();
    const { session, queryClient } = await startSignedIn(userA);

    session.dispose();
    tab.channel.postMessage({ type: 'reset' });
    await settle();

    expect(queryClient.getQueryData(meKey())).toEqual(userA);
  });
});

describe('subscribe', () => {
  it('is told when someone signs in or out, not about the first answer', async () => {
    const { session, queryClient, server } = start({ me: userA });
    const listener = vi.fn();
    session.subscribe(listener);

    await session.loadMe();
    expect(listener).not.toHaveBeenCalled();

    await session.logout();
    expect(listener).toHaveBeenCalledTimes(1);

    server.verifiesAs = userB;
    await session.verifyCode({ email: 'b@example.com', code: '123456' });
    expect(listener).toHaveBeenCalledTimes(2);

    queryClient.setQueryData(meKey(), { ...userB, displayName: 'Bea' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('is told about the end of a session by a 401', async () => {
    const { session, server } = await startSignedIn(userA);
    const listener = vi.fn();
    session.subscribe(listener);
    server.me = null;

    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { session } = await startSignedIn(userA);
    const listener = vi.fn();
    const stop = session.subscribe(listener);

    stop();
    await session.logout();

    expect(listener).not.toHaveBeenCalled();
  });
});
