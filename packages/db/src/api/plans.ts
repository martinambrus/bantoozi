import {
  AppError,
  type AdminPlanCreate,
  type AdminPlanPatch,
  type PlanLimits,
} from '@bantoozi/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { toDateOrNull, type RawTimestamp } from '../timestamps.js';

/**
 * Stored plans (D-255, spec 08 §6). The quota checks, the signup default and the fetch interval
 * floor read the `plans` table in the transaction that needs them, so an Admin → Plans edit applies
 * from the next request without a restart. `plans` is a control-plane table (no tenant RLS); the
 * writes below are called from the admin routes only.
 */

type PlanRow = {
  key: string;
  label: string;
  label_sk: string | null;
  max_feeds: number;
  max_cards: number;
  max_labels: number;
  max_forks: number;
  max_rules: number;
  opml_max_feeds: number;
  min_fetch_interval_s: number;
  release_interval_s: number | null;
  backfill_days: number;
  invites_on_signup: number;
  sort_order: number;
  is_default: boolean;
  retired_at: RawTimestamp | null;
  version: number;
  user_count?: number;
};

const toLimits = (row: PlanRow): Readonly<PlanLimits> => ({
  maxFeeds: row.max_feeds,
  maxCards: row.max_cards,
  maxLabels: row.max_labels,
  maxForks: row.max_forks,
  maxRules: row.max_rules,
  opmlMaxFeeds: row.opml_max_feeds,
  minFetchIntervalS: row.min_fetch_interval_s,
  backfillDays: row.backfill_days,
  invitesOnSignup: row.invites_on_signup,
});

const LIMIT_COLUMNS = sql`max_feeds, max_cards, max_labels, max_forks, max_rules, opml_max_feeds,
  min_fetch_interval_s, backfill_days, invites_on_signup`;

/** The limits of a stored plan. `users.plan` references `plans`, so a user's plan always exists. */
export async function loadPlanLimits(db: Executor, plan: string): Promise<Readonly<PlanLimits>> {
  const result = await db.execute<PlanRow>(
    sql`SELECT ${LIMIT_COLUMNS} FROM plans WHERE key = ${plan}`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`plan ${plan} is not stored`);
  return toLimits(row);
}

/** The plan a new user starts on (`plans.is_default`, exactly one row). */
export async function loadDefaultPlan(
  db: Executor,
): Promise<{ key: string; limits: Readonly<PlanLimits> }> {
  const result = await db.execute<PlanRow>(
    sql`SELECT key, ${LIMIT_COLUMNS} FROM plans WHERE is_default`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('no default plan is stored');
  return { key: row.key, limits: toLimits(row) };
}

export interface AdminPlanRow extends PlanLimits {
  key: string;
  label: string;
  labelSk: string | null;
  releaseIntervalS: number | null;
  sortOrder: number;
  isDefault: boolean;
  retiredAt: Date | null;
  version: number;
  /** Accounts on the plan, deleted ones included (they still hold the reference). */
  userCount: number;
}

const toAdminPlan = (row: PlanRow): AdminPlanRow => ({
  ...toLimits(row),
  key: row.key,
  label: row.label,
  labelSk: row.label_sk,
  releaseIntervalS: row.release_interval_s,
  sortOrder: row.sort_order,
  isDefault: row.is_default,
  retiredAt: toDateOrNull(row.retired_at),
  version: Number(row.version),
  userCount: row.user_count ?? 0,
});

const ADMIN_COLUMNS = sql`p.key, p.label, p.label_sk, p.max_feeds, p.max_cards, p.max_labels, p.max_forks,
  p.max_rules, p.opml_max_feeds, p.min_fetch_interval_s, p.release_interval_s, p.backfill_days,
  p.invites_on_signup, p.sort_order, p.is_default, p.retired_at, p.version,
  (SELECT count(*)::int FROM users u WHERE u.plan = p.key) AS user_count`;

async function readAdminPlan(db: Executor, key: string): Promise<AdminPlanRow | null> {
  const result = await db.execute<PlanRow>(
    sql`SELECT ${ADMIN_COLUMNS} FROM plans p WHERE p.key = ${key}`,
  );
  const row = result.rows[0];
  return row === undefined ? null : toAdminPlan(row);
}

/** All plans, retired ones included, by `sort_order` then key. */
export async function listAdminPlans(db: Executor): Promise<AdminPlanRow[]> {
  const result = await db.execute<PlanRow>(
    sql`SELECT ${ADMIN_COLUMNS} FROM plans p ORDER BY p.sort_order, p.key`,
  );
  return result.rows.map(toAdminPlan);
}

/** `null` when the key is taken. A new plan starts active, not default, at version 1. */
export async function createAdminPlan(
  db: Executor,
  input: AdminPlanCreate,
): Promise<AdminPlanRow | null> {
  const inserted = await db.execute(sql`
    INSERT INTO plans (key, label, label_sk, max_feeds, max_cards, max_labels, max_forks, max_rules,
                       opml_max_feeds, min_fetch_interval_s, release_interval_s, backfill_days,
                       invites_on_signup, sort_order)
    VALUES (${input.key}, ${input.label}, ${input.labelSk ?? null}, ${input.maxFeeds},
            ${input.maxCards}, ${input.maxLabels}, ${input.maxForks}, ${input.maxRules},
            ${input.opmlMaxFeeds}, ${input.minFetchIntervalS}, ${input.releaseIntervalS ?? null},
            ${input.backfillDays}, ${input.invitesOnSignup},
            ${input.sortOrder ?? sql`(SELECT coalesce(max(sort_order), 0) + 10 FROM plans)`})
    ON CONFLICT (key) DO NOTHING`);
  if (inserted.rowCount !== 1) return null;
  return (await readAdminPlan(db, input.key))!;
}

export type AdminPlanUpdateResult =
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'default_plan' }
  | { status: 'updated'; plan: AdminPlanRow; changed: string[] };

const SET_COLUMNS = {
  label: 'label',
  labelSk: 'label_sk',
  maxFeeds: 'max_feeds',
  maxCards: 'max_cards',
  maxLabels: 'max_labels',
  maxForks: 'max_forks',
  maxRules: 'max_rules',
  opmlMaxFeeds: 'opml_max_feeds',
  minFetchIntervalS: 'min_fetch_interval_s',
  releaseIntervalS: 'release_interval_s',
  backfillDays: 'backfill_days',
  invitesOnSignup: 'invites_on_signup',
  sortOrder: 'sort_order',
} as const satisfies Partial<Record<keyof AdminPlanPatch, string>>;

/**
 * Edit a plan under its row lock, compare `expectedVersion`, bump the version. A new fetch interval
 * recomputes only the feeds with a live subscriber on this plan and pulls their `next_fetch_at`
 * forward when their floor dropped (`refresh_plan_feeds`, never later). The default plan cannot be
 * retired.
 */
export async function updateAdminPlan(
  tx: Transaction,
  key: string,
  patch: AdminPlanPatch,
): Promise<AdminPlanUpdateResult> {
  const locked = await tx.execute<PlanRow>(
    sql`SELECT key, ${LIMIT_COLUMNS}, version, is_default, retired_at FROM plans WHERE key = ${key} FOR UPDATE`,
  );
  const current = locked.rows[0];
  if (current === undefined) return { status: 'not_found' };
  if (Number(current.version) !== patch.expectedVersion) return { status: 'stale' };
  if (patch.retired === true && current.is_default) return { status: 'default_plan' };

  const sets: SQL[] = [];
  const changed: string[] = [];
  for (const [field, column] of Object.entries(SET_COLUMNS)) {
    const value = patch[field as keyof typeof SET_COLUMNS];
    if (value === undefined) continue;
    sets.push(sql`${sql.identifier(column)} = ${value}`);
    changed.push(field);
  }
  if (patch.retired !== undefined) {
    sets.push(
      patch.retired ? sql`retired_at = coalesce(retired_at, now())` : sql`retired_at = NULL`,
    );
    changed.push('retired');
  }
  await tx.execute(sql`
    UPDATE plans SET ${sql.join(sets, sql`, `)}, version = version + 1, updated_at = now()
     WHERE key = ${key}`);
  if (
    patch.minFetchIntervalS !== undefined &&
    patch.minFetchIntervalS !== current.min_fetch_interval_s
  ) {
    await tx.execute(sql`SELECT refresh_plan_feeds(${key})`);
  }
  return { status: 'updated', plan: (await readAdminPlan(tx, key))!, changed };
}

export type AdminPlanDefaultResult =
  { status: 'not_found' } | { status: 'retired' } | { status: 'updated'; plan: AdminPlanRow };

/** Make a plan the only default for new users (an active plan only). */
export async function setDefaultAdminPlan(
  tx: Transaction,
  key: string,
): Promise<AdminPlanDefaultResult> {
  // Serializes concurrent default changes: the partial unique index allows one default at a time.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('plans.default'))`);
  const locked = await tx.execute<{ retired_at: RawTimestamp | null; is_default: boolean }>(
    sql`SELECT retired_at, is_default FROM plans WHERE key = ${key} FOR UPDATE`,
  );
  const target = locked.rows[0];
  if (target === undefined) return { status: 'not_found' };
  if (target.retired_at !== null) return { status: 'retired' };
  if (!target.is_default) {
    await tx.execute(sql`
      UPDATE plans SET is_default = false, version = version + 1, updated_at = now()
       WHERE is_default AND key <> ${key}`);
    await tx.execute(sql`
      UPDATE plans SET is_default = true, version = version + 1, updated_at = now()
       WHERE key = ${key}`);
  }
  return { status: 'updated', plan: (await readAdminPlan(tx, key))! };
}

export type AdminPlanDeleteResult =
  | { status: 'not_found' }
  | { status: 'default_plan' }
  | { status: 'in_use' }
  | { status: 'deleted' };

/** Delete an unused, non-default plan; a plan in use is retired instead. */
export async function deleteAdminPlan(
  tx: Transaction,
  key: string,
): Promise<AdminPlanDeleteResult> {
  const locked = await tx.execute<{ is_default: boolean }>(
    sql`SELECT is_default FROM plans WHERE key = ${key} FOR UPDATE`,
  );
  const target = locked.rows[0];
  if (target === undefined) return { status: 'not_found' };
  if (target.is_default) return { status: 'default_plan' };
  const used = await tx.execute(sql`SELECT 1 FROM users WHERE plan = ${key} LIMIT 1`);
  if ((used.rowCount ?? 0) > 0) return { status: 'in_use' };
  await tx.execute(sql`DELETE FROM plans WHERE key = ${key}`);
  return { status: 'deleted' };
}

/**
 * Check a plan choice for a user (`PATCH /admin/users/:id`): the plan must exist, and a retired plan
 * is accepted only when it is the user's current one. Takes a share lock so the plan cannot be
 * retired or deleted before the user's row is written.
 */
export async function checkUserPlanChoice(
  tx: Transaction,
  plan: string,
  currentPlan: string,
): Promise<void> {
  const result = await tx.execute<{ retired_at: RawTimestamp | null }>(
    sql`SELECT retired_at FROM plans WHERE key = ${plan} FOR SHARE`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AppError('VALIDATION_FAILED', 'Unknown plan', { details: { field: 'plan' } });
  }
  if (row.retired_at !== null && plan !== currentPlan) {
    throw new AppError('CONFLICT', 'The plan is retired', { details: { reason: 'plan_retired' } });
  }
}
