import { createDatabase, deletionLedgerEntryId, purgeUser } from '@bantoozi/db';
import { deletionEmailHmac } from '@bantoozi/shared/server';
import type pg from 'pg';

import { decryptBytes } from './age-stream.js';

/**
 * Replays the off-site deletion ledger on a restored database (spec 11 §4.1 step 3, §5.1): the
 * erasures made after the backup was taken are applied again before anything is served. Each ledger
 * line is the base64 of an age file holding `{id, userId, deletedAt, emailHmac}`; copies of the
 * ledger overlap, so entries are deduplicated by id.
 *
 * Pre-account rows have no user key, so they are found by `emailHmac`: every `waitlist` row and
 * every unused, email-bound invite whose normalized e-mail hashes to an entry is deleted (this
 * reaches a person who signed up after the backup). A user that still exists is hard-deleted by
 * the same code path as `house.purge-users`, but only when the entry is the one `house.purge-users`
 * wrote for that user: its id must be the stable id of `userId` and its `emailHmac` must match the
 * restored user's e-mail; any other entry is skipped and counted as mismatched. Restored sessions and login codes are revoked so an
 * old revocation cannot be undone by the restore.
 */

export interface LedgerEntry {
  id: string;
  userId: string;
  deletedAt: string;
  emailHmac: string;
}

export interface ReplayResult {
  entries: number;
  users: number;
  waitlist: number;
  invites: number;
  sessionsRevoked: number;
  loginCodesDeleted: number;
  /** Entries skipped because their id or e-mail hash does not belong to the restored user. */
  mismatched: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function parseEntry(text: string): LedgerEntry {
  const value = JSON.parse(text) as Partial<LedgerEntry> | null;
  if (
    value === null ||
    typeof value.id !== 'string' ||
    typeof value.userId !== 'string' ||
    !UUID.test(value.userId) ||
    typeof value.deletedAt !== 'string' ||
    Number.isNaN(Date.parse(value.deletedAt)) ||
    typeof value.emailHmac !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.emailHmac)
  ) {
    throw new Error('a deletion-ledger entry is malformed');
  }
  return {
    id: value.id,
    userId: value.userId,
    deletedAt: value.deletedAt,
    emailHmac: value.emailHmac,
  };
}

/** The distinct entries of base64-age ledger lines, in order of first appearance. */
export async function decryptLedgerLines(
  identities: readonly string[],
  lines: readonly string[],
): Promise<LedgerEntry[]> {
  const entries = new Map<string, LedgerEntry>();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let plain: Uint8Array;
    try {
      plain = await decryptBytes(identities, Buffer.from(line.trim(), 'base64'));
    } catch {
      throw new Error('a deletion-ledger line does not decrypt with the identity');
    }
    const entry = parseEntry(Buffer.from(plain).toString('utf8'));
    if (!entries.has(entry.id)) entries.set(entry.id, entry);
  }
  return [...entries.values()];
}

const DAY_MS = 86_400_000;

export async function replayLedger(
  pool: pg.Pool,
  entries: readonly LedgerEntry[],
  hmacKey: string,
): Promise<ReplayResult> {
  const result: ReplayResult = {
    entries: entries.length,
    users: 0,
    waitlist: 0,
    invites: 0,
    sessionsRevoked: 0,
    loginCodesDeleted: 0,
    mismatched: 0,
  };
  const hashes = new Set(entries.map((entry) => entry.emailHmac));

  const waitlist = await pool.query<{ email: string }>('SELECT email::text AS email FROM waitlist');
  for (const row of waitlist.rows) {
    if (!hashes.has(deletionEmailHmac(row.email, hmacKey))) continue;
    result.waitlist +=
      (await pool.query('DELETE FROM waitlist WHERE email = $1', [row.email])).rowCount ?? 0;
  }
  const invites = await pool.query<{ code: string; email: string }>(
    'SELECT code, email::text AS email FROM invites WHERE email IS NOT NULL AND used_at IS NULL',
  );
  for (const row of invites.rows) {
    if (!hashes.has(deletionEmailHmac(row.email, hmacKey))) continue;
    result.invites +=
      (await pool.query('DELETE FROM invites WHERE code = $1 AND used_at IS NULL', [row.code]))
        .rowCount ?? 0;
  }

  const db = createDatabase(pool);
  for (const entry of entries) {
    if (entry.id !== deletionLedgerEntryId(entry.userId)) {
      result.mismatched += 1;
      continue;
    }
    const found = await pool.query<{ email: string }>(
      'SELECT email::text AS email FROM users WHERE id = $1',
      [entry.userId],
    );
    const email = found.rows[0]?.email;
    if (email === undefined) continue;
    if (deletionEmailHmac(email, hmacKey) !== entry.emailHmac) {
      result.mismatched += 1;
      continue;
    }
    // Every mutation for an entry comes after both identity checks (entry id and e-mail HMAC).
    await pool.query('UPDATE invites SET email = NULL, note = NULL WHERE used_by = $1', [
      entry.userId,
    ]);
    const deletedAt = new Date(entry.deletedAt);
    await pool.query(
      'UPDATE users SET deleted_at = LEAST(coalesce(deleted_at, $2::timestamptz), $2::timestamptz) WHERE id = $1',
      [entry.userId, deletedAt.toISOString()],
    );
    const outcome = await purgeUser(
      db,
      { id: entry.userId, email, deletedAt },
      {
        now: new Date(Math.max(Date.now(), deletedAt.getTime() + 8 * DAY_MS)),
        emailHmac: (value) => deletionEmailHmac(value, hmacKey),
        // The entry is already in the ledger; there is nothing to append.
        append: async () => undefined,
      },
    );
    if (outcome !== 'deleted') throw new Error(`replaying an erasure ended as ${outcome}`);
    result.users += 1;
  }

  result.sessionsRevoked =
    (await pool.query('UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL'))
      .rowCount ?? 0;
  result.loginCodesDeleted = (await pool.query('DELETE FROM login_codes')).rowCount ?? 0;
  return result;
}

export function formatReplay(result: ReplayResult): string {
  return (
    `REPLAY entries=${result.entries} users=${result.users} waitlist=${result.waitlist} ` +
    `invites=${result.invites} sessions_revoked=${result.sessionsRevoked} ` +
    `login_codes_deleted=${result.loginCodesDeleted} mismatched=${result.mismatched}`
  );
}
