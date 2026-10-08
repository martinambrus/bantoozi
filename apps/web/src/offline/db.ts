import { wrap, type IDBPDatabase, type IDBPTransaction } from 'idb';

import { OFFLINE_DB, OFFLINE_DB_VERSION, STORES } from './names.js';
import type { OfflineSchema } from './types.js';

export interface Migration {
  /** The database version this step leads to; it runs for databases older than that. */
  version: number;
  /**
   * Runs inside the versionchange transaction. Awaiting anything but requests of that transaction
   * ends it, so a migration may be async only to chain its own requests.
   */
  upgrade: (
    db: IDBPDatabase<unknown>,
    transaction: IDBPTransaction<unknown, string[], 'versionchange'>,
  ) => void | Promise<void>;
}

export interface OpenOptions {
  indexedDB?: IDBFactory | undefined;
  /** Steps after the built-in ones, for the next release (and for tests). */
  migrations?: readonly Migration[] | undefined;
}

export type OfflineDb = IDBPDatabase<OfflineSchema>;
export type OpenResult = { available: true; db: OfflineDb } | { available: false };

export interface VersionChange {
  oldVersion: number;
  newVersion: number | null;
}

const FIRST_VERSION: Migration = {
  version: OFFLINE_DB_VERSION,
  upgrade: (db) => {
    for (const name of STORES) db.createObjectStore(name);
  },
};

const versionListeners = new Set<(change: VersionChange) => void>();

/** Another tab runs a newer version that needs this connection closed; returns the stop function. */
export function onOfflineDbVersionChange(listener: (change: VersionChange) => void): () => void {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}

function tellVersionChange(change: VersionChange) {
  for (const listener of [...versionListeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('An offline database version listener failed', error);
    }
  }
}

function upgrade(request: IDBOpenDBRequest, oldVersion: number, steps: readonly Migration[]) {
  const raw = request.transaction;
  if (raw === null) return;
  const db = wrap(request.result);
  const transaction = wrap(raw) as unknown as IDBPTransaction<unknown, string[], 'versionchange'>;
  // An aborted migration is reported as an unavailable database, not as a rejection nobody awaits.
  transaction.done.catch(() => undefined);
  const abort = () => {
    try {
      raw.abort();
    } catch {
      // The transaction already finished.
    }
  };
  const run = (pending: readonly Migration[]): void => {
    for (const [index, step] of pending.entries()) {
      if (step.version <= oldVersion) continue;
      let outcome: void | Promise<void>;
      try {
        outcome = step.upgrade(db, transaction);
      } catch {
        abort();
        return;
      }
      if (outcome instanceof Promise) {
        outcome.then(() => run(pending.slice(index + 1)), abort);
        return;
      }
    }
  };
  run(steps);
}

let shared: Promise<OpenResult> | null = null;
let sharedDb: OfflineDb | null = null;

/**
 * Opens the offline database, creating it and running the migrations it has not been through. A
 * browser that cannot open it (no IndexedDB, a private mode, a newer version stored, a failed
 * migration) answers `available: false`; this never rejects.
 */
export function openOfflineDb(options: OpenOptions = {}): Promise<OpenResult> {
  const factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  const steps = [FIRST_VERSION, ...(options.migrations ?? [])].sort(
    (a, b) => a.version - b.version,
  );
  const target = steps.reduce((highest, step) => Math.max(highest, step.version), 1);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OpenResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (factory === undefined) {
      finish({ available: false });
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(OFFLINE_DB, target);
    } catch {
      finish({ available: false });
      return;
    }
    request.addEventListener('upgradeneeded', (event) => {
      upgrade(request, event.oldVersion, steps);
    });
    request.addEventListener('blocked', () => finish({ available: false }));
    request.addEventListener('error', () => finish({ available: false }));
    request.addEventListener('success', () => {
      const db = wrap(request.result) as unknown as OfflineDb;
      if (settled) {
        db.close();
        return;
      }
      db.addEventListener('versionchange', (event) => {
        db.close();
        if (sharedDb === db) {
          sharedDb = null;
          shared = null;
        }
        tellVersionChange({ oldVersion: event.oldVersion, newVersion: event.newVersion });
      });
      finish({ available: true, db });
    });
  });
}

/** The connection the app shares. Opening is retried while it keeps failing. */
export function offlineDb(): Promise<OpenResult> {
  if (shared === null) {
    const opening: Promise<OpenResult> = openOfflineDb().then((result) => {
      if (result.available) sharedDb = result.db;
      else if (shared === opening) shared = null;
      return result;
    });
    shared = opening;
  }
  return shared;
}

/** False when no offline database was ever created here, so that looking does not create one. */
export async function offlineDatabaseMightExist(): Promise<boolean> {
  if (shared !== null) return true;
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases !== 'function') return true;
  try {
    return (await indexedDB.databases()).some((info) => info.name === OFFLINE_DB);
  } catch {
    return true;
  }
}

/** Closes the shared connection; the next use opens it again. */
export async function resetOfflineDb(): Promise<void> {
  const current = shared;
  shared = null;
  sharedDb = null;
  if (current === null) return;
  const result = await current;
  if (result.available) result.db.close();
}
