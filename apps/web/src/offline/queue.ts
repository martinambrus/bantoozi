import { offlineDatabaseMightExist, offlineDb, type OfflineDb } from './db.js';
import { isOfflineEnabled } from './device.js';
import { clearsOf } from './epoch.js';
import { accountRange, isAccountId, rowKey } from './names.js';
import type { QueueRecord } from './types.js';

export type { QueueRecord } from './types.js';

/**
 * The reader actions an account made without a connection and has not sent (spec 09 §1). They are
 * the person's work: they never expire and are never given up for room.
 */

async function existing(): Promise<OfflineDb | null> {
  if (!(await offlineDatabaseMightExist())) return null;
  const opened = await offlineDb();
  return opened.available ? opened.db : null;
}

/** Keeps the record, replacing the one with its id. False while the account has not chosen offline reading. */
export async function putRecord(record: QueueRecord): Promise<boolean> {
  const { accountId } = record;
  if (!isAccountId(accountId) || !isOfflineEnabled(accountId)) return false;
  const clears = clearsOf(accountId);
  const opened = await offlineDb();
  if (!opened.available) return false;
  if (!isOfflineEnabled(accountId) || clearsOf(accountId) !== clears) return false;
  try {
    await opened.db.put('queue', record, rowKey(accountId, record.id));
    return true;
  } catch {
    return false;
  }
}

/** The account's records, the earliest made first. */
export async function listRecords(accountId: string): Promise<QueueRecord[]> {
  const db = isAccountId(accountId) ? await existing() : null;
  if (db === null) return [];
  try {
    const records = await db.getAll('queue', accountRange(accountId));
    return records.sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  } catch {
    return [];
  }
}

export async function deleteRecord(accountId: string, id: string): Promise<void> {
  const db = isAccountId(accountId) ? await existing() : null;
  if (db === null) return;
  try {
    await db.delete('queue', rowKey(accountId, id));
  } catch {
    // A record that cannot be removed is sent again, which the server tolerates.
  }
}

export async function countRecords(accountId: string): Promise<number> {
  const db = isAccountId(accountId) ? await existing() : null;
  if (db === null) return 0;
  try {
    return await db.count('queue', accountRange(accountId));
  } catch {
    return 0;
  }
}

/** Puts every record of the account in `state`; returns how many were in another one. */
export async function setRecordsState(
  accountId: string,
  state: QueueRecord['state'],
): Promise<number> {
  const db = isAccountId(accountId) ? await existing() : null;
  if (db === null) return 0;
  try {
    const tx = db.transaction('queue', 'readwrite');
    const finished = tx.done.then(
      () => true,
      () => false,
    );
    let changed = 0;
    try {
      let cursor = await tx.store.openCursor(accountRange(accountId));
      while (cursor !== null) {
        if (cursor.value.state !== state) {
          await cursor.update({ ...cursor.value, state });
          changed += 1;
        }
        cursor = await cursor.continue();
      }
    } catch {
      try {
        tx.abort();
      } catch {
        // The transaction already finished.
      }
    }
    return (await finished) ? changed : 0;
  } catch {
    return 0;
  }
}
