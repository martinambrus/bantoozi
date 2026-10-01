import { sql } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Raters, link tokens and rating sessions (spec 10 §2.2, §2.4; spec 02 §7).
 *
 * A rater row is one **reading context** of one human: `participant_key` (an opaque random UUID)
 * groups every context the same person authored and rated, so readiness, macro averages and win
 * counts count humans, never persona rows (spec 10 §4, §5). `name` and `context_name` are labels.
 *
 * Only a hash of the link token and of each session cookie is stored. Revoking a rater or issuing
 * a new token deletes its sessions, so no cookie obtained with the old token survives; neither
 * touches the rater's cards, feeds, assignments or ratings.
 */

export interface RaterRow {
  id: string;
  name: string;
  participantKey: string;
  contextName: string | null;
  langs: string[];
  tokenExpiresAt: Date;
  tokenRevokedAt: Date | null;
  createdAt: Date;
}

type RaterDbRow = {
  id: string;
  name: string;
  participant_key: string;
  context_name: string | null;
  langs: string[];
  token_expires_at: RawTimestamp;
  token_revoked_at: RawTimestamp | null;
  created_at: RawTimestamp;
};

const RATER_COLUMNS = sql`r.id::text AS id, r.name, r.participant_key::text AS participant_key,
  r.context_name, r.langs, r.token_expires_at, r.token_revoked_at, r.created_at`;

const toRater = (row: RaterDbRow): RaterRow => ({
  id: row.id,
  name: row.name,
  participantKey: row.participant_key,
  contextName: row.context_name,
  langs: row.langs,
  tokenExpiresAt: toDate(row.token_expires_at),
  tokenRevokedAt: toDateOrNull(row.token_revoked_at),
  createdAt: toDate(row.created_at),
});

export interface CreateRaterInput {
  name: string;
  participantKey: string;
  contextName: string | null;
  langs: readonly string[];
  tokenHash: string;
  tokenExpiresAt: Date;
}

export async function createRater(db: Executor, input: CreateRaterInput): Promise<RaterRow> {
  const result = await db.execute<RaterDbRow>(sql`
    INSERT INTO eval.raters AS r (name, participant_key, context_name, token_hash, token_expires_at,
                                  langs)
    VALUES (${input.name}, ${input.participantKey}::uuid, ${input.contextName}, ${input.tokenHash},
            ${input.tokenExpiresAt.toISOString()}::timestamptz, ${sql.param([...input.langs])}::text[])
    RETURNING ${RATER_COLUMNS}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('rater insert returned no row');
  return toRater(row);
}

export async function getRater(db: Executor, raterId: string): Promise<RaterRow | null> {
  const result = await db.execute<RaterDbRow>(
    sql`SELECT ${RATER_COLUMNS} FROM eval.raters r WHERE r.id = ${raterId}::bigint`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toRater(row);
}

/** Every rater, oldest first (the first one is the owner, spec 10 §2.3). */
export async function listRaters(db: Executor): Promise<RaterRow[]> {
  const result = await db.execute<RaterDbRow>(
    sql`SELECT ${RATER_COLUMNS} FROM eval.raters r ORDER BY r.created_at, r.id`,
  );
  return result.rows.map(toRater);
}

/** Whether a participant key already names some rater (a new context must join a known human). */
export async function participantExists(db: Executor, participantKey: string): Promise<boolean> {
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM eval.raters WHERE participant_key = ${participantKey}::uuid)
           AS found`);
  return result.rows[0]?.found === true;
}

/**
 * Issue a new link token (spec 10 §2.4): new hash and expiry, revocation cleared, and every
 * existing session deleted, so sessions from the old token end at once. False when no such rater.
 */
export async function reissueRaterToken(
  db: Executor,
  raterId: string,
  input: { tokenHash: string; tokenExpiresAt: Date },
): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE eval.raters SET token_hash = ${input.tokenHash},
           token_expires_at = ${input.tokenExpiresAt.toISOString()}::timestamptz,
           token_revoked_at = NULL
     WHERE id = ${raterId}::bigint`);
  if ((updated.rowCount ?? 0) === 0) return false;
  await db.execute(sql`DELETE FROM eval.rater_sessions WHERE rater_id = ${raterId}::bigint`);
  return true;
}

/**
 * Revoke a rater's token and end its sessions (spec 10 §2.4). Idempotent: an already revoked token
 * keeps its first revocation time. False when no such rater.
 */
export async function revokeRater(db: Executor, raterId: string, now: Date): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE eval.raters SET token_revoked_at = coalesce(token_revoked_at,
                                                       ${now.toISOString()}::timestamptz)
     WHERE id = ${raterId}::bigint`);
  if ((updated.rowCount ?? 0) === 0) return false;
  await db.execute(sql`DELETE FROM eval.rater_sessions WHERE rater_id = ${raterId}::bigint`);
  return true;
}

/** The rater whose current token hashes to `tokenHash`, only while it is unexpired and unrevoked. */
export async function findRaterByToken(
  db: Executor,
  tokenHash: string,
  now: Date,
): Promise<RaterRow | null> {
  const result = await db.execute<RaterDbRow>(sql`
    SELECT ${RATER_COLUMNS} FROM eval.raters r
     WHERE r.token_hash = ${tokenHash} AND r.token_revoked_at IS NULL
       AND r.token_expires_at > ${now.toISOString()}::timestamptz`);
  const row = result.rows[0];
  return row === undefined ? null : toRater(row);
}

/**
 * A session row for the token the caller just validated; its expiry is capped at the token's
 * (spec 10 §2.4). The insert re-checks, in the same statement, that `tokenHash` is still the
 * rater's current, unrevoked, unexpired token, so a reissue or revocation that lands between the
 * exchange's validation and this insert leaves no session behind. `FOR SHARE` orders the insert
 * against a concurrent reissue/revoke (which update the row, then delete its sessions): either the
 * insert waits and re-reads the new hash, or it commits first and the reissue deletes it. Null
 * when the check fails.
 */
export async function createRaterSession(
  db: Executor,
  input: { sessionHash: string; raterId: string; tokenHash: string; expiresAt: Date; now: Date },
): Promise<Date | null> {
  const result = await db.execute<{ expires_at: RawTimestamp }>(sql`
    INSERT INTO eval.rater_sessions (session_hash, rater_id, created_at, expires_at)
    SELECT ${input.sessionHash}, r.id, ${input.now.toISOString()}::timestamptz,
           least(${input.expiresAt.toISOString()}::timestamptz, r.token_expires_at)
      FROM eval.raters r
     WHERE r.id = ${input.raterId}::bigint AND r.token_hash = ${input.tokenHash}
       AND r.token_revoked_at IS NULL
       AND r.token_expires_at > ${input.now.toISOString()}::timestamptz
       FOR SHARE OF r
    RETURNING expires_at`);
  const row = result.rows[0];
  return row === undefined ? null : toDate(row.expires_at);
}

/**
 * The rater behind a session cookie. Every request rechecks the session's expiry, the token's
 * expiry and its revocation (spec 10 §2.4); null when any fails or the session is gone.
 */
export async function raterForSession(
  db: Executor,
  sessionHash: string,
  now: Date,
): Promise<RaterRow | null> {
  const result = await db.execute<RaterDbRow>(sql`
    SELECT ${RATER_COLUMNS} FROM eval.rater_sessions s JOIN eval.raters r ON r.id = s.rater_id
     WHERE s.session_hash = ${sessionHash}
       AND s.expires_at > ${now.toISOString()}::timestamptz
       AND r.token_revoked_at IS NULL
       AND r.token_expires_at > ${now.toISOString()}::timestamptz`);
  const row = result.rows[0];
  return row === undefined ? null : toRater(row);
}

export async function deleteRaterSession(db: Executor, sessionHash: string): Promise<void> {
  await db.execute(sql`DELETE FROM eval.rater_sessions WHERE session_hash = ${sessionHash}`);
}

/** Housekeeping: drop expired sessions; returns the number deleted. */
export async function deleteExpiredRaterSessions(db: Executor, now: Date): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM eval.rater_sessions WHERE expires_at <= ${now.toISOString()}::timestamptz`,
  );
  return result.rowCount ?? 0;
}

// ── Participants (actual humans) ──────────────────────────────────────────────────────────────────

/** One actual human and the reading contexts (rater rows) they authored and rated. */
export interface Participant {
  participantKey: string;
  /** Rater ids of this human's contexts, oldest first. */
  raterIds: string[];
  /** The earliest context's creation time. */
  firstCreatedAt: Date;
}

/**
 * Group rater rows by actual human (spec 10 §2.2, §4, §5): metrics, readiness and win counts count
 * these groups, never rater rows. Participants are ordered by their first context, so the owner
 * (the first rater ever added) comes first.
 */
export function groupByParticipant(
  raters: ReadonlyArray<Pick<RaterRow, 'id' | 'participantKey' | 'createdAt'>>,
): Participant[] {
  const sorted = [...raters].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.length - b.id.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const groups = new Map<string, Participant>();
  for (const rater of sorted) {
    const group = groups.get(rater.participantKey);
    if (group === undefined) {
      groups.set(rater.participantKey, {
        participantKey: rater.participantKey,
        raterIds: [rater.id],
        firstCreatedAt: rater.createdAt,
      });
    } else {
      group.raterIds.push(rater.id);
    }
  }
  return [...groups.values()];
}

/** rater id → participant key, for joining per-rater rows (ratings, scores) to humans. */
export function participantIndex(
  raters: ReadonlyArray<Pick<RaterRow, 'id' | 'participantKey'>>,
): Map<string, string> {
  return new Map(raters.map((r) => [r.id, r.participantKey]));
}

/**
 * The owner: the participant of the earliest rater (spec 10 §2.3, the primary facet labeller and
 * the `owner_pilot` participant). Null when there are no raters.
 */
export function ownerParticipantKey(
  raters: ReadonlyArray<Pick<RaterRow, 'id' | 'participantKey' | 'createdAt'>>,
): string | null {
  return groupByParticipant(raters)[0]?.participantKey ?? null;
}

/** Rating progress of one actual human (spec 10 §2.2 readiness: distinct articles, not contexts). */
export interface ParticipantRatingCounts {
  participantKey: string;
  contexts: number;
  /** Distinct articles with at least one rating in any of this human's contexts. */
  distinctRatedArticles: number;
  /** Rating rows over all contexts (one article rated in three contexts counts three times here). */
  ratings: number;
  likes: number;
  dislikes: number;
}

/** Per-participant rating counts; participants without ratings are included with zeros. */
export async function participantRatingCounts(db: Executor): Promise<ParticipantRatingCounts[]> {
  const result = await db.execute<{
    participant_key: string;
    contexts: number;
    distinct_rated: number;
    ratings: number;
    likes: number;
    dislikes: number;
  }>(sql`
    SELECT r.participant_key::text AS participant_key,
           count(DISTINCT r.id)::int AS contexts,
           count(DISTINCT g.article_id)::int AS distinct_rated,
           count(g.article_id)::int AS ratings,
           count(*) FILTER (WHERE g.rating = 1)::int AS likes,
           count(*) FILTER (WHERE g.rating = -1)::int AS dislikes
      FROM eval.raters r LEFT JOIN eval.ratings g ON g.rater_id = r.id
     GROUP BY r.participant_key
     ORDER BY min(r.created_at), min(r.id)`);
  return result.rows.map((row) => ({
    participantKey: row.participant_key,
    contexts: row.contexts,
    distinctRatedArticles: row.distinct_rated,
    ratings: row.ratings,
    likes: row.likes,
    dislikes: row.dislikes,
  }));
}
