import { describe, expect, it, vi } from 'vitest';

import { saveView, setOfflineEnabled } from '../../src/offline/cache.js';
import { isOfflineEnabled } from '../../src/offline/device.js';
import {
  offlineDb,
  onOfflineDbVersionChange,
  openOfflineDb,
  resetOfflineDb,
  type VersionChange,
} from '../../src/offline/db.js';
import { OFFLINE_DB, STORES } from '../../src/offline/names.js';
import {
  A,
  B,
  VIEW,
  itemList,
  makeRecord,
  newFactory,
  seedV1Database,
  freshIndexedDb,
} from './support.js';

const idb = freshIndexedDb();

const storeNames = (db: { objectStoreNames: ArrayLike<string> }) =>
  Array.from(db.objectStoreNames).sort();

/** What another tab running a newer version of the app does. */
function upgradeTo(factory: IDBFactory, version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB, version);
    request.onupgradeneeded = () => request.result.createObjectStore(`added-in-${version}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the offline connection stayed open'));
  });
}

describe('openOfflineDb', () => {
  it('creates the database with its five stores', async () => {
    const opened = await openOfflineDb({ indexedDB: idb.factory });

    expect(opened.available).toBe(true);
    if (!opened.available) throw new Error('the database did not open');
    expect(opened.db.name).toBe(OFFLINE_DB);
    expect(opened.db.version).toBe(1);
    expect(storeNames(opened.db)).toEqual([...STORES].sort());
    opened.db.close();
  });

  it('opens the database it created before, without changing it', async () => {
    const first = await openOfflineDb({ indexedDB: idb.factory });
    if (first.available) await first.db.put('queue', makeRecord('m1'), `${A}:m1`);
    if (first.available) first.db.close();

    const second = await openOfflineDb({ indexedDB: idb.factory });

    expect(second.available).toBe(true);
    if (!second.available) throw new Error('the database did not open');
    expect(second.db.version).toBe(1);
    expect(await second.db.get('queue', `${A}:m1`)).toEqual(makeRecord('m1'));
    second.db.close();
  });

  it('keeps a queued record of version 1 through a later migration', async () => {
    const queued = makeRecord('m1', { state: 'frozen', attempts: 3 });
    await seedV1Database(idb.factory, { queue: [[`${A}:m1`, queued]] });

    const opened = await openOfflineDb({
      indexedDB: idb.factory,
      migrations: [{ version: 2, upgrade: (db) => void db.createObjectStore('extra') }],
    });

    expect(opened.available).toBe(true);
    if (!opened.available) throw new Error('the database did not open');
    expect(opened.db.version).toBe(2);
    expect(storeNames(opened.db)).toEqual([...STORES, 'extra'].sort());
    expect(await opened.db.get('queue', `${A}:m1`)).toEqual(queued);
    expect(await opened.db.count('queue')).toBe(1);
    opened.db.close();
  });

  it('lets a migration change what is stored, one step after the other', async () => {
    const queued = makeRecord('m1');
    await seedV1Database(idb.factory, { queue: [[`${A}:m1`, queued]] });
    const order: number[] = [];

    const opened = await openOfflineDb({
      indexedDB: idb.factory,
      migrations: [
        {
          version: 3,
          upgrade: () => {
            order.push(3);
          },
        },
        {
          version: 2,
          upgrade: async (_db, transaction) => {
            order.push(2);
            const store = transaction.objectStore('queue');
            const record = (await store.get(`${A}:m1`)) as typeof queued;
            await store.put({ ...record, attempts: 7 }, `${A}:m1`);
          },
        },
      ],
    });

    expect(opened.available).toBe(true);
    if (!opened.available) throw new Error('the database did not open');
    expect(order).toEqual([2, 3]);
    expect(opened.db.version).toBe(3);
    expect(await opened.db.get('queue', `${A}:m1`)).toEqual({ ...queued, attempts: 7 });
    opened.db.close();
  });

  it('does not run a migration the database already went through', async () => {
    const upgrade = vi.fn();
    const first = await openOfflineDb({
      indexedDB: idb.factory,
      migrations: [{ version: 2, upgrade }],
    });
    if (first.available) first.db.close();
    upgrade.mockClear();

    const second = await openOfflineDb({
      indexedDB: idb.factory,
      migrations: [{ version: 2, upgrade }],
    });

    expect(second.available).toBe(true);
    expect(upgrade).not.toHaveBeenCalled();
    if (second.available) second.db.close();
  });
});

describe('a version change', () => {
  it('closes the connection and tells the listeners, so the other version can upgrade', async () => {
    const opened = await openOfflineDb({ indexedDB: idb.factory });
    expect(opened.available).toBe(true);
    const heard: VersionChange[] = [];
    const stop = onOfflineDbVersionChange((change) => heard.push(change));

    const upgraded = await upgradeTo(idb.factory, 2);

    expect(upgraded.version).toBe(2);
    expect(heard).toEqual([{ oldVersion: 1, newVersion: 2 }]);
    if (opened.available) expect(() => opened.db.transaction('queue')).toThrow();
    upgraded.close();
    stop();
  });

  it('stops telling a listener that was removed', async () => {
    const opened = await openOfflineDb({ indexedDB: idb.factory });
    expect(opened.available).toBe(true);
    const listener = vi.fn();
    onOfflineDbVersionChange(listener)();

    const upgraded = await upgradeTo(idb.factory, 2);

    expect(listener).not.toHaveBeenCalled();
    upgraded.close();
  });

  it('leaves the shared store unavailable, without a crash, once a newer version took over', async () => {
    await setOfflineEnabled(A, true);
    expect((await offlineDb()).available).toBe(true);

    const upgraded = await upgradeTo(idb.factory, 2);
    upgraded.close();

    expect(await saveView(A, 'view', itemList(1), VIEW)).toBe(false);
    expect(await offlineDb()).toEqual({ available: false });
  });
});

describe('a browser that cannot keep the database', () => {
  it('reports it unavailable when opening throws', async () => {
    const working = await openOfflineDb({ indexedDB: idb.factory });
    expect(working.available).toBe(true);
    if (working.available) working.db.close();
    const refusing = {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;

    await expect(openOfflineDb({ indexedDB: refusing })).resolves.toEqual({ available: false });
  });

  it('reports it unavailable when a migration fails, and leaves the database as it was', async () => {
    await seedV1Database(idb.factory, { queue: [[`${A}:m1`, makeRecord('m1')]] });

    const failed = await openOfflineDb({
      indexedDB: idb.factory,
      migrations: [
        {
          version: 2,
          upgrade: () => {
            throw new Error('migration failed');
          },
        },
      ],
    });
    const intact = await openOfflineDb({ indexedDB: idb.factory });

    expect(failed).toEqual({ available: false });
    expect(intact.available).toBe(true);
    if (!intact.available) throw new Error('the database did not open');
    expect(intact.db.version).toBe(1);
    expect(await intact.db.get('queue', `${A}:m1`)).toEqual(makeRecord('m1'));
    intact.db.close();
  });

  it('reports it unavailable when the browser has no IndexedDB', async () => {
    expect((await offlineDb()).available).toBe(true);
    vi.stubGlobal('indexedDB', undefined);
    await resetOfflineDb();

    await expect(openOfflineDb()).resolves.toEqual({ available: false });
    await expect(offlineDb()).resolves.toEqual({ available: false });
  });

  it('reports it unavailable when an older version is asked for than the one stored', async () => {
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.factory.open(OFFLINE_DB, 5);
      request.onupgradeneeded = () => request.result.createObjectStore('queue');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    newer.close();

    await expect(openOfflineDb({ indexedDB: idb.factory })).resolves.toEqual({ available: false });
    const other = await openOfflineDb({ indexedDB: newFactory() });
    expect(other.available).toBe(true);
    if (other.available) other.db.close();
  });

  it('does not turn offline reading on, and never throws', async () => {
    expect(await setOfflineEnabled(B, true)).toBe(true);
    vi.stubGlobal('indexedDB', undefined);
    await resetOfflineDb();

    expect(await setOfflineEnabled(A, true)).toBe(false);

    expect(isOfflineEnabled(A)).toBe(false);
    expect(await saveView(A, 'view', itemList(1), VIEW)).toBe(false);
  });
});
