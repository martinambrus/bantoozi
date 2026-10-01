import { randomInt } from 'node:crypto';

import { CROCKFORD_ALPHABET, INVITE_CODE_LENGTH, planMinIntervalMap } from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Database, Executor, Transaction } from '../client.js';
import { recordRankIntents } from '../ingest/rank-intents.js';
import { tenantOutbox } from '../outbox.js';
import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Auth, login codes, invites and waitlist (spec 08 §2, spec 02 §2). These are auth/bootstrap tables
 * without tenant RLS (spec 02 §1.2 exception): a login resolves before a tenant exists, so every
 * function here filters explicitly by the normalized email, the code row or the authenticated
 * user's id. Emails arrive normalized (trimmed, lower-cased) and are compared as `citext`.
 */

/** A soft-deleted account can be restored by signing in within this window (spec 08 §2.1). */
export const RESTORE_WINDOW_DAYS = 7;

/**
 * Serialize code requests and verifications for one normalized email (spec 08 §2.1): a
 * transaction-scoped advisory lock, released at commit or rollback.
 */
export async function lockAuthEmail(tx: Transaction, email: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bantoozi:auth-email:${email}`}, 0))`,
  );
}

export interface AuthUser {
  id: string;
  email: string;
  deletedAt: Date | null;
  /** Active, or soft-deleted less than {@link RESTORE_WINDOW_DAYS} ago. */
  restorable: boolean;
}

type AuthUserRow = {
  id: string;
  email: string;
  deleted_at: RawTimestamp | null;
  restorable: boolean;
};

const authUser = (row: AuthUserRow): AuthUser => ({
  id: row.id,
  email: row.email,
  deletedAt: toDateOrNull(row.deleted_at),
  restorable: row.restorable,
});

/** The users row of an email, active or soft-deleted (not yet purged); `null` when unknown. */
export async function findUserByEmail(db: Executor, email: string): Promise<AuthUser | null> {
  const result = await db.execute<AuthUserRow>(sql`
    SELECT id::text AS id, email::text AS email, deleted_at,
           (deleted_at IS NULL
             OR deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS})) AS restorable
      FROM users WHERE email = ${email}::citext`);
  const row = result.rows[0];
  return row === undefined ? null : authUser(row);
}

/**
 * Lock a user row for verification (`FOR UPDATE`): the worker's purge locks the same row and
 * rechecks `deleted_at`, so a restore and a purge cannot both win (spec 08 §2.1, spec 11 §5.1).
 */
export async function lockUserForVerify(tx: Transaction, userId: string): Promise<AuthUser | null> {
  const result = await tx.execute<AuthUserRow>(sql`
    SELECT id::text AS id, email::text AS email, deleted_at,
           (deleted_at IS NULL
             OR deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS})) AS restorable
      FROM users WHERE id = ${userId}::uuid
       FOR UPDATE`);
  const row = result.rows[0];
  return row === undefined ? null : authUser(row);
}

/**
 * Whether `code` is a usable invite for `email`: unused, unexpired and, when email-bound, bound to
 * this address (spec 08 §2.1). With `lock`, the invite row stays locked until commit, so two
 * signups racing for it serialize and the second sees it used.
 */
export async function findUsableInvite(
  db: Executor,
  input: { code: string; email: string; lock?: boolean },
): Promise<boolean> {
  const result = await db.execute<{ code: string }>(sql`
    SELECT code FROM invites
     WHERE code = ${input.code} AND used_at IS NULL AND expires_at > now()
       AND (email IS NULL OR email = ${input.email}::citext)
     ${input.lock === true ? sql`FOR UPDATE` : sql``}`);
  return result.rows.length === 1;
}

export interface NewLoginCode {
  email: string;
  /** Fresh random UUID, part of the digest; never the identity id (spec 02 §2). */
  challengeNonce: string;
  /** `HMAC-SHA256(SESSION_PEPPER, canonical(nonce, email, code))`; the code is never stored. */
  codeHash: string;
  purpose: 'login' | 'signup';
  /** Required for `login`, `null` for `signup`. */
  loginUserId: string | null;
  inviteCode: string | null;
  locale: 'en' | 'sk' | null;
  requestedIp: string | null;
  ttlSeconds: number;
}

/**
 * Store a new challenge for an email (spec 08 §2.1): every older unconsumed code of the email is
 * invalidated first (marked consumed), so at most one code is live (`login_codes_active_email_idx`).
 * Run under {@link lockAuthEmail}.
 */
export async function issueLoginCode(tx: Transaction, input: NewLoginCode): Promise<string> {
  await tx.execute(sql`
    UPDATE login_codes SET consumed_at = now()
     WHERE email = ${input.email}::citext AND consumed_at IS NULL`);
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO login_codes (email, challenge_nonce, code_hash, purpose, login_user_id, invite_code,
                             locale, expires_at, requested_ip)
    VALUES (${input.email}::citext, ${input.challengeNonce}::uuid, ${input.codeHash},
            ${input.purpose}, ${input.loginUserId}::uuid, ${input.inviteCode}, ${input.locale},
            now() + make_interval(secs => ${input.ttlSeconds}), ${input.requestedIp}::inet)
    RETURNING id::text AS id`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('login code insert returned no row');
  return row.id;
}

export interface ActiveLoginCode {
  id: string;
  challengeNonce: string;
  codeHash: string;
  purpose: 'login' | 'signup';
  loginUserId: string | null;
  inviteCode: string | null;
  locale: 'en' | 'sk' | null;
  attempts: number;
  /** `expires_at <= now()` at read time. */
  expired: boolean;
}

/** The email's unconsumed code, locked `FOR UPDATE` (the challenge row lock of spec 08 §2.1). */
export async function lockActiveLoginCode(
  tx: Transaction,
  email: string,
): Promise<ActiveLoginCode | null> {
  const result = await tx.execute<{
    id: string;
    challenge_nonce: string;
    code_hash: string;
    purpose: 'login' | 'signup';
    login_user_id: string | null;
    invite_code: string | null;
    locale: string | null;
    attempts: number;
    expired: boolean;
  }>(sql`
    SELECT id::text AS id, challenge_nonce::text AS challenge_nonce, code_hash, purpose,
           login_user_id::text AS login_user_id, invite_code, locale, attempts,
           expires_at <= now() AS expired
      FROM login_codes
     WHERE email = ${email}::citext AND consumed_at IS NULL
     ORDER BY id DESC LIMIT 1
       FOR UPDATE`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    challengeNonce: row.challenge_nonce,
    codeHash: row.code_hash,
    purpose: row.purpose,
    loginUserId: row.login_user_id,
    inviteCode: row.invite_code,
    locale: row.locale === 'en' || row.locale === 'sk' ? row.locale : null,
    attempts: row.attempts,
    expired: row.expired,
  };
}

/** Count one failed verification (capped by the `attempts BETWEEN 0 AND 5` check). */
export async function recordFailedLoginAttempt(
  tx: Transaction,
  input: { id: string; maxAttempts: number },
): Promise<void> {
  await tx.execute(sql`
    UPDATE login_codes SET attempts = attempts + 1
     WHERE id = ${input.id}::bigint AND attempts < ${input.maxAttempts}`);
}

/** Consume a code; `false` when it was consumed meanwhile (cannot happen under the row lock). */
export async function consumeLoginCode(tx: Transaction, id: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE login_codes SET consumed_at = now()
     WHERE id = ${id}::bigint AND consumed_at IS NULL`);
  return result.rowCount === 1;
}

export interface NewSignupUser {
  /** UUID v7 generated in code. */
  id: string;
  email: string;
  locale: 'en' | 'sk';
  role: 'user' | 'admin';
  /** The plan's `invitesOnSignup`. */
  invitesLeft: number;
}

/**
 * Insert the users row of a signup (spec 08 §2.1). `false` when the email already has a row
 * (`ON CONFLICT DO NOTHING`): the caller treats it as an ineligible code.
 */
export async function insertSignupUser(tx: Transaction, input: NewSignupUser): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO users (id, email, locale, role, invites_left)
    VALUES (${input.id}::uuid, ${input.email}::citext, ${input.locale}, ${input.role},
            ${input.invitesLeft})
    ON CONFLICT (email) DO NOTHING`);
  return result.rowCount === 1;
}

/**
 * Mark an invite used by `userId`, conditionally (`used_at IS NULL AND expires_at > now()`, email
 * binding rechecked). `false` when it is no longer usable.
 */
export async function consumeInvite(
  tx: Transaction,
  input: { code: string; email: string; userId: string },
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE invites SET used_at = now(), used_by = ${input.userId}::uuid
     WHERE code = ${input.code} AND used_at IS NULL AND expires_at > now()
       AND (email IS NULL OR email = ${input.email}::citext)`);
  return result.rowCount === 1;
}

/** Delete the waitlist entry of an email: a new account replaces it (spec 08 §2.1). */
export async function deleteWaitlistEntry(tx: Transaction, email: string): Promise<void> {
  await tx.execute(sql`DELETE FROM waitlist WHERE email = ${email}::citext`);
}

/**
 * Bookkeeping of every successful verify (spec 08 §2.1): re-apply the `ADMIN_EMAILS` bootstrap role
 * and update `last_active_at`.
 */
export async function recordVerifiedLogin(
  tx: Transaction,
  input: { userId: string; admin: boolean },
): Promise<void> {
  await tx.execute(sql`
    UPDATE users
       SET role = CASE WHEN ${input.admin}::boolean THEN 'admin' ELSE role END, last_active_at = now()
     WHERE id = ${input.userId}::uuid`);
}

/**
 * Restore the tenant's soft-deleted account within the window (spec 08 §2.1, spec 11 §5.1): clear
 * `deleted_at`, recompute subscriber counts, fetch intervals and `feed_cards` of the user's feeds,
 * advance `rank_revision` and enqueue `user.rank {full: true}` in the same transaction. Call with
 * the users row locked ({@link lockUserForVerify}). Returns the refreshed feed ids.
 */
export async function restoreSoftDeletedUser(tx: TenantTx): Promise<string[]> {
  const userId = tenantUserId(tx);
  const restored = await tx.execute(sql`
    UPDATE users SET deleted_at = NULL
     WHERE id = ${userId}::uuid AND deleted_at IS NOT NULL
       AND deleted_at > now() - make_interval(days => ${RESTORE_WINDOW_DAYS})`);
  if (restored.rowCount !== 1) throw new Error('account is not restorable');
  const feeds = await tx.execute<{ feed_id: string }>(sql`
    SELECT feed_id::text AS feed_id FROM subscriptions
     WHERE user_id = ${userId}::uuid ORDER BY feed_id`);
  const feedIds = feeds.rows.map((row) => row.feed_id);
  if (feedIds.length > 0) {
    await tx.execute(sql`
      SELECT refresh_feed_subscribers(${sql.param(feedIds)}::bigint[],
                                      ${JSON.stringify(planMinIntervalMap())}::jsonb)`);
    await tx.execute(sql`SELECT refresh_feed_cards(${sql.param(feedIds)}::bigint[])`);
  }
  await recordRankIntents(tx, tenantOutbox(tx), [userId], {
    reason: 'account.restore',
    full: true,
  });
  return feedIds;
}

// ---------------------------------------------------------------------------------------------
// Invites (spec 08 §2.2)
// ---------------------------------------------------------------------------------------------

/** A new invite code: 10 Crockford base32 characters from a CSPRNG (spec 02 §2). */
export function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  }
  return code;
}

/** Invites expire this long after creation (spec 08 §2.2). */
export const INVITE_TTL_DAYS = 30;
const INVITE_INSERT_ATTEMPTS = 8;

export interface InviteRow {
  code: string;
  email: string | null;
  note: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

type RawInvite = {
  code: string;
  email: string | null;
  note: string | null;
  created_at: RawTimestamp;
  expires_at: RawTimestamp;
  used_at: RawTimestamp | null;
};

const inviteRow = (row: RawInvite): InviteRow => ({
  code: row.code,
  email: row.email,
  note: row.note,
  createdAt: toDate(row.created_at),
  expiresAt: toDate(row.expires_at),
  usedAt: toDateOrNull(row.used_at),
});

/**
 * Create `count` invites (spec 08 §2.2, §9 admin invites): CSPRNG codes, expiring in
 * {@link INVITE_TTL_DAYS} days; a code collision is retried with a new code (`ON CONFLICT DO
 * NOTHING`, so the transaction stays usable). Quota checks (`invites_left`) are the caller's.
 */
export async function createInvites(
  tx: Executor,
  input: {
    createdBy: string | null;
    email?: string | null;
    note?: string | null;
    count?: number;
    /** Days until expiry; defaults to {@link INVITE_TTL_DAYS} (admins choose up to 90). */
    expiresDays?: number;
    /** Test seam; defaults to {@link newInviteCode}. */
    generate?: () => string;
  },
): Promise<InviteRow[]> {
  const count = input.count ?? 1;
  const generate = input.generate ?? newInviteCode;
  const created: InviteRow[] = [];
  for (let n = 0; n < count; n += 1) {
    let row: RawInvite | undefined;
    for (let attempt = 0; attempt < INVITE_INSERT_ATTEMPTS && row === undefined; attempt += 1) {
      const result = await tx.execute<RawInvite>(sql`
        INSERT INTO invites (code, created_by, email, note, expires_at)
        VALUES (${generate()}, ${input.createdBy}::uuid, ${input.email ?? null}::citext,
                ${input.note ?? null}, now() + make_interval(days => ${input.expiresDays ?? INVITE_TTL_DAYS}::int))
        ON CONFLICT (code) DO NOTHING
        RETURNING code, email::text AS email, note, created_at, expires_at, used_at`);
      row = result.rows[0];
    }
    if (row === undefined) throw new Error('could not generate a unique invite code');
    created.push(inviteRow(row));
  }
  return created;
}

/**
 * Take one invite slot of the tenant (spec 08 §2.2): `invites_left > 0` is required and decremented
 * atomically under the users row lock. Returns the inviter's display name and the slots left, or
 * `null` when none was left.
 */
export async function takeInviteSlot(
  tx: TenantTx,
): Promise<{ invitesLeft: number; displayName: string | null } | null> {
  const result = await tx.execute<{ invites_left: number; display_name: string | null }>(sql`
    UPDATE users SET invites_left = invites_left - 1
     WHERE id = ${tenantUserId(tx)}::uuid AND deleted_at IS NULL AND invites_left > 0
    RETURNING invites_left, display_name`);
  const row = result.rows[0];
  return row === undefined
    ? null
    : { invitesLeft: row.invites_left, displayName: row.display_name };
}

/** At most this many invites are listed (newest first); plans grant far fewer. */
export const INVITE_LIST_LIMIT = 500;

/** The tenant's invites, newest first, and its remaining slots (spec 08 §2.2 `GET /invites`). */
export async function listOwnInvites(
  tx: TenantTx,
): Promise<{ items: InviteRow[]; invitesLeft: number }> {
  const userId = tenantUserId(tx);
  const invites = await tx.execute<RawInvite>(sql`
    SELECT code, email::text AS email, note, created_at, expires_at, used_at
      FROM invites WHERE created_by = ${userId}::uuid
     ORDER BY created_at DESC, code
     LIMIT ${INVITE_LIST_LIMIT}`);
  const user = await tx.execute<{ invites_left: number }>(
    sql`SELECT invites_left FROM users WHERE id = ${userId}::uuid`,
  );
  return { items: invites.rows.map(inviteRow), invitesLeft: user.rows[0]?.invites_left ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Waitlist (spec 08 §2.2)
// ---------------------------------------------------------------------------------------------

/**
 * Add or refresh a waitlist entry (public). An address that already has an account is not listed;
 * the caller answers identically either way, so existence is never revealed. It runs under
 * {@link lockAuthEmail}, like verification, so a signup racing it either sees and deletes the new
 * entry or commits its account before this check reads it.
 */
export async function upsertWaitlistEntry(
  db: Database,
  input: { email: string; locale: 'en' | 'sk'; note: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockAuthEmail(tx, input.email);
    await tx.execute(sql`
      INSERT INTO waitlist (email, locale, note)
      SELECT ${input.email}::citext, ${input.locale}, ${input.note}
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${input.email}::citext)
      ON CONFLICT (email) DO UPDATE
         SET locale = EXCLUDED.locale, note = coalesce(EXCLUDED.note, waitlist.note)`);
  });
}
