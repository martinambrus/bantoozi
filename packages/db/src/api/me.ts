import { sql } from 'drizzle-orm';

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
