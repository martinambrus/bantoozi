import { MeSchema, type ArticleDetail, type ArticleListItem, type Me } from '@bantoozi/shared';
import type { IDBPTransaction } from 'idb';

import { isNewerState, pickReader, type ReaderState } from '../features/reader/actions/types.js';
import { offlineDatabaseMightExist, offlineDb } from './db.js';
import {
  isOfflineEnabled,
  isPurgePending,
  pendingPurges,
  setPurgePending,
  writeOfflineEnabled,
} from './device.js';
import { clearsOf, noteClear } from './epoch.js';
import { entryOf, isExpired, plan, splitEntry, usageOf, utf8Length } from './ledger.js';
import { LIMITS, STORES, accountRange, isAccountId, rowKey } from './names.js';
import { projectDetail, projectItem, type OfflineDetail, type OfflineItem } from './projection.js';
import { countRecords } from './queue.js';
import type { DetailRow, ItemRow, Manifest, MeRow, OfflineSchema, ViewRow } from './types.js';

/**
 * The articles an account keeps for reading offline (spec 09 §1). Every row is stored under
 * `<account id>:<name>`, and nothing is stored while the account has not chosen offline reading.
 */

export interface ViewMeta {
  asOf: string;
  datasetVersion: string;
}

export interface StoredView extends ViewMeta {
  items: OfflineItem[];
  savedAt: number;
}

export interface OfflineUsage {
  articles: number;
  bytes: number;
  unsent: number;
}

const CACHE_STORES = ['meta', 'items', 'views', 'details'] as const;
type CacheTx<Mode extends 'readonly' | 'readwrite'> = IDBPTransaction<
  OfflineSchema,
  typeof CACHE_STORES,
  Mode
>;

const MANIFEST = 'manifest';
const ME = 'me';

type Row =
  | { store: 'meta'; name: typeof ME; value: MeRow }
  | { store: 'items'; name: string; value: ItemRow }
  | { store: 'views'; name: string; value: ViewRow }
  | { store: 'details'; name: string; value: DetailRow };

function isManifest(value: MeRow | Manifest | undefined): value is Manifest {
  return value !== undefined && 'entries' in value;
}

function putRow(tx: CacheTx<'readwrite'>, accountId: string, row: Row): Promise<unknown> {
  const key = rowKey(accountId, row.name);
  switch (row.store) {
    case 'meta':
      return tx.objectStore('meta').put(row.value, key);
    case 'items':
      return tx.objectStore('items').put(row.value, key);
    case 'views':
      return tx.objectStore('views').put(row.value, key);
    case 'details':
      return tx.objectStore('details').put(row.value, key);
  }
}

function deleteEntry(tx: CacheTx<'readwrite'>, accountId: string, entry: string): Promise<unknown> {
  const { store, name } = splitEntry(entry);
  return tx.objectStore(store).delete(rowKey(accountId, name));
}

function abort(tx: { abort: () => void }) {
  try {
    tx.abort();
  } catch {
    // The transaction already finished.
  }
}

/**
 * Saves rows, drops what expired and keeps the account within its limits, all in one transaction.
 * False when nothing was stored: the choice is off, the data was cleared meanwhile, the database
 * is unavailable or the limits leave no room.
 */
async function write(
  accountId: string,
  rowsAt: (now: number, tx: CacheTx<'readwrite'>) => Row[] | Promise<Row[]>,
): Promise<boolean> {
  if (!isAccountId(accountId) || !isOfflineEnabled(accountId) || isPurgePending(accountId)) {
    return false;
  }
  const clears = clearsOf(accountId);
  const opened = await offlineDb();
  if (!opened.available) return false;
  if (!isOfflineEnabled(accountId) || clearsOf(accountId) !== clears) return false;

  let stored = false;
  try {
    const now = Date.now();
    const tx = opened.db.transaction(CACHE_STORES, 'readwrite');
    const finished = tx.done.then(
      () => true,
      () => false,
    );
    try {
      const made = rowsAt(now, tx);
      // A plain list is not awaited, so that the next request is made in the same task.
      const rows = Array.isArray(made) ? made : await made;
      const planned = rows.map((row) => ({
        entry: entryOf(row.store, row.name),
        bytes: utf8Length(JSON.stringify(row.value)),
      }));
      const meta = tx.objectStore('meta');
      const manifestKey = rowKey(accountId, MANIFEST);
      const found = await meta.get(manifestKey);
      const next = plan(isManifest(found) ? found : undefined, planned, now);
      if (next.fits) {
        const pending: Promise<unknown>[] = [];
        for (const entry of next.removed) pending.push(deleteEntry(tx, accountId, entry));
        for (const row of rows) pending.push(putRow(tx, accountId, row));
        if (rows.length > 0 || next.removed.length > 0) {
          pending.push(
            Object.keys(next.manifest.entries).length === 0
              ? meta.delete(manifestKey)
              : meta.put(next.manifest, manifestKey),
          );
        }
        await Promise.all(pending);
        stored = true;
      }
    } catch {
      abort(tx);
    }
    return (await finished) && stored;
  } catch {
    return false;
  }
}

async function load<T>(
  accountId: string,
  read: (tx: CacheTx<'readonly'>) => Promise<T>,
): Promise<{ value: T; now: number } | undefined> {
  if (!isAccountId(accountId) || !isOfflineEnabled(accountId) || isPurgePending(accountId)) {
    return undefined;
  }
  if (!(await offlineDatabaseMightExist())) return undefined;
  const opened = await offlineDb();
  if (!opened.available) return undefined;
  try {
    const tx = opened.db.transaction(CACHE_STORES, 'readonly');
    const finished = tx.done.then(
      () => true,
      () => false,
    );
    const value = await read(tx);
    return (await finished) ? { value, now: Date.now() } : undefined;
  } catch {
    return undefined;
  }
}

const sweep = (accountId: string) => write(accountId, () => []);

/**
 * Turns offline reading on or off for the account on this device. Turning it off removes what was
 * stored. False when the device could not be put in the state asked for.
 */
export async function setOfflineEnabled(accountId: string, on: boolean): Promise<boolean> {
  if (!isAccountId(accountId)) return false;
  if (on) {
    const opened = await offlineDb();
    return opened.available && writeOfflineEnabled(accountId, true);
  }
  // Off before the removal, so nothing new is stored while the rows go.
  const off = writeOfflineEnabled(accountId, false);
  const cleared = await clearAccount(accountId);
  // Rows that stay keep the choice on: turning it off can be tried again, and turning it on later
  // does not show rows the person was told were gone.
  if (off && !cleared) writeOfflineEnabled(accountId, true);
  return off && cleared;
}

/** The saved rows of these articles that have not expired, by article id. */
async function heldItems(
  tx: CacheTx<'readwrite'>,
  accountId: string,
  ids: readonly string[],
  now: number,
): Promise<Map<string, ItemRow>> {
  const found = await Promise.all(
    ids.map((id) => tx.objectStore('items').get(rowKey(accountId, id))),
  );
  const held = new Map<string, ItemRow>();
  found.forEach((row, index) => {
    const id = ids[index];
    if (id !== undefined && row !== undefined && !isExpired(row.savedAt, now)) held.set(id, row);
  });
  return held;
}

/** Keeps a list (at most 200 items, in order) under `viewKey`, with the dataset it was read from. */
export function saveView(
  accountId: string,
  viewKey: string,
  items: readonly ArticleListItem[],
  view: ViewMeta,
): Promise<boolean> {
  return write(accountId, async (now, tx) => {
    const kept = items.slice(0, LIMITS.maxItems);
    const held = await heldItems(
      tx,
      accountId,
      kept.map((item) => item.id),
      now,
    );
    // The bottom of the list is saved first, so it is the first to go when room is needed.
    const rows: Row[] = [...kept].reverse().map((item) => {
      const listed = projectItem(item);
      // A saved row that holds a newer state than the list is kept.
      const newer = held.get(item.id)?.item;
      return {
        store: 'items',
        name: item.id,
        value: {
          item: newer !== undefined && isNewerState(newer, listed) ? newer : listed,
          savedAt: now,
        },
      };
    });
    rows.push({
      store: 'views',
      name: viewKey,
      value: {
        itemIds: kept.map((item) => item.id),
        asOf: view.asOf,
        datasetVersion: view.datasetVersion,
        savedAt: now,
      },
    });
    return rows;
  });
}

/** Writes newer reader states onto saved rows the device already holds; it never adds a row. */
export function saveReaderStates(
  accountId: string,
  states: ReadonlyMap<string, ReaderState>,
): Promise<boolean> {
  return write(accountId, async (now, tx) => {
    const held = await heldItems(tx, accountId, [...states.keys()], now);
    const rows: Row[] = [];
    for (const [id, state] of states) {
      const row = held.get(id);
      if (row === undefined || !isNewerState(state, row.item)) continue;
      rows.push({
        store: 'items',
        name: id,
        value: { item: { ...row.item, ...pickReader(state) }, savedAt: now },
      });
    }
    return rows;
  });
}

/** The list saved under `viewKey`, without the items that were given up since. */
export async function readView(accountId: string, viewKey: string): Promise<StoredView | null> {
  const loaded = await load(accountId, async (tx) => {
    const row = await tx.objectStore('views').get(rowKey(accountId, viewKey));
    const items =
      row === undefined
        ? []
        : await Promise.all(
            row.itemIds.map((id) => tx.objectStore('items').get(rowKey(accountId, id))),
          );
    return { row, items };
  });
  if (loaded === undefined || loaded.value.row === undefined) return null;
  const { row, items } = loaded.value;
  if (isExpired(row.savedAt, loaded.now)) {
    await sweep(accountId);
    return null;
  }
  return {
    items: items
      .filter(
        (entry): entry is ItemRow => entry !== undefined && !isExpired(entry.savedAt, loaded.now),
      )
      .map((entry) => entry.item),
    asOf: row.asOf,
    datasetVersion: row.datasetVersion,
    savedAt: row.savedAt,
  };
}

/**
 * Keeps an opened article. Only the Bookmarks view reads the saved copy of a bookmark, so the article
 * read from another view keeps the copy stored for the same bookmark instead of dropping it.
 */
export function saveDetail(accountId: string, detail: ArticleDetail): Promise<boolean> {
  return write(accountId, async (now, tx) => {
    let kept = projectDetail(detail);
    if (kept.bookmarkSnapshot === null && kept.bookmarkedAt !== null) {
      const stored = await tx.objectStore('details').get(rowKey(accountId, detail.id));
      if (
        stored !== undefined &&
        !isExpired(stored.savedAt, now) &&
        stored.detail.bookmarkedAt === kept.bookmarkedAt
      ) {
        kept = { ...kept, bookmarkSnapshot: stored.detail.bookmarkSnapshot };
      }
    }
    return [{ store: 'details', name: detail.id, value: { detail: kept, savedAt: now } }];
  });
}

export async function readDetail(
  accountId: string,
  articleId: string,
): Promise<OfflineDetail | null> {
  const loaded = await load(accountId, (tx) =>
    tx.objectStore('details').get(rowKey(accountId, articleId)),
  );
  if (loaded?.value === undefined) return null;
  if (isExpired(loaded.value.savedAt, loaded.now)) {
    await sweep(accountId);
    return null;
  }
  return loaded.value.detail;
}

/** The account itself, for starting the app without a connection. */
export function saveMe(accountId: string, me: Me): Promise<boolean> {
  return write(accountId, (now) => [{ store: 'meta', name: ME, value: { me, savedAt: now } }]);
}

export async function readMe(accountId: string): Promise<{ me: Me; savedAt: number } | null> {
  const loaded = await load(accountId, (tx) => tx.objectStore('meta').get(rowKey(accountId, ME)));
  const row = loaded?.value;
  if (loaded === undefined || row === undefined || !('me' in row)) return null;
  if (isExpired(row.savedAt, loaded.now)) {
    await sweep(accountId);
    return null;
  }
  const parsed = MeSchema.safeParse(row.me);
  return parsed.success ? { me: parsed.data, savedAt: row.savedAt } : null;
}

/**
 * Removes every row of the account from every store, in one transaction over its key range. The
 * account's choice to read offline is not data and stays. True when nothing of it is left; rows
 * that could not be removed count as gone from then on and are removed again at the next start.
 */
export async function clearAccount(accountId: string): Promise<boolean> {
  if (!isAccountId(accountId)) return true;
  noteClear(accountId);
  const cleared = await removeRows(accountId);
  setPurgePending(accountId, !cleared);
  return cleared;
}

/** Removes again the rows that could not be removed before (spec 09 §1), as the page starts. */
export async function finishPendingPurges(): Promise<void> {
  for (const accountId of pendingPurges()) await clearAccount(accountId);
}

async function removeRows(accountId: string): Promise<boolean> {
  if (!(await offlineDatabaseMightExist())) return true;
  const opened = await offlineDb();
  if (!opened.available) return false;
  try {
    const tx = opened.db.transaction(STORES, 'readwrite');
    const finished = tx.done.then(
      () => true,
      () => false,
    );
    try {
      const range = accountRange(accountId);
      await Promise.all(STORES.map((store) => tx.objectStore(store).delete(range)));
    } catch {
      abort(tx);
    }
    return await finished;
  } catch {
    return false;
  }
}

export async function offlineUsage(accountId: string): Promise<OfflineUsage> {
  const unsent = await countRecords(accountId);
  const loaded = await loadManifest(accountId);
  return { ...usageOf(loaded?.manifest, loaded?.now ?? Date.now()), unsent };
}

async function loadManifest(
  accountId: string,
): Promise<{ manifest: Manifest | undefined; now: number } | undefined> {
  if (!isAccountId(accountId) || isPurgePending(accountId)) return undefined;
  if (!(await offlineDatabaseMightExist())) return undefined;
  const opened = await offlineDb();
  if (!opened.available) return undefined;
  try {
    const found = await opened.db.get('meta', rowKey(accountId, MANIFEST));
    return { manifest: isManifest(found) ? found : undefined, now: Date.now() };
  } catch {
    return undefined;
  }
}
