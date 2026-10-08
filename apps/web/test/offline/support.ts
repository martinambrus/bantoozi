import type { ArticleDetail, ArticleListItem } from '@bantoozi/shared';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetOfflineDb } from '../../src/offline/db.js';
import { OFFLINE_DB } from '../../src/offline/names.js';
import type { QueueRecord } from '../../src/offline/queue.js';
import { USER_A_ID, USER_B_ID } from '../session/fixtures.js';

export const A = USER_A_ID;
export const B = USER_B_ID;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MIB = 1024 * 1024;
/** A fixed "now" for the tests that move the clock. */
export const T0 = Date.parse('2026-10-08T08:00:00.000Z');
export const VIEW = { asOf: '2026-10-08T07:59:00.000Z', datasetVersion: 'ds-1' };

export const newFactory = () => new FakeIDBFactory() as unknown as IDBFactory;

/** Every test gets an empty IndexedDB of its own and a clean localStorage. */
export function freshIndexedDb() {
  const holder = { factory: newFactory() };
  beforeEach(async () => {
    holder.factory = newFactory();
    vi.stubGlobal('indexedDB', holder.factory);
    await resetOfflineDb();
    localStorage.clear();
  });
  afterEach(async () => {
    await resetOfflineDb();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  return holder;
}

/** Moves `Date` only: timers stay real, because the fake IndexedDB schedules through them. */
export function setClock(now: number) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
}

export type Dump = Record<string, [key: string, value: unknown][]>;

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Everything in every store of the offline database, read with raw IndexedDB. */
export async function dumpDatabase(factory: IDBFactory): Promise<Dump> {
  const known = await factory.databases();
  if (!known.some((info) => info.name === OFFLINE_DB)) return {};
  const db = await settled(factory.open(OFFLINE_DB));
  const dump: Dump = {};
  for (const name of Array.from(db.objectStoreNames)) {
    const store = db.transaction(name, 'readonly').objectStore(name);
    const keys = await settled(store.getAllKeys());
    const values = await settled(store.getAll());
    dump[name] = keys.map((key, index) => [String(key), values[index]]);
  }
  db.close();
  return dump;
}

export const allRows = (dump: Dump) => Object.values(dump).flat();
export const rowCount = (dump: Dump, store: string) => dump[store]?.length ?? 0;
/** The rows of one account, in every store, sorted by key. */
export const rowsOf = (dump: Dump, accountId: string) =>
  Object.entries(dump)
    .flatMap(([store, rows]) =>
      rows
        .filter(([key]) => key.startsWith(`${accountId}:`))
        .map(([key, value]) => [store, key, value] as const),
    )
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
/** What the oracle counts against the 10 MiB cap: the bytes of the JSON of every cached row. */
export const cachedBytes = (dump: Dump, accountId: string) =>
  rowsOf(dump, accountId)
    .filter(([store]) => store !== 'queue')
    .reduce((sum, [, , value]) => sum + JSON.stringify(value).length, 0);

export const localKeysOf = (accountId: string) =>
  Object.keys(localStorage).filter((key) => key.startsWith(`${accountId}:`));

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** An item with every nullable field set, so a key the projection forgets to keep shows. */
export function fullItem(overrides: Partial<ArticleListItem> = {}): ArticleListItem {
  return deepFreeze({
    id: '101',
    title: 'Solid-state batteries reach the pilot line',
    url: 'https://example.test/articles/101',
    feed: { id: '7', title: 'Example Weekly', iconUrl: 'https://example.test/icon.png' },
    author: 'Ada Lovelace',
    publishedAt: '2026-05-31T08:00:00.000Z',
    firstSeenAt: '2026-05-31T08:05:00.000Z',
    excerpt: 'A short excerpt.',
    imageUrl: 'https://example.test/101.jpg',
    lang: 'en',
    lane: 'maybe',
    tier: 3,
    pLike: 0.8213,
    topReason: { kind: 'card', cardId: '31', title: 'EV battery tech', p: 0.82 },
    labelIds: ['3', '4'],
    labelSuggestions: ['5'],
    rating: -1,
    reason: 'clickbait',
    readAt: '2026-05-31T09:00:00.000Z',
    bookmarkedAt: '2026-05-31T09:10:00.000Z',
    archivedAt: '2026-05-31T09:20:00.000Z',
    stateVersion: '4',
    contentRevision: '2',
    translationAvailable: true,
    analysis: {
      mode: 'active',
      status: 'complete',
      requestId: '8c1a3f5e-2b7d-4e61-9a0c-5d4e3f2a1b09',
    },
    mediaPolicyFeedId: '7',
    effectiveImagesAllowed: true,
    bookmarkCapture: {
      status: 'saved',
      generation: '1',
      snapshotId: '9',
      capturedAt: '2026-05-31T09:12:00.000Z',
      errorCode: null,
    },
    cluster: { id: '12', size: 3, otherFeeds: ['Other Feed'] },
    ...overrides,
  });
}

/** A detail with every nullable field set, an explanation and cluster members that must not be kept. */
export function fullDetail(overrides: Partial<ArticleDetail> = {}): ArticleDetail {
  return deepFreeze({
    ...fullItem(),
    excerptHtml: '<p>The excerpt of the article.</p>',
    bodyLead: 'The lead of the article.',
    explain: {
      v: 1,
      inputs: {
        contentRevision: '2',
        mediaRevision: '1',
        rankRevision: '3',
        contextSha: 'a'.repeat(64),
      },
      source: 'cards',
      p: 0.91,
      lane: 'for_you',
      tier: 5,
      cards: [
        { id: '31', title: 'EXPLAIN-CARD-SENTINEL', strength: 'love', p: 0.91, engine: 'typesafe' },
      ],
      rules: [],
    },
    translation: { title: 'Preklad', excerpt: 'Úryvok', engine: 'libretranslate', quality: 'ok' },
    clusterMembers: [
      { id: '13', title: 'CLUSTER-MEMBER-SENTINEL', feedTitle: 'Other Feed', url: null },
    ],
    bookmarkSnapshot: {
      id: '9',
      sourceUrl: 'https://example.test/articles/101',
      title: 'Solid-state batteries reach the pilot line',
      author: 'Ada Lovelace',
      publishedAt: '2026-05-31T08:00:00.000Z',
      capturedAt: '2026-05-31T09:12:00.000Z',
      contentRevision: '2',
      completeness: 'complete',
      text: 'The saved text.',
      html: '<p>The saved text.</p>',
      mediaPolicyFeedId: '7',
      effectiveImagesAllowed: true,
    },
    ...overrides,
  });
}

/** `count` plain items with ids `from`, `from + 1`, … */
export function itemList(count: number, from = 1): ArticleListItem[] {
  return Array.from({ length: count }, (_unused, index) =>
    fullItem({ id: String(from + index), title: `Article ${from + index}` }),
  );
}

/** A detail of about `bytes` bytes once stored. */
export function bigDetail(id: string, bytes: number): ArticleDetail {
  return fullDetail({ id, bodyLead: 'x'.repeat(bytes) });
}

export function makeRecord(id: string, overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    schema: 1,
    id,
    key: id,
    accountId: A,
    articleId: '101',
    action: { type: 'rate', rating: 1 },
    fence: null,
    after: null,
    before: {
      stateVersion: '4',
      contentRevision: '2',
      readAt: null,
      rating: null,
      reason: null,
      bookmarkedAt: null,
      archivedAt: null,
      labelIds: [],
      bookmarkCapture: null,
    },
    createdAt: T0,
    stamp: `stamp-${id}`,
    markRead: false,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: T0,
    ...overrides,
  };
}

/** A raw version 1 database of the shape the first release shipped, filled with `rows`. */
export async function seedV1Database(
  factory: IDBFactory,
  rows: Partial<Record<string, [key: string, value: unknown][]>> = {},
) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB, 1);
    request.onupgradeneeded = () => {
      for (const name of ['meta', 'items', 'views', 'details', 'queue']) {
        request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const [name, entries] of Object.entries(rows)) {
    const store = db.transaction(name, 'readwrite').objectStore(name);
    for (const [key, value] of entries ?? []) await settled(store.put(value, key));
  }
  db.close();
}
