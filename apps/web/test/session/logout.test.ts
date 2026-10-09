import { screen, waitFor } from '@testing-library/react';
import { IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { readView, saveDetail, saveView, setOfflineEnabled } from '../../src/offline/cache.js';
import { LAST_ACCOUNT_KEY, PENDING_LOGOUT_KEY } from '../../src/offline/names.js';
import { listRecords, putRecord } from '../../src/offline/queue.js';
import { failure, noContent } from '../api/fake-fetch.js';
import { READER_READS, createHarness } from '../auth/harness.js';
import {
  A,
  T0,
  VIEW,
  dumpDatabase,
  fullDetail,
  itemList,
  localKeysOf,
  makeRecord,
  rowsOf,
  freshIndexedDb,
} from '../offline/support.js';
import type { ApiRouteHandler } from '../support/app.js';
import { makeMe } from './fixtures.js';
import { operationsOf, requestsTo, trackSessions, type Server } from './support.js';

const userA = makeMe({ displayName: 'Ada Lovelace', email: 'ada@example.com' });
const NOTICE =
  'Signed out on this device. Bantoozi will finish signing you out when you are back online.';

const idb = freshIndexedDb();
const sessions = trackSessions();
const { open } = createHarness();

async function seed(id: string) {
  await setOfflineEnabled(id, true);
  await saveView(id, 'view', itemList(2), VIEW);
  await saveDetail(id, fullDetail());
  await putRecord(makeRecord('m1', { accountId: id }));
  localStorage.setItem(`${id}:interests:keep:5:2`, '1');
  localStorage.setItem(`${id}:feeds:dead-feed-dismissed:9:2026-10-01`, '1');
}

const isPending = () => localStorage.getItem(PENDING_LOGOUT_KEY) !== null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('signing out', () => {
  it('asks the server to end the session, wipes the device and says it did', async () => {
    const { session, server, requests, queryClient } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);

    await expect(session.logout()).resolves.toEqual({ serverSignedOut: true });

    expect(requestsTo(requests, 'POST /api/v1/auth/logout')).toHaveLength(1);
    expect(server.me).toBeNull();
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(isPending()).toBe(false);
    expect(queryClient.getQueryData(meKey())).toBeNull();
  });

  it('counts a 401 as signed out on the server already', async () => {
    const { session } = sessions.start({
      me: userA,
      logout: () => failure(401, 'UNAUTHENTICATED'),
    });
    await session.loadMe();
    await seed(A);

    await expect(session.logout()).resolves.toEqual({ serverSignedOut: true });

    expect(isPending()).toBe(false);
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
  });

  it('removes at the next start what could not be removed at sign-out, and uses none of it meanwhile', async () => {
    const { session } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    const stuck = vi.spyOn(FakeIDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new DOMException('The disk is not available.', 'UnknownError');
    });
    onTestFinished(() => {
      stuck.mockRestore();
    });

    await expect(session.logout()).resolves.toEqual({ serverSignedOut: true });

    expect(rowsOf(await dumpDatabase(idb.factory), A)).not.toEqual([]);
    expect(await readView(A, 'view')).toBeNull();
    expect(await listRecords(A)).toEqual([]);

    stuck.mockRestore();
    sessions.start({ me: null });

    await vi.waitFor(async () => expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]));
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server error', () => failure(500, 'INTERNAL')],
    ['an unavailable server', () => failure(503, 'UNAVAILABLE')],
    ['a rate limit', () => failure(429, 'RATE_LIMITED', undefined, { 'retry-after': '30' })],
  ])('signs out on this device at once after %s', async (_name, logout) => {
    const resets = sessions.recordResets();
    const { session, queryClient, requests } = sessions.start({ me: userA, logout });
    await session.loadMe();
    await seed(A);

    await expect(session.logout()).resolves.toEqual({ serverSignedOut: false });

    expect(requestsTo(requests, 'POST /api/v1/auth/logout')).toHaveLength(1);
    expect(resets).toEqual(['logout']);
    expect(queryClient.getQueryData(meKey())).toBeNull();
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
    expect(isPending()).toBe(true);
  });

  it.each([
    ['a 403', () => failure(403, 'FORBIDDEN')],
    ['a 400', () => failure(400, 'VALIDATION_FAILED')],
  ])('keeps everything after %s, which is not about the connection', async (_name, logout) => {
    const resets = sessions.recordResets();
    const { session, queryClient } = sessions.start({ me: userA, logout });
    await session.loadMe();
    await seed(A);
    const before = rowsOf(await dumpDatabase(idb.factory), A);

    await expect(session.logout()).rejects.toMatchObject({ status: expect.any(Number) });

    expect(resets).toEqual([]);
    expect(queryClient.getQueryData(meKey())).toEqual(userA);
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual(before);
    expect(isPending()).toBe(false);
  });
});

describe('a sign-out that has not reached the server', () => {
  /** What a sign-out without a connection left behind: the local data is gone, the marker is set. */
  function signedOutOffline() {
    localStorage.setItem(PENDING_LOGOUT_KEY, String(T0));
  }

  it('makes a restarted page answer nobody without asking /me', async () => {
    signedOutOffline();
    const restarted = sessions.start({
      me: userA,
      logout: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await expect(restarted.session.loadMe()).resolves.toBeNull();

    expect(operationsOf(restarted.requests)).not.toContain('GET /me');
    expect(restarted.queryClient.getQueryData(meKey())).toBeUndefined();
  });

  it('is finished when the page starts online: the server session ends, the marker goes', async () => {
    signedOutOffline();

    const restarted = sessions.start({ me: userA });
    await restarted.session.loadMe();

    await vi.waitFor(() => expect(isPending()).toBe(false));
    expect(operationsOf(restarted.requests)).toEqual(['POST /auth/logout']);
    expect(restarted.server.me).toBeNull();
  });

  it('is finished when the browser comes back online', async () => {
    signedOutOffline();
    const server: Server = { me: userA, offline: true };
    const restarted = sessions.start(server);
    await vi.waitFor(() =>
      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
    );
    await settle();
    expect(isPending()).toBe(true);

    server.offline = false;
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(isPending()).toBe(false));
    expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(2);
    expect(server.me).toBeNull();
  });

  it('counts a 401 on the pending sign-out as done', async () => {
    signedOutOffline();

    const restarted = sessions.start({ me: null });
    await restarted.session.loadMe();

    await vi.waitFor(() => expect(isPending()).toBe(false));
    expect(operationsOf(restarted.requests)).toEqual(['POST /auth/logout']);
  });

  it('stays pending after a server error and is tried again later', async () => {
    signedOutOffline();
    let answer = () => failure(500, 'INTERNAL');
    const restarted = sessions.start({ me: userA, logout: () => answer() });
    await vi.waitFor(() =>
      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
    );
    await settle();
    expect(isPending()).toBe(true);

    answer = () => noContent();
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(isPending()).toBe(false));
  });

  it('is finished before a new sign-in: POST /auth/logout comes first, then POST /auth/verify', async () => {
    signedOutOffline();
    const server: Server = {
      me: userA,
      verifiesAs: makeMe({ id: A, email: 'ada@example.com' }),
      offline: true,
    };
    const restarted = sessions.start(server);
    await vi.waitFor(() =>
      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
    );
    await settle();
    server.offline = false;

    await restarted.session.verifyCode({ email: 'ada@example.com', code: '123456' });

    expect(operationsOf(restarted.requests)).toEqual([
      'POST /auth/logout',
      'POST /auth/logout',
      'POST /auth/verify',
    ]);
    expect(isPending()).toBe(false);
    expect(restarted.queryClient.getQueryData(meKey())).toEqual(server.verifiesAs);
  });

  it('is not skipped by a new sign-in: nobody signs in while it cannot be finished', async () => {
    signedOutOffline();
    const restarted = sessions.start({
      me: userA,
      verifiesAs: userA,
      logout: () => failure(503, 'UNAVAILABLE'),
    });
    await vi.waitFor(() =>
      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
    );
    await settle();

    await expect(
      restarted.session.verifyCode({ email: 'ada@example.com', code: '123456' }),
    ).rejects.toMatchObject({ status: 503 });

    expect(requestsTo(restarted.requests, 'POST /api/v1/auth/verify')).toHaveLength(0);
    expect(isPending()).toBe(true);
    expect(restarted.queryClient.getQueryData(meKey())).toBeUndefined();
  });

  it('waits for the connection while the browser reports it is offline', async () => {
    signedOutOffline();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const restarted = sessions.start({ me: userA });
    await restarted.session.loadMe();

    expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(0);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(isPending()).toBe(false));
    online.mockRestore();
  });

  describe('while the browser stays online', () => {
    // A server that answers again sends no `online` event: only the page can try again.
    function fakeTimers() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
    }

    it('is sent again once the Retry-After of a refused sign-out has passed, and not sooner', async () => {
      let answer = () => failure(503, 'UNAVAILABLE', undefined, { 'retry-after': '7' });
      const { session, requests } = sessions.start({ me: userA, logout: () => answer() });
      await session.loadMe();
      fakeTimers();
      await expect(session.logout()).resolves.toEqual({ serverSignedOut: false });
      answer = () => noContent();

      await vi.advanceTimersByTimeAsync(6_999);
      expect(requestsTo(requests, 'POST /api/v1/auth/logout')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(requestsTo(requests, 'POST /api/v1/auth/logout')).toHaveLength(2);
      await vi.waitFor(() => expect(isPending()).toBe(false));
    });

    it('waits twice as long after each failure while the server keeps failing', async () => {
      signedOutOffline();
      let answer = () => failure(500, 'INTERNAL');
      fakeTimers();
      const restarted = sessions.start({ me: userA, logout: () => answer() });
      const sent = () => requestsTo(restarted.requests, 'POST /api/v1/auth/logout').length;
      await vi.waitFor(() => expect(sent()).toBe(1));

      await vi.advanceTimersByTimeAsync(1_999);
      expect(sent()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent()).toBe(2);
      answer = () => noContent();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(sent()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);

      expect(sent()).toBe(3);
      await vi.waitFor(() => expect(isPending()).toBe(false));
    });

    it('is not sent again after a refusal that is not about the server being busy', async () => {
      signedOutOffline();
      fakeTimers();
      const restarted = sessions.start({ me: userA, logout: () => failure(403, 'FORBIDDEN') });
      await vi.waitFor(() =>
        expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
      );

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1);
      expect(isPending()).toBe(true);
    });

    it('is not sent again by a page that was closed', async () => {
      signedOutOffline();
      fakeTimers();
      const restarted = sessions.start({ me: userA, logout: () => failure(500, 'INTERNAL') });
      await vi.waitFor(() =>
        expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1),
      );

      restarted.session.dispose();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(requestsTo(restarted.requests, 'POST /api/v1/auth/logout')).toHaveLength(1);
    });
  });
});

describe('the sign-out button', () => {
  const signedIn = (logout: ApiRouteHandler) => ({
    me: userA,
    routes: { ...READER_READS, 'POST /auth/logout': logout },
  });

  async function signOut(app: Awaited<ReturnType<typeof open>>) {
    await app.user.click(screen.getByRole('button', { name: 'Account menu: Ada Lovelace' }));
    await app.user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
  }

  it('without a connection wipes the device, goes to /login and says what is left to do', async () => {
    // Offline, the unsent change seeded here stays unsent; online, the app would send it at once.
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => {
      online.mockRestore();
    });
    await seed(A);
    const app = await open({
      path: '/read/for_you',
      server: signedIn(() => Promise.reject(new TypeError('Failed to fetch'))),
    });

    await signOut(app);

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.queryByText(/session (has )?ended/i)).not.toBeInTheDocument();
    expect(rowsOf(await dumpDatabase(idb.factory), A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(isPending()).toBe(true);
    expect(app.queryClient.getQueryData(meKey())).toBeNull();
  });

  it('with the server reached says nothing of it', async () => {
    const app = await open({ path: '/read/for_you', server: signedIn(() => noContent()) });

    await signOut(app);

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(isPending()).toBe(false);
  });

  it('starts again without asking /me while the sign-out is pending', async () => {
    const first = await open({
      path: '/read/for_you',
      server: signedIn(() => Promise.reject(new TypeError('Failed to fetch'))),
    });
    await signOut(first);
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/login'));
    first.unmount();
    first.session.dispose();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const second = await open({
      path: '/read/for_you',
      server: signedIn(async () => {
        await held;
        return noContent();
      }),
    });

    expect(second.router.state.location.pathname).toBe('/login');
    expect(second.calls('GET /me')).toHaveLength(0);
    release();
    await waitFor(() => expect(isPending()).toBe(false));
    expect(second.calls('POST /auth/logout')).toHaveLength(1);
  });
});
