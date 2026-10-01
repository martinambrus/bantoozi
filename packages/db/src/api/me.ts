import { sql, type SQL } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * The signed-in user's own `users` row (spec 08 §3). `users` is an auth table without tenant RLS,
 * so every query here filters by the transaction's tenant explicitly.
 */

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  locale: 'en' | 'sk';
  timezone: string;
  role: 'user' | 'admin';
  plan: string;
  invitesLeft: number;
  rankRevision: string;
  /** Stored JSON; apply `readUserPreferences` for defaults. */
  preferences: unknown;
  createdAt: Date;
  lastActiveAt: Date | null;
  deletedAt: Date | null;
}

type Row = {
  id: string;
  email: string;
  display_name: string | null;
  locale: 'en' | 'sk';
  timezone: string;
  role: 'user' | 'admin';
  plan: string;
  invites_left: number;
  rank_revision: string;
  preferences: unknown;
  created_at: RawTimestamp;
  last_active_at: RawTimestamp | null;
  deleted_at: RawTimestamp | null;
};

/** The tenant's users row; `lock` takes `FOR NO KEY UPDATE` (preference merges, quota writes). */
export async function readOwnUser(
  tx: TenantTx,
  options: { lock?: boolean } = {},
): Promise<UserRow> {
  const result = await tx.execute<Row>(sql`
    SELECT id::text AS id, email::text AS email, display_name, locale, timezone, role, plan,
           invites_left, rank_revision::text AS rank_revision, preferences, created_at,
           last_active_at, deleted_at
      FROM users WHERE id = ${tenantUserId(tx)}::uuid
      ${options.lock === true ? sql`FOR NO KEY UPDATE` : sql``}`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('tenant user row is missing');
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    locale: row.locale,
    timezone: row.timezone,
    role: row.role,
    plan: row.plan,
    invitesLeft: row.invites_left,
    rankRevision: row.rank_revision,
    preferences: row.preferences,
    createdAt: toDate(row.created_at),
    lastActiveAt: toDateOrNull(row.last_active_at),
    deletedAt: toDateOrNull(row.deleted_at),
  };
}

/** The supplied `users` columns of `PATCH /me` (missing = unchanged; spec 08 §1.1, §3). */
export interface OwnUserPatch {
  displayName?: string | null;
  locale?: 'en' | 'sk';
  timezone?: string;
  /** The complete merged preferences (the caller merged them under the row lock). */
  preferences?: unknown;
}

/** Update only the supplied columns of the tenant's own row. */
export async function updateOwnUser(tx: TenantTx, patch: OwnUserPatch): Promise<void> {
  const sets: SQL[] = [];
  if (patch.displayName !== undefined) sets.push(sql`display_name = ${patch.displayName}`);
  if (patch.locale !== undefined) sets.push(sql`locale = ${patch.locale}`);
  if (patch.timezone !== undefined) sets.push(sql`timezone = ${patch.timezone}`);
  if (patch.preferences !== undefined) {
    sets.push(sql`preferences = ${JSON.stringify(patch.preferences)}::jsonb`);
  }
  if (sets.length === 0) return;
  await tx.execute(sql`
    UPDATE users SET ${sql.join(sets, sql`, `)}
     WHERE id = ${tenantUserId(tx)}::uuid AND deleted_at IS NULL`);
}

/**
 * Soft-delete the tenant's account (spec 08 §3 `DELETE /me`): `deleted_at = now()`. The caller
 * revokes the sessions and refreshes the user's feeds in the same transaction; `house.purge-users`
 * hard-deletes after 7 days and a verified login before then restores (spec 08 §2.1).
 */
export async function softDeleteOwnUser(tx: TenantTx): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE users SET deleted_at = now()
     WHERE id = ${tenantUserId(tx)}::uuid AND deleted_at IS NULL`);
  return (result.rowCount ?? 0) > 0;
}

// ── Export (spec 08 §3 `GET /me/export`) ────────────────────────────────────────────────────

export interface ExportRating {
  url: string | null;
  title: string;
  rating: 1 | -1;
  reason: string | null;
  ratedAt: Date;
}

/** The user's current ratings, oldest first. */
export async function exportRatings(tx: TenantTx): Promise<ExportRating[]> {
  const result = await tx.execute<{
    url: string | null;
    title: string;
    rating: 1 | -1;
    reason: string | null;
    rated_at: RawTimestamp;
  }>(sql`
    SELECT a.url, a.title, ua.rating, ua.reason, ua.rated_at
      FROM user_article ua JOIN articles a ON a.id = ua.article_id
     WHERE ua.user_id = ${tenantUserId(tx)}::uuid AND ua.rating IS NOT NULL
     ORDER BY ua.rated_at, ua.article_id`);
  return result.rows.map((row) => ({
    url: row.url,
    title: row.title,
    rating: row.rating,
    reason: row.reason,
    ratedAt: toDate(row.rated_at),
  }));
}

export interface ExportRule {
  id: string;
  kind: string;
  value: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** The user's rules, oldest first. */
export async function exportRules(tx: TenantTx): Promise<ExportRule[]> {
  const result = await tx.execute<{
    id: string;
    kind: string;
    value: string;
    created_at: RawTimestamp;
    expires_at: RawTimestamp | null;
  }>(sql`
    SELECT id::text AS id, kind, value, created_at, expires_at FROM user_rules
     WHERE user_id = ${tenantUserId(tx)}::uuid ORDER BY id`);
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    value: row.value,
    createdAt: toDate(row.created_at),
    expiresAt: toDateOrNull(row.expires_at),
  }));
}

/** One retained bookmark with its capture state and bound snapshot (spec 08 §5.2 shapes). */
export interface ExportBookmark {
  articleId: string;
  /**
   * The exact `bookmarked_at` as PostgreSQL text (microsecond precision): the keyset cursor. A JS
   * `Date` keeps only milliseconds and would repeat rows across pages.
   */
  cursorAt: string;
  url: string | null;
  title: string;
  bookmarkedAt: Date;
  capture: {
    status: 'pending' | 'saved' | 'partial' | 'failed';
    generation: string;
    snapshotId: string | null;
    capturedAt: Date | null;
    errorCode: string | null;
  };
  /** The captured origin feed (`bookmark_origin_feed_id`) and its remembered image policy. */
  originFeedId: string | null;
  originImagePolicy: 'inherit' | 'allow' | 'block' | null;
  snapshot: {
    id: string;
    sourceUrl: string | null;
    title: string;
    author: string | null;
    publishedAt: Date | null;
    capturedAt: Date;
    contentRevision: string;
    completeness: 'complete' | 'partial';
    text: string;
    html: string | null;
  } | null;
}

/**
 * A keyset page of the user's bookmarks (bookmark time, then article id), each with the full
 * retained snapshot text/HTML. Read through the snapshot RLS policy (the caller's own bookmark).
 */
export async function exportBookmarksPage(
  tx: TenantTx,
  input: { after: { cursorAt: string; articleId: string } | null; limit: number },
): Promise<ExportBookmark[]> {
  const after =
    input.after === null
      ? sql``
      : sql`AND (ua.bookmarked_at, ua.article_id)
                > (${input.after.cursorAt}::timestamptz,
                   ${input.after.articleId}::bigint)`;
  const result = await tx.execute<{
    article_id: string;
    cursor_at: string;
    url: string | null;
    title: string;
    bookmarked_at: RawTimestamp;
    capture_status: ExportBookmark['capture']['status'];
    generation: string;
    error_code: string | null;
    origin_feed_id: string | null;
    image_policy: ExportBookmark['originImagePolicy'];
    snapshot_id: string | null;
    source_url: string | null;
    snapshot_title: string | null;
    author: string | null;
    published_at: RawTimestamp | null;
    captured_at: RawTimestamp | null;
    source_revision: string | null;
    completeness: 'complete' | 'partial' | null;
    body_text: string | null;
    body_html: string | null;
  }>(sql`
    SELECT ua.article_id::text AS article_id, a.url, a.title, ua.bookmarked_at,
           ua.bookmarked_at::text AS cursor_at,
           ua.bookmark_capture_status AS capture_status,
           ua.bookmark_capture_generation::text AS generation,
           ua.bookmark_capture_error_code AS error_code,
           ua.bookmark_origin_feed_id::text AS origin_feed_id, p.image_policy,
           s.id::text AS snapshot_id, s.source_url, s.title AS snapshot_title, s.author,
           s.published_at, s.captured_at, s.source_revision::text AS source_revision,
           s.completeness, s.body_text, s.body_html
      FROM user_article ua
      JOIN articles a ON a.id = ua.article_id
      LEFT JOIN article_snapshots s ON s.id = ua.bookmark_snapshot_id
      LEFT JOIN user_feed_preferences p
             ON p.user_id = ua.user_id AND p.feed_id = ua.bookmark_origin_feed_id
     WHERE ua.user_id = ${tenantUserId(tx)}::uuid AND ua.bookmarked_at IS NOT NULL ${after}
     ORDER BY ua.bookmarked_at, ua.article_id
     LIMIT ${input.limit}`);
  return result.rows.map((row) => ({
    articleId: row.article_id,
    cursorAt: row.cursor_at,
    url: row.url,
    title: row.title,
    bookmarkedAt: toDate(row.bookmarked_at),
    capture: {
      status: row.capture_status,
      generation: row.generation,
      snapshotId: row.snapshot_id,
      capturedAt: toDateOrNull(row.captured_at),
      errorCode: row.error_code,
    },
    originFeedId: row.origin_feed_id,
    originImagePolicy: row.image_policy,
    snapshot:
      row.snapshot_id === null || row.captured_at === null
        ? null
        : {
            id: row.snapshot_id,
            sourceUrl: row.source_url,
            title: row.snapshot_title ?? row.title,
            author: row.author,
            publishedAt: toDateOrNull(row.published_at),
            capturedAt: toDate(row.captured_at),
            contentRevision: row.source_revision ?? '1',
            completeness: row.completeness ?? 'partial',
            text: row.body_text ?? '',
            html: row.body_html,
          },
  }));
}
