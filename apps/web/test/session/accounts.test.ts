import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { routes } from '../../src/api/routes.js';
import {
  readMe,
  readView,
  saveDetail,
  saveMe,
  saveView,
  setOfflineEnabled,
} from '../../src/offline/cache.js';
import { isOfflineEnabled } from '../../src/offline/device.js';
import { LAST_ACCOUNT_KEY, OFFLINE_DB, STORES, accountRange } from '../../src/offline/names.js';
import { listRecords, putRecord } from '../../src/offline/queue.js';
import { SESSION_CHANNEL } from '../../src/session/session.js';
import {
  A,
  B,
  T0,
  VIEW,
  dumpDatabase,
  fullDetail,
  itemList,
  localKeysOf,
  makeRecord,
  rowsOf,
  setClock,
  freshIndexedDb,
} from '../offline/support.js';
import { makeMe } from './fixtures.js';
import { requestsTo, trackSessions } from './support.js';

const userA = makeMe();
const userB = makeMe({ id: B, email: 'b@example.com' });

const idb = freshIndexedDb();
const sessions = trackSessions();

/** What an account that chose offline reading leaves on the device. */
async function seed(id: string) {
  await setOfflineEnabled(id, true);
  await saveView(id, 'view', itemList(2), VIEW);
  await saveDetail(id, fullDetail());
  await putRecord(makeRecord('m1', { accountId: id }));
  localStorage.setItem(`${id}:interests:keep:5:2`, '1');
  localStorage.setItem(`${id}:feeds:dead-feed-dismissed:9:2026-10-01`, '1');
}

const rowsOfAccount = async (id: string) => rowsOf(await dumpDatabase(idb.factory), id);
const verifyAsB = (session: { verifyCode: (input: { email: string; code: string }) => unknown }) =>
  session.verifyCode({ email: 'b@example.com', code: '123456' });

describe('the last account of the device', () => {
  it('is written with every account that arrives, and only by id and time', async () => {
    setClock(T0);
    const { session } = sessions.start({ me: userA });

    await session.loadMe();

    expect(JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) ?? 'null')).toEqual({ id: A, at: T0 });
  });

  it('follows the account that signed in last', async () => {
    const { session } = sessions.start({ me: null, verifiesAs: userB });
    await session.loadMe();

    await verifyAsB(session);

    expect(JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) ?? 'null')).toMatchObject({ id: B });
  });

  it('keeps the account for an offline start only when it chose offline reading', async () => {
    const { session, queryClient } = sessions.start({ me: userA });

    await session.loadMe();
    await vi.waitFor(() => expect(localStorage.getItem(LAST_ACCOUNT_KEY)).not.toBeNull());
    expect(await readMe(A)).toBeNull();

    await setOfflineEnabled(A, true);
    await queryClient.refetchQueries({ queryKey: meKey() });

    await vi.waitFor(async () => expect((await readMe(A))?.me).toEqual(userA));
  });
});

describe('when another account signs in', () => {
  it('removes the rows and the stored keys of the previous account before the new one is shown', async () => {
    const { session, queryClient } = sessions.start({ me: userA, verifiesAs: userB });
    await session.loadMe();
    await seed(A);
    localStorage.setItem('unrelated', 'value');

    await verifyAsB(session);

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(localStorage.getItem('unrelated')).toBe('value');
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
  });

  it('does the same when the answer of /me is for another account', async () => {
    const { session, queryClient, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    server.me = userB;

    await queryClient.refetchQueries({ queryKey: meKey() });
    await session.loadMe();

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
  });

  it('shows the new account only once the previous one is removed', async () => {
    const { session, queryClient, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    server.me = userB;
    const shownWhileRemoving: unknown[] = [];
    sessions.onReset(async (reason) => {
      if (reason !== 'account_switch') return;
      await new Promise((resolve) => setTimeout(resolve, 30));
      shownWhileRemoving.push(queryClient.getQueryData(meKey()));
    });

    await queryClient.refetchQueries({ queryKey: meKey() });
    await session.loadMe();

    expect(shownWhileRemoving).toEqual([null]);
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
    expect(await rowsOfAccount(A)).toEqual([]);
  });

  it('knows the previous account from an earlier visit of the page', async () => {
    const earlier = sessions.start({ me: userA });
    await earlier.session.loadMe();
    await seed(A);
    earlier.session.dispose();
    const { session, queryClient } = sessions.start({ me: null, verifiesAs: userB });
    await session.loadMe();

    await verifyAsB(session);

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(queryClient.getQueryData(meKey())).toEqual(userB);
  });

  it('keeps everything when the same account signs in again after an earlier visit', async () => {
    const earlier = sessions.start({ me: userA });
    await earlier.session.loadMe();
    await seed(A);
    earlier.session.dispose();
    const { session } = sessions.start({ me: null, verifiesAs: userA });
    await session.loadMe();

    await session.verifyCode({ email: 'a@example.com', code: '123456' });

    expect((await rowsOfAccount(A)).length).toBeGreaterThan(0);
    expect(localKeysOf(A)).toHaveLength(2);
  });

  it('keeps what the new account writes while the old one is removed', async () => {
    const { session, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    server.verifiesAs = userB;
    sessions.onReset(async (reason) => {
      if (reason !== 'account_switch') return;
      await seed(B);
      await saveMe(B, userB);
    });

    await verifyAsB(session);

    const dump = await dumpDatabase(idb.factory);
    expect(rowsOf(dump, A)).toEqual([]);
    expect(rowsOf(dump, B).length).toBeGreaterThanOrEqual(5);
    expect(localKeysOf(A)).toEqual([]);
    expect(localKeysOf(B)).toHaveLength(2);
    expect((await readView(B, 'view'))?.items).toHaveLength(2);
    expect((await readMe(B))?.me).toEqual(userB);
    expect(await listRecords(B)).toEqual([makeRecord('m1', { accountId: B })]);
  });

  it('keeps the choice to read offline of the old account, which is not its data', async () => {
    const { session, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    server.verifiesAs = userB;

    await verifyAsB(session);

    expect(isOfflineEnabled(A)).toBe(true);
    expect(isOfflineEnabled(B)).toBe(false);
  });
});

describe('when another tab signs in', () => {
  // The tabs share one session cookie, so every request goes out as the account signed in last.
  it('a tab that shows another account takes the new one, once the earlier one is removed', async () => {
    // Both tabs started signed out, so neither knew an account when the other signed in.
    const first = sessions.start({ me: null, verifiesAs: userA });
    const second = sessions.start({ me: null, verifiesAs: userB });
    await first.session.loadMe();
    await second.session.loadMe();
    await first.session.verifyCode({ email: userA.email, code: '123456' });
    await seed(A);

    await verifyAsB(second.session);

    await vi.waitFor(() => expect(first.queryClient.getQueryData(meKey())).toEqual(userB));
    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
  });

  it('leaves a tab that shows nobody signed out', async () => {
    const first = sessions.start({ me: null, verifiesAs: userA });
    const second = sessions.start({ me: null });
    await first.session.loadMe();
    await second.session.loadMe();

    await first.session.verifyCode({ email: userA.email, code: '123456' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(second.queryClient.getQueryData(meKey())).toBeNull();
  });

  it('asks who is signed in when it cannot read the account the other tab sent', async () => {
    const { session, queryClient, server } = sessions.start({ me: userA });
    await session.loadMe();
    server.me = userB;
    const other = new BroadcastChannel(SESSION_CHANNEL);

    other.postMessage({ type: 'signed-in', me: { id: B } });
    await vi.waitFor(() => expect(queryClient.getQueryData(meKey())).toEqual(userB));
    other.close();
  });
});

describe('when another tab drops its account', () => {
  it('a 401 there leaves a tab that shows another account by now, which asks who is signed in', async () => {
    const shown = sessions.start({ me: userB });
    await shown.session.loadMe();
    // The other tab still shows A: it has not heard of the sign-in as B yet.
    localStorage.removeItem(LAST_ACCOUNT_KEY);
    const other = sessions.start({ me: userA });
    await other.session.loadMe();

    other.session.unauthorized(other.session.currentCookie());

    await vi.waitFor(() => expect(requestsTo(shown.requests, 'GET /api/v1/me')).toHaveLength(2));
    expect(shown.queryClient.getQueryData(meKey())).toEqual(userB);
  });
});

describe('when the person signs out', () => {
  it('removes the rows and the stored keys of the account, and nobody elses', async () => {
    const { session } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    await seed(B);
    const beforeB = await rowsOfAccount(B);

    await session.logout();

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
    expect(await rowsOfAccount(B)).toEqual(beforeB);
    expect(localKeysOf(B)).toHaveLength(2);
    expect(localStorage.getItem(LAST_ACCOUNT_KEY)).toBeNull();
  });

  it('does the same after the session had ended, because the account is still known', async () => {
    const { session, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    server.me = null;
    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });

    await session.logout();

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
  });

  it('is what deleting the account does too', async () => {
    const { session } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);

    await session.resetAccountState();

    expect(await rowsOfAccount(A)).toEqual([]);
    expect(localKeysOf(A)).toEqual([]);
  });
});

describe('when the session ends or another tab clears', () => {
  it('keeps the rows, the queued actions and the keys after a 401, so the same account can come back', async () => {
    const { session, server } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    const before = await rowsOfAccount(A);
    server.me = null;

    await expect(session.api.call(routes.cardList)).rejects.toMatchObject({ status: 401 });

    expect(await rowsOfAccount(A)).toEqual(before);
    expect(localKeysOf(A)).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) ?? 'null')).toMatchObject({ id: A });
    expect(await listRecords(A)).toEqual([makeRecord('m1')]);
  });

  it('keeps them when another tab broadcasts a reset, because that tab cleared the storage', async () => {
    const { session, queryClient } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    const before = await rowsOfAccount(A);
    const other = new BroadcastChannel(SESSION_CHANNEL);

    other.postMessage({ type: 'reset' });
    await vi.waitFor(() => expect(queryClient.getQueryData(meKey())).toBeNull());
    other.close();

    expect(await rowsOfAccount(A)).toEqual(before);
    expect(localKeysOf(A)).toHaveLength(2);
  });
});

describe('when another tab removes the account while this one writes', () => {
  /** Tabs whose channel messages arrive at once, so that a test can order them around writes. */
  function instantChannels() {
    const open = new Set<InstantChannel>();
    class InstantChannel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) {
        open.add(this);
      }
      postMessage(data: unknown) {
        for (const other of [...open]) {
          if (other !== this && other.name === this.name) {
            other.onmessage?.(new MessageEvent('message', { data }));
          }
        }
      }
      close() {
        open.delete(this);
      }
    }
    vi.stubGlobal('BroadcastChannel', InstantChannel);
  }

  /** The other tab's own connection to the offline database, which shares nothing with this page. */
  function otherTabDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = idb.factory.open(OFFLINE_DB);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** The other tab's sign-out: every row of the account goes, in one transaction begun now. */
  function removeRows(db: IDBDatabase, accountId: string): Promise<void> {
    const tx = db.transaction([...STORES], 'readwrite');
    for (const store of STORES) tx.objectStore(store).delete(accountRange(accountId));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** A row the other tab stores for the account, as a session that began after the sign-out. */
  function putRow(db: IDBDatabase, store: (typeof STORES)[number], key: string, value: unknown) {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  async function signedIn() {
    instantChannels();
    const { session } = sessions.start({ me: userA });
    await session.loadMe();
    await seed(A);
    const db = await otherTabDb();
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    onTestFinished(() => {
      db.close();
      channel.close();
    });
    return { db, channel };
  }

  it('drops a write of this tab that waited for the database when the other tab signed out', async () => {
    const other = await signedIn();

    const at = Date.now();
    const removal = removeRows(other.db, A);
    const writing = saveView(A, 'later', itemList(1), VIEW);
    other.channel.postMessage({ type: 'reset', removed: A, at });

    await removal;
    expect(await writing).toBe(false);
    await settle();
    expect(await rowsOfAccount(A)).toEqual([]);
  });

  it('removes again what this tab stored after the other tab began to remove the account', async () => {
    const other = await signedIn();

    const at = Date.now();
    const removal = removeRows(other.db, A);
    expect(await saveView(A, 'later', itemList(1), VIEW)).toBe(true);
    expect(await putRecord(makeRecord('m2', { accountId: A }))).toBe(true);
    await removal;
    expect(await rowsOfAccount(A)).not.toEqual([]);

    other.channel.postMessage({ type: 'reset', removed: A, at });

    await vi.waitFor(async () => expect(await rowsOfAccount(A)).toEqual([]));
  });

  it('keeps what it did not store since the other tab began, such as the rows of a newer session there', async () => {
    const other = await signedIn();
    await settle();
    const at = Date.now();
    await removeRows(other.db, A);
    const newer = makeRecord('m3', { accountId: A });
    await putRow(other.db, 'queue', `${A}:m3`, newer);

    other.channel.postMessage({ type: 'reset', removed: A, at });
    await settle();

    expect(await rowsOfAccount(A)).toEqual([['queue', `${A}:m3`, newer]]);
  });
});
