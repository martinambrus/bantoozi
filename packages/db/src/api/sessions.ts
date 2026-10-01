import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, type RawTimestamp } from '../timestamps.js';

/**
 * Sessions (spec 08 §2.1, spec 02 §2). `sessions` and `users` are auth tables without tenant RLS:
 * the API resolves a cookie before a tenant exists, so these named functions are the only access
 * path, always filtered by the token hash or by the authenticated user's id.
 */

/** Sliding refresh happens at most this often (spec 08 §2.1). */
export const SESSION_SLIDE_INTERVAL_SECONDS = 300;

export interface SessionContext {
  /** `sessions.id` as a decimal string: the public session id, never the token or its hash. */
  sessionId: string;
  userId: string;
  email: string;
  role: 'user' | 'admin';
  plan: string;
  locale: 'en' | 'sk';
  lastSeenAt: Date;
  expiresAt: Date;
}

type SessionRow = {
  session_id: string;
  user_id: string;
  email: string;
  role: 'user' | 'admin';
  plan: string;
  locale: 'en' | 'sk';
  last_seen_at: RawTimestamp;
  expires_at: RawTimestamp;
};

/**
 * The live session of a token hash: unrevoked, unexpired, and its user not soft-deleted. The role
 * comes from the current users row on every request (spec 08 §1 "Authorization").
 */
export async function resolveSession(
  db: Executor,
  tokenHash: string,
): Promise<SessionContext | null> {
  const result = await db.execute<SessionRow>(sql`
    SELECT s.id::text AS session_id, s.user_id::text AS user_id, u.email::text AS email, u.role,
           u.plan, u.locale, s.last_seen_at, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.deleted_at IS NULL`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    plan: row.plan,
    locale: row.locale,
    lastSeenAt: toDate(row.last_seen_at),
    expiresAt: toDate(row.expires_at),
  };
}

/**
 * Slide a session: when its `last_seen_at` is older than {@link SESSION_SLIDE_INTERVAL_SECONDS},
 * refresh `last_seen_at`, `expires_at` and the user's `last_active_at` in one statement. Returns the
 * new expiry, or `null` when nothing was due (or the session ended meanwhile).
 */
export async function slideSession(
  db: Executor,
  input: { sessionId: string; ttlDays: number },
): Promise<Date | null> {
  const result = await db.execute<{ expires_at: RawTimestamp }>(sql`
    WITH slid AS (
      UPDATE sessions s
         SET last_seen_at = now(), expires_at = now() + make_interval(days => ${input.ttlDays})
       WHERE s.id = ${input.sessionId}::bigint AND s.revoked_at IS NULL AND s.expires_at > now()
         AND s.last_seen_at < now() - make_interval(secs => ${SESSION_SLIDE_INTERVAL_SECONDS})
      RETURNING s.user_id, s.expires_at),
    active AS (
      UPDATE users u SET last_active_at = now()
        FROM slid WHERE u.id = slid.user_id AND u.deleted_at IS NULL
      RETURNING u.id)
    SELECT expires_at FROM slid`);
  const row = result.rows[0];
  return row === undefined ? null : toDate(row.expires_at);
}

export interface NewSession {
  userId: string;
  /** SHA-256 hex of the random 32-byte token; the token itself is never stored. */
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  ttlDays: number;
}

/** Insert a session; the caller has already authenticated the user (verify or tests). */
export async function createSession(
  db: Executor,
  input: NewSession,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const result = await db.execute<{ id: string; expires_at: RawTimestamp }>(sql`
    INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
    VALUES (${input.userId}::uuid, ${input.tokenHash}, ${input.userAgent?.slice(0, 512) ?? null},
            ${input.ip}::inet, now() + make_interval(days => ${input.ttlDays}))
    RETURNING id::text AS id, expires_at`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('session insert returned no row');
  return { sessionId: row.id, expiresAt: toDate(row.expires_at) };
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/** The user's active sessions, newest first (spec 08 §2.1 `GET /auth/sessions`). */
export async function listSessions(db: Executor, userId: string): Promise<SessionSummary[]> {
  const result = await db.execute<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    created_at: RawTimestamp;
    last_seen_at: RawTimestamp;
  }>(sql`
    SELECT id::text AS id, user_agent, host(ip) AS ip, created_at, last_seen_at
      FROM sessions
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC, id DESC`);
  return result.rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    ip: row.ip,
    createdAt: toDate(row.created_at),
    lastSeenAt: toDate(row.last_seen_at),
  }));
}

/** Revoke one of the user's own sessions; `false` when it is not theirs or already ended. */
export async function revokeSession(
  db: Executor,
  input: { userId: string; sessionId: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE sessions SET revoked_at = now()
     WHERE id = ${input.sessionId}::bigint AND user_id = ${input.userId}::uuid
       AND revoked_at IS NULL AND expires_at > now()`);
  return result.rowCount === 1;
}

/** Revoke every live session of a user (account deletion, role downgrade). */
export async function revokeUserSessions(db: Executor, userId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE sessions SET revoked_at = now()
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`);
  return result.rowCount ?? 0;
}
