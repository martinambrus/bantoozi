import {
  AppError,
  CandidateValidationSchema,
  planMinIntervalMap,
  type CandidateStatus,
  type CandidateValidation,
  type Provider,
} from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { librarySeedTextHash } from '../library/library-cards.js';
import type { TenantTx } from '../tenant.js';
import { toDate, toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Admin repositories (spec 08 §9–10). Control-plane tables (`users`, `settings`, `invites`,
 * `waitlist`, `feeds`, `usage_daily`) have no tenant RLS and are read here with explicit DTO
 * allowlists (spec 02 §1.2 exception). Everything the API role cannot read directly goes through
 * the approved SECURITY DEFINER functions, which re-check the administrator context in SQL
 * (`admin_context_allowed()`): provider credential metadata and state changes, holder counts, usage
 * attribution, publication requests, promotion and library versions (spec 02 §6). Callers run
 * these inside the administrator's tenant transaction, after the route's role check.
 */

const bigintParam = (value: string): SQL => sql`${value}::bigint`;

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

export interface StoredSettingRow {
  key: string;
  value: unknown;
  updatedAt: Date;
}

/** The stored rows of `keys` (missing keys are absent). */
export async function readSettingRows(
  db: Executor,
  keys: readonly string[],
): Promise<StoredSettingRow[]> {
  if (keys.length === 0) return [];
  const result = await db.execute<{ key: string; value: unknown; updated_at: RawTimestamp }>(sql`
    SELECT key, value, updated_at FROM settings WHERE key = ANY(${sql.param([...keys])}::text[])
     ORDER BY key`);
  return result.rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: toDate(row.updated_at),
  }));
}

/**
 * Serialize admin writers of these settings keys for the rest of the transaction (spec 08 §9:
 * "lock/version the settings rows"): a transaction advisory lock per key, in key order, so a
 * missing row (whose first write is an insert) is serialized as well, then the rows are read
 * `FOR UPDATE`. The values returned stay current until commit for every writer that also locks.
 */
export async function lockSettingRows(
  tx: Transaction,
  keys: readonly string[],
): Promise<StoredSettingRow[]> {
  const sorted = [...new Set(keys)].sort();
  for (const key of sorted) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`settings:${key}`}))`);
  }
  if (sorted.length === 0) return [];
  const result = await tx.execute<{ key: string; value: unknown; updated_at: RawTimestamp }>(sql`
    SELECT key, value, updated_at FROM settings WHERE key = ANY(${sql.param(sorted)}::text[])
     ORDER BY key FOR UPDATE`);
  return result.rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: toDate(row.updated_at),
  }));
}

/** Upsert a validated setting value, attributed to the administrator. */
export async function writeSetting(
  tx: Executor,
  input: { key: string; value: unknown; updatedBy: string | null },
): Promise<void> {
  const value = JSON.stringify(input.value);
  await tx.execute(sql`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES (${input.key}, ${value}::jsonb, now(), ${input.updatedBy}::uuid)
    ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`);
}

/** The kinds of the given question set ids (unknown ids are absent). */
export async function questionSetKinds(
  db: Executor,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ id: string; kind: string }>(sql`
    SELECT id::text AS id, kind FROM question_sets WHERE id = ANY(${sql.param([...ids])}::bigint[])`);
  return new Map(result.rows.map((row) => [row.id, row.kind]));
}

/** Non-deleted users active within the last `days` days (`users.last_active_at`, spec 08 §2.1). */
export async function activeUserIds(db: Executor, days: number): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM users
     WHERE deleted_at IS NULL AND last_active_at >= now() - make_interval(days => ${days}::int)
     ORDER BY id`);
  return result.rows.map((row) => row.id);
}

// ── Overview and usage ───────────────────────────────────────────────────────────────────────────

export interface AdminOverviewCounts {
  usersTotal: number;
  usersActive7d: number;
  feeds: Record<'active' | 'quarantined' | 'dead' | 'paused', number>;
  articlesToday: number;
  queues: { queue: string; created: number; retry: number; active: number; failed: number }[];
  spendTodayUsd: number;
  llmCallsToday: number;
  tier2CallsToday: number;
  translations24h: {
    engine: 'libretranslate' | 'ollama';
    quality: 'ok' | 'weak' | 'fail';
    count: number;
  }[];
}

const TODAY_UTC = sql`(now() AT TIME ZONE 'UTC')::date`;

/** The aggregate counts behind `GET /admin/overview` (spec 08 §9). No per-user or content data. */
export async function adminOverviewCounts(tx: TenantTx): Promise<AdminOverviewCounts> {
  const users = await tx.execute<{ total: number; active: number }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE last_active_at >= now() - interval '7 days')::int AS active
      FROM users WHERE deleted_at IS NULL`);
  const feeds = await tx.execute<{ status: string; n: number }>(
    sql`SELECT status, count(*)::int AS n FROM feeds GROUP BY status`,
  );
  const articles = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM articles
     WHERE first_seen_at >= (${TODAY_UTC})::timestamp AT TIME ZONE 'UTC'`);
  const queues = await tx.execute<{
    queue: string;
    created: string;
    retry: string;
    active: string;
    failed: string;
  }>(sql`SELECT queue, created, retry, active, failed FROM queue_state_counts()`);
  const usage = await tx.execute<{ spend: string; llm: number; tier2: number }>(sql`
    SELECT coalesce(sum(cost_usd), 0)::text AS spend,
           coalesce(sum(calls) FILTER (WHERE engine = 'llm'
                                       AND kind IN ('enrich','match','cluster','suggest')), 0)::int AS llm,
           coalesce(sum(calls) FILTER (WHERE engine = 'llm' AND kind = 'translate'), 0)::int AS tier2
      FROM usage_daily WHERE day = ${TODAY_UTC}`);
  const translations = await tx.execute<{ engine: string; quality: string; n: number }>(sql`
    SELECT engine, quality, count(*)::int AS n FROM article_translations
     WHERE created_at >= now() - interval '24 hours'
     GROUP BY engine, quality ORDER BY engine, quality`);
  const feedCounts = { active: 0, quarantined: 0, dead: 0, paused: 0 };
  for (const row of feeds.rows) {
    if (Object.hasOwn(feedCounts, row.status)) {
      feedCounts[row.status as keyof typeof feedCounts] = row.n;
    }
  }
  const usageRow = usage.rows[0];
  return {
    usersTotal: users.rows[0]?.total ?? 0,
    usersActive7d: users.rows[0]?.active ?? 0,
    feeds: feedCounts,
    articlesToday: articles.rows[0]?.n ?? 0,
    queues: queues.rows.map((row) => ({
      queue: row.queue,
      created: Number(row.created),
      retry: Number(row.retry),
      active: Number(row.active),
      failed: Number(row.failed),
    })),
    spendTodayUsd: Number(usageRow?.spend ?? 0),
    llmCallsToday: usageRow?.llm ?? 0,
    tier2CallsToday: usageRow?.tier2 ?? 0,
    translations24h: translations.rows.map((row) => ({
      engine: row.engine as 'libretranslate' | 'ollama',
      quality: row.quality as 'ok' | 'weak' | 'fail',
      count: row.n,
    })),
  };
}

export interface UsageDailyRow {
  day: string;
  engine: string;
  kind: string;
  calls: number;
  costUsd: number;
}

/** Spend per UTC day, engine and kind over the last `days` days (`usage_daily`). */
export async function adminUsageDaily(tx: TenantTx, days: number): Promise<UsageDailyRow[]> {
  const result = await tx.execute<{
    day: string;
    engine: string;
    kind: string;
    calls: number;
    cost: string;
  }>(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, engine, kind, sum(calls)::int AS calls,
           sum(cost_usd)::text AS cost
      FROM usage_daily
     WHERE day > ${TODAY_UTC} - ${days}::int AND day <= ${TODAY_UTC}
     GROUP BY day, engine, kind ORDER BY day, engine, kind`);
  return result.rows.map((row) => ({
    day: row.day,
    engine: row.engine,
    kind: row.kind,
    calls: row.calls,
    costUsd: Number(row.cost),
  }));
}

export interface UsageAttributionRow {
  userId: string;
  email: string | null;
  directUsd: number;
  sharedUsd: number;
  totalUsd: number;
}

/**
 * The top users by attributed cost over `days` days through `admin_usage_attribution(days)` (spec 02
 * §6, spec 04 §7): an estimate based on current holders, not historical billing.
 */
export async function usageTopUsers(
  tx: TenantTx,
  days: number,
  limit: number,
): Promise<UsageAttributionRow[]> {
  const result = await tx.execute<{
    user_id: string;
    email: string | null;
    direct: string;
    shared: string;
    total: string;
  }>(sql`
    SELECT a.user_id::text AS user_id, u.email::text AS email, a.direct_usd::text AS direct,
           a.shared_usd::text AS shared, (a.direct_usd + a.shared_usd)::text AS total
      FROM admin_usage_attribution(${days}::int) a
      LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.direct_usd + a.shared_usd DESC, a.user_id
     LIMIT ${limit}::int`);
  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    directUsd: Number(row.direct),
    sharedUsd: Number(row.shared),
    totalUsd: Number(row.total),
  }));
}

// ── Provider credentials (spec 08 §9.1, spec 02 §6) ──────────────────────────────────────────────

export interface AdminCredentialRow {
  provider: Provider;
  revision: string;
  enabled: boolean;
  activeVersion: string | null;
  candidateVersion: string | null;
  candidateStatus: CandidateStatus | null;
  candidateValidation: CandidateValidation;
  validatedAt: Date | null;
  lastErrorCode: string | null;
}

/** Metadata of every stored provider row via `admin_provider_credentials_metadata()`. */
export async function adminCredentialMetadata(tx: TenantTx): Promise<AdminCredentialRow[]> {
  const result = await tx.execute<{
    provider: Provider;
    revision: string;
    enabled: boolean;
    active_version: string | null;
    candidate_version: string | null;
    candidate_status: CandidateStatus | null;
    candidate_validation: unknown;
    validated_at: RawTimestamp | null;
    last_error_code: string | null;
  }>(sql`
    SELECT provider, revision::text AS revision, enabled, active_version::text AS active_version,
           candidate_version::text AS candidate_version, candidate_status, candidate_validation,
           validated_at, last_error_code
      FROM admin_provider_credentials_metadata()`);
  return result.rows.map((row) => {
    const validation = CandidateValidationSchema.safeParse(row.candidate_validation ?? {});
    return {
      provider: row.provider,
      revision: row.revision,
      enabled: row.enabled,
      activeVersion: row.active_version,
      candidateVersion: row.candidate_version,
      candidateStatus: row.candidate_status,
      candidateValidation: validation.success ? validation.data : {},
      validatedAt: toDateOrNull(row.validated_at),
      lastErrorCode: row.last_error_code,
    };
  });
}

/**
 * Stage an already encrypted envelope as the candidate at `expectedRevision + 1`
 * (`admin_stage_provider_credential`): no provider call; the active version stays usable.
 */
export async function adminStageCredential(
  tx: TenantTx,
  input: { provider: Provider; expectedRevision: string; envelope: unknown },
): Promise<void> {
  await tx.execute(sql`
    SELECT revision FROM admin_stage_provider_credential(
      ${input.provider}, ${bigintParam(input.expectedRevision)}, ${JSON.stringify(input.envelope)}::jsonb)`);
}

/**
 * Explicit Validate (`admin_validate_provider_credential`): queues `provider.validate
 * {provider, candidateVersion}` for a settled candidate or a `validating` one whose lease expired;
 * a live lease is a conflict (D-87).
 */
export async function adminValidateCredential(
  tx: TenantTx,
  input: { provider: Provider; candidateVersion: string; expectedRevision: string },
): Promise<void> {
  await tx.execute(sql`
    SELECT admin_validate_provider_credential(
      ${input.provider}, ${bigintParam(input.candidateVersion)}, ${bigintParam(input.expectedRevision)})`);
}

/** Activate the exact candidate validated within 24 h (`admin_activate_provider_credential`). */
export async function adminActivateCredential(
  tx: TenantTx,
  input: { provider: Provider; candidateVersion: string; expectedRevision: string },
): Promise<void> {
  await tx.execute(sql`
    SELECT revision FROM admin_activate_provider_credential(
      ${input.provider}, ${bigintParam(input.expectedRevision)}, ${bigintParam(input.candidateVersion)})`);
}

/**
 * Local revocation (`admin_set_provider_enabled(…, false)`): erase both envelopes and keep a
 * disabled tombstone, so the environment fallback cannot silently re-enable the provider.
 */
export async function adminRevokeCredential(
  tx: TenantTx,
  input: { provider: Provider; expectedRevision: string },
): Promise<void> {
  await tx.execute(sql`
    SELECT revision FROM admin_set_provider_enabled(
      ${input.provider}, ${bigintParam(input.expectedRevision)}, false)`);
}

// ── Feeds ────────────────────────────────────────────────────────────────────────────────────────

export interface AdminFeedRow {
  id: string;
  url: string;
  siteUrl: string | null;
  title: string | null;
  status: 'active' | 'quarantined' | 'dead' | 'paused';
  subscriberCount: number;
  consecutiveErrors: number;
  quarantineCount: number;
  quarantinedUntil: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  nextFetchAt: Date;
  minIntervalS: number;
  mergedIntoId: string | null;
  fetchOptions: Record<string, unknown>;
}

type FeedRow = {
  id: string;
  url: string;
  site_url: string | null;
  title: string | null;
  status: AdminFeedRow['status'];
  subscriber_count: number;
  consecutive_errors: number;
  quarantine_count: number;
  quarantined_until: RawTimestamp | null;
  last_success_at: RawTimestamp | null;
  last_error_code: string | null;
  last_error_at: RawTimestamp | null;
  next_fetch_at: RawTimestamp;
  min_interval_s: number;
  merged_into_id: string | null;
  fetch_options: unknown;
};

const FEED_COLUMNS = sql`
  f.id::text AS id, f.url, f.site_url, f.title, f.status, f.subscriber_count, f.consecutive_errors,
  f.quarantine_count, f.quarantined_until, f.last_success_at, f.last_error_code, f.last_error_at,
  f.next_fetch_at, f.min_interval_s, f.merged_into_id::text AS merged_into_id, f.fetch_options`;

function toFeed(row: FeedRow): AdminFeedRow {
  const options = row.fetch_options;
  return {
    id: row.id,
    url: row.url,
    siteUrl: row.site_url,
    title: row.title,
    status: row.status,
    subscriberCount: row.subscriber_count,
    consecutiveErrors: row.consecutive_errors,
    quarantineCount: row.quarantine_count,
    quarantinedUntil: toDateOrNull(row.quarantined_until),
    lastSuccessAt: toDateOrNull(row.last_success_at),
    lastErrorCode: row.last_error_code,
    lastErrorAt: toDateOrNull(row.last_error_at),
    nextFetchAt: toDate(row.next_fetch_at),
    minIntervalS: row.min_interval_s,
    mergedIntoId: row.merged_into_id,
    fetchOptions:
      options !== null && typeof options === 'object' && !Array.isArray(options)
        ? (options as Record<string, unknown>)
        : {},
  };
}

/** `%`, `_` and `\` escaped for an `ILIKE … ESCAPE '\'` substring search. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Feed health, ordered by id, after the keyset `afterId` (spec 08 §9 `GET /admin/feeds`). */
export async function listAdminFeeds(
  db: Executor,
  input: { status?: string; q?: string; afterId?: string; limit: number },
): Promise<AdminFeedRow[]> {
  const filters: SQL[] = [sql`true`];
  if (input.status !== undefined) filters.push(sql`f.status = ${input.status}`);
  if (input.q !== undefined) {
    const pattern = likePattern(input.q);
    filters.push(
      sql`(f.url ILIKE ${pattern} ESCAPE '\\' OR f.title ILIKE ${pattern} ESCAPE '\\' OR f.site_url ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (input.afterId !== undefined) filters.push(sql`f.id > ${bigintParam(input.afterId)}`);
  const result = await db.execute<FeedRow>(sql`
    SELECT ${FEED_COLUMNS} FROM feeds f WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY f.id LIMIT ${input.limit}::int`);
  return result.rows.map(toFeed);
}

/** One feed row, locked for the rest of the transaction when `lock` is set. */
export async function getAdminFeed(
  db: Executor,
  feedId: string,
  options: { lock?: boolean } = {},
): Promise<AdminFeedRow | null> {
  const result = await db.execute<FeedRow>(sql`
    SELECT ${FEED_COLUMNS} FROM feeds f WHERE f.id = ${bigintParam(feedId)}
    ${options.lock === true ? sql`FOR NO KEY UPDATE` : sql``}`);
  const row = result.rows[0];
  return row === undefined ? null : toFeed(row);
}

/** Replace `feeds.fetch_options` with an allowlisted object (spec 03 §4). */
export async function updateFeedFetchOptions(
  tx: Executor,
  feedId: string,
  fetchOptions: Record<string, unknown>,
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE feeds SET fetch_options = ${JSON.stringify(fetchOptions)}::jsonb, updated_at = now()
     WHERE id = ${bigintParam(feedId)}`);
  return result.rowCount === 1;
}

/**
 * Clear quarantine/dead (spec 08 §9 `POST /admin/feeds/:id/reset`): the feed is active again with
 * a clean error streak and is due at once. A merged (retired) feed identity is never revived.
 */
export async function resetAdminFeed(tx: Executor, feedId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE feeds
       SET status = 'active', consecutive_errors = 0, first_error_at = NULL,
           quarantined_until = NULL, quarantine_count = 0, next_fetch_at = now(), updated_at = now()
     WHERE id = ${bigintParam(feedId)} AND merged_into_id IS NULL`);
  return result.rowCount === 1;
}

// ── Users, invites, waitlist ─────────────────────────────────────────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  plan: string;
  invitesLeft: number;
  createdAt: Date;
  lastActiveAt: Date | null;
  deletedAt: Date | null;
}

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  role: 'user' | 'admin';
  plan: string;
  invites_left: number;
  created_at: RawTimestamp;
  last_active_at: RawTimestamp | null;
  deleted_at: RawTimestamp | null;
};

const USER_COLUMNS = sql`
  u.id::text AS id, u.email::text AS email, u.display_name, u.role, u.plan, u.invites_left,
  u.created_at, u.last_active_at, u.deleted_at`;

function toUser(row: UserRow): AdminUserRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    plan: row.plan,
    invitesLeft: row.invites_left,
    createdAt: toDate(row.created_at),
    lastActiveAt: toDateOrNull(row.last_active_at),
    deletedAt: toDateOrNull(row.deleted_at),
  };
}

/** Users ordered by id (UUID v7: signup order) after `afterId`, optionally searched by email/name. */
export async function listAdminUsers(
  db: Executor,
  input: { q?: string; afterId?: string; limit: number },
): Promise<AdminUserRow[]> {
  const filters: SQL[] = [sql`true`];
  if (input.q !== undefined) {
    const pattern = likePattern(input.q);
    filters.push(
      sql`(u.email::text ILIKE ${pattern} ESCAPE '\\' OR u.display_name ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (input.afterId !== undefined) filters.push(sql`u.id > ${input.afterId}::uuid`);
  const result = await db.execute<UserRow>(sql`
    SELECT ${USER_COLUMNS} FROM users u WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY u.id LIMIT ${input.limit}::int`);
  return result.rows.map(toUser);
}

export async function getAdminUser(db: Executor, userId: string): Promise<AdminUserRow | null> {
  const result = await db.execute<UserRow>(
    sql`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ${userId}::uuid`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toUser(row);
}

export interface AdminUserUpdate {
  role?: 'user' | 'admin' | undefined;
  plan?: string | undefined;
  invitesLeft?: number | undefined;
}

export type AdminUserUpdateResult =
  | { status: 'not_found' }
  | { status: 'last_admin' }
  | {
      status: 'updated';
      before: AdminUserRow;
      user: AdminUserRow;
      changed: (keyof AdminUserUpdate)[];
      sessionsRevoked: number;
    };

/**
 * Admin user edit (spec 08 §9 "Admin write constraints"). Locks the target and, for a demotion,
 * every active administrator's row in UUID order (the documented user lock order), so two
 * concurrent demotions cannot remove the last active admin. A role downgrade revokes the user's
 * sessions; a plan change recomputes `feeds.min_interval_s` for the subscribed feeds
 * (`refresh_feed_subscribers`, spec 08 §6). Unchanged fields are not written.
 */
export async function updateAdminUser(
  tx: TenantTx,
  userId: string,
  update: AdminUserUpdate,
): Promise<AdminUserUpdateResult> {
  const demoting = update.role === 'user';
  await tx.execute(sql`
    SELECT u.id FROM users u
     WHERE u.id = ${userId}::uuid
        ${demoting ? sql`OR (u.role = 'admin' AND u.deleted_at IS NULL)` : sql``}
     ORDER BY u.id FOR NO KEY UPDATE`);
  const before = await getAdminUser(tx, userId);
  if (before === null) return { status: 'not_found' };

  const changed: (keyof AdminUserUpdate)[] = [];
  if (update.role !== undefined && update.role !== before.role) changed.push('role');
  if (update.plan !== undefined && update.plan !== before.plan) changed.push('plan');
  if (update.invitesLeft !== undefined && update.invitesLeft !== before.invitesLeft) {
    changed.push('invitesLeft');
  }

  if (changed.includes('role') && update.role === 'user' && before.deletedAt === null) {
    const others = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users
       WHERE role = 'admin' AND deleted_at IS NULL AND id <> ${userId}::uuid`);
    if ((others.rows[0]?.n ?? 0) === 0) return { status: 'last_admin' };
  }

  if (changed.length > 0) {
    await tx.execute(sql`
      UPDATE users
         SET role = ${changed.includes('role') ? update.role! : before.role},
             plan = ${changed.includes('plan') ? update.plan! : before.plan},
             invites_left = ${changed.includes('invitesLeft') ? update.invitesLeft! : before.invitesLeft}::int
       WHERE id = ${userId}::uuid`);
  }

  let sessionsRevoked = 0;
  if (changed.includes('role') && update.role === 'user') {
    const revoked = await tx.execute(sql`
      UPDATE sessions SET revoked_at = now()
       WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`);
    sessionsRevoked = revoked.rowCount ?? 0;
  }
  if (changed.includes('plan')) {
    // The API cannot read another tenant's subscriptions under RLS; every subscribed feed is
    // recomputed instead, a superset that includes all of this user's feeds.
    await tx.execute(sql`
      SELECT refresh_feed_subscribers(
        ARRAY(SELECT id FROM feeds WHERE subscriber_count > 0 ORDER BY id),
        ${JSON.stringify(planMinIntervalMap())}::jsonb)`);
  }
  const user = (await getAdminUser(tx, userId))!;
  return { status: 'updated', before, user, changed, sessionsRevoked };
}

export interface AdminInviteRow {
  code: string;
  email: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedBy: string | null;
  usedAt: Date | null;
  status: 'unused' | 'used' | 'expired';
  /** `created_at` with microseconds: the exact keyset value for the next page. */
  createdKey: string;
}

/** All invites, newest first, after the keyset `(createdAt, code)` (spec 08 §9). */
export async function listAdminInvites(
  db: Executor,
  input: {
    status?: 'unused' | 'used' | 'expired';
    after?: { createdAt: string; code: string };
    limit: number;
  },
): Promise<AdminInviteRow[]> {
  const STATUS = sql`CASE WHEN i.used_at IS NOT NULL THEN 'used'
                          WHEN i.expires_at <= now() THEN 'expired' ELSE 'unused' END`;
  const filters: SQL[] = [sql`true`];
  if (input.status !== undefined) filters.push(sql`${STATUS} = ${input.status}`);
  if (input.after !== undefined) {
    filters.push(
      sql`(i.created_at, i.code) < (${input.after.createdAt}::timestamptz, ${input.after.code})`,
    );
  }
  const result = await db.execute<{
    code: string;
    email: string | null;
    note: string | null;
    created_by: string | null;
    created_at: RawTimestamp;
    expires_at: RawTimestamp;
    used_by: string | null;
    used_at: RawTimestamp | null;
    status: AdminInviteRow['status'];
    created_key: string;
  }>(sql`
    SELECT i.code, i.email::text AS email, i.note, i.created_by::text AS created_by, i.created_at,
           i.expires_at, i.used_by::text AS used_by, i.used_at, ${STATUS} AS status,
           to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
      FROM invites i WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY i.created_at DESC, i.code DESC LIMIT ${input.limit}::int`);
  return result.rows.map((row) => ({
    code: row.code,
    email: row.email,
    note: row.note,
    createdBy: row.created_by,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    usedBy: row.used_by,
    usedAt: toDateOrNull(row.used_at),
    status: row.status,
    createdKey: row.created_key,
  }));
}

export interface AdminWaitlistRow {
  id: string;
  email: string;
  locale: 'en' | 'sk';
  note: string | null;
  createdAt: Date;
  invitedAt: Date | null;
  inviteCode: string | null;
}

/** The waitlist, newest first, after the keyset id. */
export async function listAdminWaitlist(
  db: Executor,
  input: { beforeId?: string; limit: number },
): Promise<AdminWaitlistRow[]> {
  const result = await db.execute<{
    id: string;
    email: string;
    locale: 'en' | 'sk';
    note: string | null;
    created_at: RawTimestamp;
    invited_at: RawTimestamp | null;
    invite_code: string | null;
  }>(sql`
    SELECT w.id::text AS id, w.email::text AS email, w.locale, w.note, w.created_at, w.invited_at,
           w.invite_code
      FROM waitlist w
     WHERE ${input.beforeId === undefined ? sql`true` : sql`w.id < ${bigintParam(input.beforeId)}`}
     ORDER BY w.id DESC LIMIT ${input.limit}::int`);
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    locale: row.locale,
    note: row.note,
    createdAt: toDate(row.created_at),
    invitedAt: toDateOrNull(row.invited_at),
    inviteCode: row.invite_code,
  }));
}

/** The email of a waitlist entry, unlocked, so the caller can take the auth-email lock first. */
export async function waitlistEntryEmail(tx: Executor, id: string): Promise<string | null> {
  const result = await tx.execute<{ email: string }>(sql`
    SELECT email::text AS email FROM waitlist WHERE id = ${bigintParam(id)}`);
  return result.rows[0]?.email ?? null;
}

/**
 * Lock a waitlist entry for `POST /admin/waitlist/:id/invite` (spec 08 §9), or `null` when it does
 * not exist. The lock serializes two admins inviting the same entry.
 */
export async function lockWaitlistEntry(
  tx: Executor,
  id: string,
): Promise<{ email: string; locale: 'en' | 'sk' } | null> {
  const result = await tx.execute<{ email: string; locale: 'en' | 'sk' }>(sql`
    SELECT w.email::text AS email, w.locale FROM waitlist w
     WHERE w.id = ${bigintParam(id)} FOR UPDATE`);
  return result.rows[0] ?? null;
}

/** Record the invite sent to a waitlist entry (`invited_at`, `invite_code`; spec 02 §3). */
export async function markWaitlistInvited(
  tx: Executor,
  input: { id: string; code: string },
): Promise<AdminWaitlistRow> {
  const result = await tx.execute<{
    id: string;
    email: string;
    locale: 'en' | 'sk';
    note: string | null;
    created_at: RawTimestamp;
    invited_at: RawTimestamp | null;
    invite_code: string | null;
  }>(sql`
    UPDATE waitlist SET invited_at = now(), invite_code = ${input.code}
     WHERE id = ${bigintParam(input.id)}
    RETURNING id::text AS id, email::text AS email, locale, note, created_at, invited_at,
              invite_code`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('waitlist entry vanished under its lock');
  return {
    id: row.id,
    email: row.email,
    locale: row.locale,
    note: row.note,
    createdAt: toDate(row.created_at),
    invitedAt: toDateOrNull(row.invited_at),
    inviteCode: row.invite_code,
  };
}

// ── Publication requests, candidates and promotion (spec 08 §9.2, spec 05 §8.1) ─────────────────

/** The original creator must have been inactive at least this long (720 h, spec 02 §3.6). */
export const CREATOR_INACTIVITY_MS = 30 * 24 * 3600 * 1000;
/** Promotion candidates need at least three current holders (spec 05 §8.1). */
export const MIN_PROMOTION_HOLDERS = 3;

export interface AdminPublicationRequestRow {
  id: string;
  cardId: string;
  cardTitle: string;
  cardTextHash: string;
  currentCardTextHash: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'promoted';
  version: string;
  requestedAt: Date;
  expiresAt: Date | null;
  respondedAt: Date | null;
  payload: Record<string, unknown>;
  publicationSha: string;
  creatorKnown: boolean;
  /** `last_active_at`, else the same creator's `created_at` (spec 08 §9.2). */
  creatorActivityAt: Date | null;
  holders: number;
  vetoed: boolean;
  authorizationKind: 'creator_approval' | 'creator_inactive_30d' | null;
  promotedAt: Date | null;
}

type RequestRow = {
  id: string;
  card_id: string;
  card_title: string;
  card_text_hash: string;
  current_text_hash: string | null;
  status: AdminPublicationRequestRow['status'];
  version: string;
  requested_at: RawTimestamp;
  expires_at: RawTimestamp | null;
  responded_at: RawTimestamp | null;
  publication_payload: unknown;
  publication_sha: string;
  creator_known: boolean;
  creator_activity_at: RawTimestamp | null;
  holders: number;
  vetoed: boolean;
  authorization_kind: AdminPublicationRequestRow['authorizationKind'];
  promoted_at: RawTimestamp | null;
};

/**
 * Publication requests through `admin_list_card_publication_requests` (the API cannot read the
 * table across tenants). The creator's `created_at` fallback is read from the card's recorded
 * creator, never from another holder.
 */
export async function listAdminPublicationRequests(
  tx: TenantTx,
  filter: { requestId?: string; cardIds?: readonly string[]; open?: boolean } = {},
): Promise<AdminPublicationRequestRow[]> {
  const filters: SQL[] = [sql`true`];
  if (filter.requestId !== undefined) filters.push(sql`r.id = ${bigintParam(filter.requestId)}`);
  if (filter.cardIds !== undefined) {
    filters.push(sql`r.card_id = ANY(${sql.param([...filter.cardIds])}::bigint[])`);
  }
  if (filter.open === true) filters.push(sql`r.status IN ('pending','approved')`);
  const result = await tx.execute<RequestRow>(sql`
    SELECT r.id::text AS id, r.card_id::text AS card_id, r.card_title, r.card_text_hash,
           c.text_hash AS current_text_hash, r.status, r.version::text AS version, r.requested_at,
           r.expires_at, r.responded_at, r.publication_payload, r.publication_sha, r.creator_known,
           coalesce(r.creator_last_active_at,
                    CASE WHEN r.creator_known THEN cu.created_at END) AS creator_activity_at,
           r.holders, r.vetoed, r.authorization_kind, r.promoted_at
      FROM admin_list_card_publication_requests(NULL) r
      LEFT JOIN interest_cards c ON c.id = r.card_id
      LEFT JOIN users cu ON cu.id = c.creator_user_id AND cu.deleted_at IS NULL
     WHERE ${sql.join(filters, sql` AND `)}
     ORDER BY r.requested_at DESC, r.id DESC`);
  return result.rows.map((row) => ({
    id: row.id,
    cardId: row.card_id,
    cardTitle: row.card_title,
    cardTextHash: row.card_text_hash,
    currentCardTextHash: row.current_text_hash,
    status: row.status,
    version: row.version,
    requestedAt: toDate(row.requested_at),
    expiresAt: toDateOrNull(row.expires_at),
    respondedAt: toDateOrNull(row.responded_at),
    payload:
      row.publication_payload !== null && typeof row.publication_payload === 'object'
        ? (row.publication_payload as Record<string, unknown>)
        : {},
    publicationSha: row.publication_sha,
    creatorKnown: row.creator_known,
    creatorActivityAt: toDateOrNull(row.creator_activity_at),
    holders: row.holders,
    vetoed: row.vetoed,
    authorizationKind: row.authorization_kind,
    promotedAt: toDateOrNull(row.promoted_at),
  }));
}

export type EligibilityReason =
  | 'no_request'
  | 'insufficient_holders'
  | 'unknown_creator'
  | 'declined'
  | 'awaiting_approval'
  | 'expired'
  | 'stale_payload';

export interface Eligibility {
  status: 'eligible' | 'held' | 'promoted';
  basis: 'creator_approval' | 'creator_inactive_30d' | null;
  reason: EligibilityReason | null;
}

const held = (reason: EligibilityReason): Eligibility => ({ status: 'held', basis: null, reason });

/**
 * Advisory eligibility of a request (spec 08 §9.2), mirroring `admin_promote_card`'s order of
 * checks: provenance, staleness, veto, holders, then exact approval or 30-day inactivity. The
 * promotion transaction rechecks everything under its locks.
 */
export function promotionEligibility(request: AdminPublicationRequestRow, now: Date): Eligibility {
  if (request.status === 'promoted') {
    return { status: 'promoted', basis: request.authorizationKind, reason: null };
  }
  if (!request.creatorKnown) return held('unknown_creator');
  if (request.status === 'rejected') return held('declined');
  if (
    request.status === 'expired' ||
    (request.expiresAt !== null && request.expiresAt.getTime() <= now.getTime())
  ) {
    return held('expired');
  }
  if (request.currentCardTextHash !== request.cardTextHash) return held('stale_payload');
  if (request.vetoed) return held('declined');
  if (request.holders < MIN_PROMOTION_HOLDERS) return held('insufficient_holders');
  if (request.status === 'approved' && request.respondedAt !== null) {
    return { status: 'eligible', basis: 'creator_approval', reason: null };
  }
  const anchor = request.creatorActivityAt;
  if (anchor === null) return held('unknown_creator');
  if (now.getTime() - anchor.getTime() >= CREATOR_INACTIVITY_MS) {
    return { status: 'eligible', basis: 'creator_inactive_30d', reason: null };
  }
  return held('awaiting_approval');
}

export interface PromotionCandidateRow {
  cardId: string;
  title: string;
  interest: string;
  notFor: string | null;
  lang: string;
  topicIds: string[];
  holders: number;
  createdAt: Date;
  creatorKnown: boolean;
  vetoed: boolean;
}

/**
 * Promotion candidates (spec 08 §9 `GET /admin/library/candidates`): non-retired `shared`
 * interest cards with at least `minHolders` holders from `admin_card_holders`, by holders
 * descending, at most `limit`. Only card ids the administrator can read under RLS reach the
 * function, so no private fork is ever counted or listed (I1).
 */
export async function listPromotionCandidates(
  tx: TenantTx,
  input: { minHolders: number; limit: number },
): Promise<PromotionCandidateRow[]> {
  const result = await tx.execute<{
    card_id: string;
    title: string;
    body: unknown;
    lang: string;
    topic_ids: string[];
    holders: number;
    created_at: RawTimestamp;
    creator_known: boolean;
    vetoed: boolean;
  }>(sql`
    WITH shared AS (
      SELECT c.id FROM interest_cards c
       WHERE c.visibility = 'shared' AND c.kind = 'interest' AND c.retired_at IS NULL)
    SELECT c.id::text AS card_id, c.title, c.body, c.lang, c.topic_ids, h.holders, c.created_at,
           (cu.id IS NOT NULL) AS creator_known, c.publication_veto_at IS NOT NULL AS vetoed
      FROM admin_card_holders(ARRAY(SELECT id FROM shared)) h
      JOIN interest_cards c ON c.id = h.card_id
      LEFT JOIN users cu ON cu.id = c.creator_user_id AND cu.deleted_at IS NULL
     WHERE h.holders >= ${input.minHolders}::int
     ORDER BY h.holders DESC, c.id
     LIMIT ${input.limit}::int`);
  return result.rows.map((row) => {
    const body = (row.body ?? {}) as Record<string, unknown>;
    return {
      cardId: row.card_id,
      title: row.title,
      interest: typeof body['interest'] === 'string' ? body['interest'] : '',
      notFor: typeof body['not_for'] === 'string' ? body['not_for'] : null,
      lang: row.lang,
      topicIds: row.topic_ids,
      holders: row.holders,
      createdAt: toDate(row.created_at),
      creatorKnown: row.creator_known,
      vetoed: row.vetoed,
    };
  });
}

/** Current holders of readable cards (`admin_card_holders`); unreadable ids yield nothing. */
export async function cardHolders(
  tx: TenantTx,
  cardIds: readonly string[],
): Promise<Map<string, number>> {
  if (cardIds.length === 0) return new Map();
  const result = await tx.execute<{ card_id: string; holders: number }>(sql`
    SELECT h.card_id::text AS card_id, h.holders
      FROM admin_card_holders(ARRAY(
             SELECT c.id FROM interest_cards c
              WHERE c.id = ANY(${sql.param([...cardIds])}::bigint[]))) h`);
  return new Map(result.rows.map((row) => [row.card_id, row.holders]));
}

/**
 * Create a versioned exact-payload publication request addressed to the card's original creator
 * (`admin_request_card_publication`). The function checks the card is a shared user card with a
 * known, non-deleted creator; it does not check holders, so this repository requires a shared
 * interest card with at least three current holders first (PLAN §7 M2 handoff), after locking the
 * card row.
 */
export async function createPublicationRequest(
  tx: TenantTx,
  input: { cardId: string; payload: Record<string, unknown> },
): Promise<string> {
  const card = await tx.execute<{ visibility: string; kind: string; retired: boolean }>(sql`
    SELECT visibility, kind, retired_at IS NOT NULL AS retired FROM interest_cards
     WHERE id = ${bigintParam(input.cardId)} AND visibility <> 'private'`);
  const row = card.rows[0];
  if (row === undefined) throw new AppError('NOT_FOUND', 'Card not found');
  if (row.visibility !== 'shared' || row.kind !== 'interest' || row.retired) {
    throw new AppError('CONFLICT', 'Only a shared interest card can be proposed', {
      details: { reason: 'not_shared' },
    });
  }
  const topicIds = input.payload['topic_ids'];
  if (Array.isArray(topicIds)) {
    await assertKnownTopics(
      tx,
      topicIds.filter((id): id is string => typeof id === 'string'),
    );
  }
  const holders = (await cardHolders(tx, [input.cardId])).get(input.cardId) ?? 0;
  if (holders < MIN_PROMOTION_HOLDERS) {
    throw new AppError('CONFLICT', 'The card has fewer than three holders', {
      details: { reason: 'insufficient_holders', holders, min: MIN_PROMOTION_HOLDERS },
    });
  }
  const result = await tx.execute<{ request_id: string }>(sql`
    SELECT request_id::text AS request_id
      FROM admin_request_card_publication(${bigintParam(input.cardId)},
                                          ${JSON.stringify(input.payload)}::jsonb, NULL)`);
  return result.rows[0]!.request_id;
}

/**
 * Promote an eligible request (`admin_promote_card`), then record the promoted card as version 1
 * of its library slug (`admin_publish_library_card_version`), in the caller's transaction. Returns
 * the card id and the authorization basis the function recorded.
 */
export async function promotePublicationRequest(
  tx: TenantTx,
  input: { requestId: string; expectedVersion: string },
): Promise<{ cardId: string; authorizationKind: 'creator_approval' | 'creator_inactive_30d' }> {
  const result = await tx.execute<{
    card_id: string;
    authorization_kind: 'creator_approval' | 'creator_inactive_30d';
  }>(sql`
    SELECT card_id::text AS card_id, authorization_kind
      FROM admin_promote_card(${bigintParam(input.requestId)}, ${bigintParam(input.expectedVersion)})`);
  const row = result.rows[0]!;
  const slug = await tx.execute<{ slug: string | null }>(
    sql`SELECT slug FROM interest_cards WHERE id = ${bigintParam(row.card_id)}`,
  );
  const cardSlug = slug.rows[0]?.slug ?? null;
  if (cardSlug !== null) {
    await tx.execute(sql`
      SELECT admin_publish_library_card_version(${cardSlug}, ${bigintParam(row.card_id)}, NULL)`);
  }
  return { cardId: row.card_id, authorizationKind: row.authorization_kind };
}

// ── Library management (spec 08 §9, spec 05 §8) ──────────────────────────────────────────────────

export interface AdminLibraryCardRow {
  cardId: string;
  /** The slug alias: only the newest version of a slug holds it. */
  slug: string | null;
  version: number | null;
  /** The newest version of the card's slug, null for a card that is no library version. */
  latestVersion: number | null;
  title: string;
  interest: string;
  notFor: string | null;
  examplesYes: string[];
  examplesNo: string[];
  topicIds: string[];
  i18n: Record<string, unknown>;
  holders: number;
  retiredAt: Date | null;
  createdAt: Date;
  /** The card's latest promoted publication request; null for a library-origin card. */
  publication: {
    requestId: string;
    authorizationKind: 'creator_approval' | 'creator_inactive_30d';
    promotedAt: Date;
  } | null;
}

type LibraryRow = {
  card_id: string;
  slug: string | null;
  version: number | null;
  latest_version: number | null;
  title: string;
  body: unknown;
  topic_ids: string[];
  i18n: unknown;
  holders: number | null;
  retired_at: RawTimestamp | null;
  created_at: RawTimestamp;
  publication_request_id: string | null;
  publication_kind: 'creator_approval' | 'creator_inactive_30d' | null;
  publication_promoted_at: RawTimestamp | null;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function toLibraryCard(row: LibraryRow): AdminLibraryCardRow {
  const body = (row.body ?? {}) as Record<string, unknown>;
  return {
    cardId: row.card_id,
    slug: row.slug,
    version: row.version,
    latestVersion: row.latest_version,
    title: row.title,
    interest: typeof body['interest'] === 'string' ? body['interest'] : '',
    notFor: typeof body['not_for'] === 'string' ? body['not_for'] : null,
    examplesYes: strings(body['examples_yes']),
    examplesNo: strings(body['examples_no']),
    topicIds: row.topic_ids,
    i18n:
      row.i18n !== null && typeof row.i18n === 'object' && !Array.isArray(row.i18n)
        ? (row.i18n as Record<string, unknown>)
        : {},
    holders: row.holders ?? 0,
    retiredAt: toDateOrNull(row.retired_at),
    createdAt: toDate(row.created_at),
    publication:
      row.publication_request_id === null ||
      row.publication_kind === null ||
      row.publication_promoted_at === null
        ? null
        : {
            requestId: row.publication_request_id,
            authorizationKind: row.publication_kind,
            promotedAt: toDate(row.publication_promoted_at),
          },
  };
}

const LIBRARY_SELECT = (where: SQL, tail: SQL) => sql`
  WITH cards AS (
    SELECT c.* FROM interest_cards c
     WHERE c.visibility = 'public' AND c.kind = 'interest' AND ${where}
     ${tail}),
  promotions AS MATERIALIZED (
    SELECT DISTINCT ON (r.card_id) r.card_id, r.id, r.authorization_kind, r.promoted_at
      FROM admin_list_card_publication_requests('promoted') r
     ORDER BY r.card_id, r.promoted_at DESC, r.id DESC)
  SELECT c.id::text AS card_id, c.slug, v.version,
         (SELECT max(l.version) FROM library_card_versions l
           WHERE l.library_slug = v.library_slug) AS latest_version,
         c.title, c.body, c.topic_ids, c.i18n,
         h.holders, c.retired_at, c.created_at, p.id::text AS publication_request_id,
         p.authorization_kind AS publication_kind, p.promoted_at AS publication_promoted_at
    FROM cards c
    LEFT JOIN library_card_versions v ON v.card_id = c.id
    LEFT JOIN admin_card_holders(ARRAY(SELECT id FROM cards)) h ON h.card_id = c.id
    LEFT JOIN promotions p ON p.card_id = c.id
   ORDER BY c.id`;

/** Public library cards (every version), ordered by id after `afterId`, searchable by title/slug. */
export async function listAdminLibrary(
  tx: TenantTx,
  input: { q?: string; afterId?: string; limit: number },
): Promise<AdminLibraryCardRow[]> {
  const filters: SQL[] = [sql`true`];
  if (input.q !== undefined) {
    const pattern = likePattern(input.q);
    filters.push(
      sql`(c.title ILIKE ${pattern} ESCAPE '\\' OR c.slug ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (input.afterId !== undefined) filters.push(sql`c.id > ${bigintParam(input.afterId)}`);
  const result = await tx.execute<LibraryRow>(
    LIBRARY_SELECT(sql.join(filters, sql` AND `), sql`ORDER BY c.id LIMIT ${input.limit}::int`),
  );
  return result.rows.map(toLibraryCard);
}

export async function getAdminLibraryCard(
  tx: TenantTx,
  cardId: string,
): Promise<AdminLibraryCardRow | null> {
  const result = await tx.execute<LibraryRow>(
    LIBRARY_SELECT(sql`c.id = ${bigintParam(cardId)}`, sql``),
  );
  const row = result.rows[0];
  return row === undefined ? null : toLibraryCard(row);
}

export interface LibraryCardText {
  title: string;
  interest: string;
  notFor: string | null;
  examplesYes: readonly string[];
  examplesNo: readonly string[];
  topicIds: readonly string[];
  i18n: Record<string, unknown>;
}

/**
 * Insert a new immutable public library card (no slug yet). A text hash that already exists (a
 * shared user card, another library card or version) is a conflict: user material is published
 * only through the consent flow, never relabelled as library content (spec 05 §8.1).
 */
async function insertLibraryCard(tx: TenantTx, text: LibraryCardText): Promise<string> {
  const textHash = librarySeedTextHash({
    slug: 'unused',
    title: text.title,
    interest: text.interest,
    notFor: text.notFor,
    examplesYes: text.examplesYes,
    examplesNo: text.examplesNo,
    topicIds: text.topicIds,
    i18n: text.i18n,
  });
  const body = {
    interest: text.interest,
    ...(text.notFor === null ? {} : { not_for: text.notFor }),
    ...(text.examplesYes.length === 0 ? {} : { examples_yes: text.examplesYes }),
    ...(text.examplesNo.length === 0 ? {} : { examples_no: text.examplesNo }),
  };
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO interest_cards (kind, title, body, text_hash, lang, topic_ids, origin, visibility, i18n)
    VALUES ('interest', ${text.title}, ${JSON.stringify(body)}::jsonb, ${textHash}, 'en',
            ${sql.param([...text.topicIds])}::text[], 'library', 'public', ${JSON.stringify(text.i18n)}::jsonb)
    ON CONFLICT (text_hash) DO NOTHING
    RETURNING id::text AS id`);
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new AppError('CONFLICT', 'A card with this text already exists', {
      details: { reason: 'text_exists' },
    });
  }
  return id;
}

async function latestLibraryVersion(tx: TenantTx, slug: string): Promise<number | null> {
  const result = await tx.execute<{ version: number | null }>(
    sql`SELECT max(version) AS version FROM library_card_versions WHERE library_slug = ${slug}`,
  );
  return result.rows[0]?.version ?? null;
}

/**
 * `POST /admin/library`: a new library slug whose version 1 is a new public card
 * (`admin_publish_library_card_version`, which locks `library:<slug>` and refuses an existing
 * chain as stale).
 */
/** Every topic id must exist (the card content trigger would refuse it as a conflict). */
export async function assertKnownTopics(tx: TenantTx, topicIds: readonly string[]): Promise<void> {
  if (topicIds.length === 0) return;
  const known = await tx.execute<{ id: string }>(
    sql`SELECT id FROM topics WHERE id = ANY(${sql.param([...topicIds])}::text[])`,
  );
  const found = new Set(known.rows.map((row) => row.id));
  const unknown = [...new Set(topicIds)].filter((id) => !found.has(id));
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Unknown topic', {
      details: { field: 'topicIds', unknown },
    });
  }
}

export async function createLibraryCard(
  tx: TenantTx,
  input: LibraryCardText & { slug: string },
): Promise<string> {
  await assertKnownTopics(tx, input.topicIds);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`library:${input.slug}`}))`);
  const taken = await tx.execute(sql`SELECT 1 FROM interest_cards WHERE slug = ${input.slug}`);
  if ((taken.rowCount ?? 0) > 0 || (await latestLibraryVersion(tx, input.slug)) !== null) {
    throw new AppError('CONFLICT', 'The library slug exists', {
      details: { reason: 'slug_taken' },
    });
  }
  const cardId = await insertLibraryCard(tx, input);
  await tx.execute(
    sql`SELECT admin_publish_library_card_version(${input.slug}, ${bigintParam(cardId)}, NULL)`,
  );
  return cardId;
}

export interface LibraryCardPatch {
  title?: string;
  topicIds?: readonly string[];
  i18n?: Record<string, unknown>;
  retired?: boolean;
  interest?: string;
  notFor?: string | null;
  examplesYes?: readonly string[];
  examplesNo?: readonly string[];
}

/**
 * `PATCH /admin/library/:id` (spec 05 §8, spec 02 §3.6). Display metadata changes in place on the
 * current card. A semantic change (interest, not_for, examples) never rewrites the card: a new
 * immutable public card becomes the next version of the slug and takes the alias, while every
 * existing holding keeps the old card (holders receive an opt-in update offer instead). Only the
 * newest version of a slug may be edited semantically. Returns the resulting card id.
 */
export async function patchLibraryCard(
  tx: TenantTx,
  cardId: string,
  patch: LibraryCardPatch,
): Promise<{ cardId: string; versioned: boolean } | null> {
  const found = await getAdminLibraryCard(tx, cardId);
  if (found === null) return null;
  if (patch.topicIds !== undefined) await assertKnownTopics(tx, patch.topicIds);
  if (found.slug !== null) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`library:${found.slug}`}))`);
  }
  await tx.execute(sql`SELECT id FROM interest_cards WHERE id = ${bigintParam(cardId)} FOR UPDATE`);
  // Read the state again under the locks: a concurrent patch may have committed since (its fields
  // are carried into this one, never overwritten with the stale snapshot).
  const current = await getAdminLibraryCard(tx, cardId);
  if (current === null) return null;

  const semantic =
    (patch.interest !== undefined && patch.interest !== current.interest) ||
    (patch.notFor !== undefined && patch.notFor !== current.notFor) ||
    (patch.examplesYes !== undefined && !sameList(patch.examplesYes, current.examplesYes)) ||
    (patch.examplesNo !== undefined && !sameList(patch.examplesNo, current.examplesNo));

  const title = patch.title ?? current.title;
  const topicIds = patch.topicIds ?? current.topicIds;
  const i18n = patch.i18n ?? current.i18n;

  if (!semantic) {
    const retiredSql =
      patch.retired === undefined
        ? sql`retired_at`
        : patch.retired
          ? sql`coalesce(retired_at, now())`
          : sql`NULL`;
    await tx.execute(sql`
      UPDATE interest_cards
         SET title = ${title}, topic_ids = ${sql.param([...topicIds])}::text[],
             i18n = ${JSON.stringify(i18n)}::jsonb, retired_at = ${retiredSql}
       WHERE id = ${bigintParam(cardId)}`);
    return { cardId, versioned: false };
  }

  if (current.slug === null || current.version === null) {
    throw new AppError('CONFLICT', 'Only the newest version of a library slug can change', {
      details: { reason: 'not_latest_version' },
    });
  }
  const latest = await latestLibraryVersion(tx, current.slug);
  if (latest !== current.version) {
    throw new AppError('CONFLICT', 'Only the newest version of a library slug can change', {
      details: { reason: 'not_latest_version' },
    });
  }
  const nextId = await insertLibraryCard(tx, {
    title,
    interest: patch.interest ?? current.interest,
    notFor: patch.notFor === undefined ? current.notFor : patch.notFor,
    examplesYes: patch.examplesYes ?? current.examplesYes,
    examplesNo: patch.examplesNo ?? current.examplesNo,
    topicIds,
    i18n,
  });
  await tx.execute(sql`
    SELECT admin_publish_library_card_version(${current.slug}, ${bigintParam(nextId)}, ${latest}::int)`);
  return { cardId: nextId, versioned: true };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
