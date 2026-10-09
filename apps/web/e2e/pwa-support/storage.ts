import type { Page } from '@playwright/test';

import type { FeedItem } from '../support/control.js';

/**
 * Everything the page keeps in the browser's own storage, as text lines that a test can search:
 * IndexedDB (every record of every store), localStorage, sessionStorage and CacheStorage (the
 * request URLs, and the bodies of the text responses).
 */
export interface StorageDump {
  /** The names of the IndexedDB databases of the origin. */
  databases: string[];
  /** `database/store/key: value`, one per record. */
  indexedDb: string[];
  /** `key: value`, one per entry. */
  localStorage: string[];
  sessionStorage: string[];
  /** The names of the caches of CacheStorage. */
  cacheNames: string[];
  /** `cache METHOD url`, and `cache body url: text` for a text response. */
  cacheStorage: string[];
}

/** Reads all of it, in the page. A database the origin has is opened as it is, never created. */
export async function dumpStorage(page: Page): Promise<StorageDump> {
  return page.evaluate(async (): Promise<StorageDump> => {
    const text = (value: unknown): string => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    };
    const settled = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const databases: string[] = [];
    for (const info of await indexedDB.databases()) {
      if (info.name !== undefined) databases.push(info.name);
    }
    const indexedDb: string[] = [];
    for (const name of databases) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const objects = db.transaction(store, 'readonly').objectStore(store);
          const keys = await settled(objects.getAllKeys());
          const values = await settled(objects.getAll());
          keys.forEach((key, index) => {
            indexedDb.push(`${name}/${store}/${text(key)}: ${text(values[index])}`);
          });
        }
      } finally {
        db.close();
      }
    }

    const entries = (area: Storage): string[] =>
      Object.keys(area).map((key) => `${key}: ${area.getItem(key) ?? ''}`);

    const cacheNames = await caches.keys();
    const cacheStorage: string[] = [];
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        cacheStorage.push(`${name} ${request.method} ${request.url}`);
        const response = await cache.match(request);
        const type = response?.headers.get('content-type') ?? '';
        if (response !== undefined && /^text\/|json|javascript|xml/.test(type)) {
          cacheStorage.push(`${name} body ${request.url}: ${await response.clone().text()}`);
        }
      }
    }

    return {
      databases,
      indexedDb,
      localStorage: entries(localStorage),
      sessionStorage: entries(sessionStorage),
      cacheNames,
      cacheStorage,
    };
  });
}

/** Something private that must not be found: what it is called and the text to look for. */
export interface Canary {
  label: string;
  needle: string;
}

/** The canaries found in the dump, as `place: label`; the search ignores case. */
export function canariesIn(dump: StorageDump, canaries: readonly Canary[]): string[] {
  const places: Record<string, readonly string[]> = {
    indexedDB: dump.indexedDb,
    localStorage: dump.localStorage,
    sessionStorage: dump.sessionStorage,
    cacheStorage: dump.cacheStorage,
  };
  const found: string[] = [];
  for (const [place, lines] of Object.entries(places)) {
    for (const { label, needle } of canaries) {
      const wanted = needle.toLowerCase();
      if (lines.some((line) => line.toLowerCase().includes(wanted)))
        found.push(`${place}: ${label}`);
    }
  }
  return found;
}

/** Puts the text into all four kinds of storage, as a page that kept private data would. */
export async function plantInStorage(page: Page, text: string): Promise<void> {
  await page.evaluate(async (planted: string) => {
    localStorage.setItem('pwa-check:planted', planted);
    sessionStorage.setItem('pwa-check:planted', planted);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('pwa-check-planted', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('items').put({ title: planted }, 'one');
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const cache = await caches.open('pwa-check-planted');
    await cache.put(
      '/pwa-check-planted',
      new Response(planted, { headers: { 'content-type': 'text/plain' } }),
    );
  }, text);
}

/** Takes back what {@link plantInStorage} put there. */
export async function removePlanted(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.removeItem('pwa-check:planted');
    sessionStorage.removeItem('pwa-check:planted');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('pwa-check-planted');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await caches.delete('pwa-check-planted');
  });
}

/** What identifies one account and its articles in the browser's storage. */
export interface AccountTraces {
  id: string;
  email: string;
  items: readonly Pick<FeedItem, 'slug' | 'title' | 'excerpt'>[];
}

/**
 * What of the account the dump still holds, as `place: what`. The device-local choice to keep
 * articles (`bantoozi:offline:enabled:<id>`) is not data of the account and may stay; any other
 * localStorage entry that names the account may not.
 */
export function tracesOfAccount(dump: StorageDump, { id, email, items }: AccountTraces): string[] {
  const canaries: Canary[] = [
    { label: 'the address of the account', needle: email },
    ...items.flatMap((item) => [
      { label: `the title of ${item.slug}`, needle: item.title },
      { label: `the summary of ${item.slug}`, needle: item.excerpt },
      { label: `the address of ${item.slug}`, needle: item.slug },
    ]),
  ];
  const choice = `bantoozi:offline:enabled:${id}: `;
  return [
    ...canariesIn(dump, canaries),
    ...canariesIn({ ...dump, localStorage: [] }, [{ label: 'the id of the account', needle: id }]),
    ...dump.localStorage
      .filter((line) => line.includes(id) && !line.startsWith(choice))
      .map((line) => `localStorage: ${line}`),
  ];
}

/** One record of the app's own offline database (`bantoozi-offline`). */
export interface OfflineRow {
  store: string;
  key: string;
  value: unknown;
}

/** Every record of every store of the offline database; none when the origin has no such database. */
export async function offlineRows(page: Page): Promise<OfflineRow[]> {
  return page.evaluate(async (name): Promise<OfflineRow[]> => {
    const settled = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const known = await indexedDB.databases();
    if (!known.some((info) => info.name === name)) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows: OfflineRow[] = [];
      for (const store of Array.from(db.objectStoreNames)) {
        const objects = db.transaction(store, 'readonly').objectStore(store);
        const keys = await settled(objects.getAllKeys());
        const values: unknown[] = await settled(objects.getAll());
        keys.forEach((key, index) => rows.push({ store, key: String(key), value: values[index] }));
      }
      return rows;
    } finally {
      db.close();
    }
  }, 'bantoozi-offline');
}

/** The rows an account keeps (in one store, when given): their keys start with its id and a colon. */
export function rowsOfAccount(
  rows: readonly OfflineRow[],
  accountId: string,
  store?: string,
): OfflineRow[] {
  return rows.filter(
    (row) => row.key.startsWith(`${accountId}:`) && (store === undefined || row.store === store),
  );
}

/** What the device keeps of one account: the saved account, lists, articles and unsent changes. */
export interface SavedOnDevice {
  /** The account itself is saved, which an offline start needs. */
  account: boolean;
  /** The ids of the articles whose list rows are saved. */
  items: string[];
  /** How many lists are saved. */
  views: number;
  /** The ids of the articles whose opened text is saved. */
  details: string[];
  /** How many changes wait to be sent. */
  unsent: number;
}

/** Reads {@link SavedOnDevice} from the app's offline database. */
export async function savedOnDevice(page: Page, accountId: string): Promise<SavedOnDevice> {
  const mine = rowsOfAccount(await offlineRows(page), accountId);
  const namesIn = (store: string): string[] =>
    mine
      .filter((row) => row.store === store)
      .map((row) => row.key.slice(accountId.length + 1))
      .sort();
  return {
    account: namesIn('meta').includes('me'),
    items: namesIn('items'),
    views: namesIn('views').length,
    details: namesIn('details'),
    unsent: namesIn('queue').length,
  };
}
