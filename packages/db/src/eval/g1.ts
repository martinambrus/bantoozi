import {
  canonicalJson,
  enqueueLearn,
  enqueueRank,
  enqueueReenrich,
  enqueueRematch,
  enqueueTranslateCards,
  parseSetting,
  settingDefault,
  type CardTextMode,
  type LanguageModes,
  type RankerThresholds,
  type SettingEnvDefaults,
  type SettingKey,
} from '@bantoozi/shared';
import { sql } from 'drizzle-orm';

import type { Executor, Transaction } from '../client.js';
import { workerOutbox } from '../outbox.js';
import { createRun, finishRun, listRuns, type RunRow } from './runs.js';

/**
 * Gate G1 persistence (spec 10 §1, §5; M3a-T7).
 *
 * **Selection lock.** `eval gate` freezes its development selection before it reveals any test
 * metric. The lock is an `eval.runs` row with experiment {@link GATE_LOCK_EXPERIMENT} (D-106): its
 * config (immutable by trigger) records the profile, the dataset/cohort manifest and the selection's
 * config hash; its results record the confirmed status. A later gate on the same manifest must use
 * the same profile and reach the same selection, so a profile switch or a retune after seeing test
 * results is refused.
 *
 * **apply-g1.** Writes exactly the settings of the spec 10 §1 mapping table in one transaction,
 * bumps `ranker.settings_version` only when `ranker.thresholds` changed, and records the side-effect
 * intents of the normal settings flow (spec 08 `PATCH /admin/settings`) in the transactional outbox.
 */

export const GATE_LOCK_EXPERIMENT = 'G1-gate';

export interface GateLockConfig {
  profile: 'owner_pilot' | 'multi_person_beta';
  datasetVersion: string;
  snapshotSha: string;
  splitSha: string;
  cohortSha: string;
  configSha: string;
  developmentRunIds: string[];
  dryRun: boolean;
}

/** Serialize gates of one dataset version for this transaction. */
export async function lockGateManifest(tx: Transaction, datasetVersion: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`eval.gate:${datasetVersion}`}))`);
}

/** The gate locks of a dataset version, oldest first. */
export async function findGateLocks(db: Executor, datasetVersion: string): Promise<RunRow[]> {
  return listRuns(db, { datasetVersion, experiment: GATE_LOCK_EXPERIMENT });
}

export async function createGateLock(
  tx: Executor,
  input: { config: GateLockConfig; gitSha: string },
): Promise<RunRow> {
  return createRun(tx, {
    experiment: GATE_LOCK_EXPERIMENT,
    datasetVersion: input.config.datasetVersion,
    config: { ...input.config },
    gitSha: input.gitSha,
  });
}

/** Record the confirmed outcome on the lock row (status, report hash, macro AUCs). */
export async function recordGateOutcome(
  db: Executor,
  lockId: string,
  results: { status: 'pass' | 'fail' | 'needs_more_data'; reportSha: string } & Record<
    string,
    unknown
  >,
): Promise<void> {
  await finishRun(db, lockId, results);
}

/** `current_database()`: the dry-run database is `bantoozi_eval_dryrun` (spec 10 §3). */
export async function currentDatabaseName(db: Executor): Promise<string> {
  const result = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`);
  return result.rows[0]?.name ?? '';
}

/** Live assignment status counts per rater (skip rates are reported beside the metrics). */
export async function assignmentStatusCounts(
  db: Executor,
  raterIds: readonly string[],
): Promise<Map<string, { pending: number; rated: number; skipped: number }>> {
  if (raterIds.length === 0) return new Map();
  const result = await db.execute<{ rater_id: string; status: string; n: number }>(sql`
    SELECT rater_id::text AS rater_id, status, count(*)::int AS n
      FROM eval.assignments WHERE rater_id = ANY(${sql.param([...raterIds])}::bigint[])
     GROUP BY rater_id, status ORDER BY rater_id`);
  const counts = new Map<string, { pending: number; rated: number; skipped: number }>();
  for (const row of result.rows) {
    const entry = counts.get(row.rater_id) ?? { pending: 0, rated: 0, skipped: 0 };
    if (row.status === 'pending' || row.status === 'rated' || row.status === 'skipped') {
      entry[row.status] += row.n;
    }
    counts.set(row.rater_id, entry);
  }
  return counts;
}

// ── apply-g1 ────────────────────────────────────────────────────────────────────────────────

/** The settings of the spec 10 §1 mapping table (plus the version bump). */
export const G1_SETTING_KEYS = [
  'language_modes',
  'card_text_mode',
  'ranker.thresholds',
  'ranker.settings_version',
  'engine.daily_budget_usd',
  'translate.tier2_daily_cap',
] as const satisfies readonly SettingKey[];
export type G1SettingKey = (typeof G1_SETTING_KEYS)[number];

export interface G1Settings {
  /** Merged over the stored modes: an unmeasured language keeps its current mode. */
  languageModes: LanguageModes;
  cardTextMode: CardTextMode;
  rankerThresholds: RankerThresholds;
  dailyBudgetUsd: number;
  tier2DailyCap: number;
}

export interface ApplyG1Result {
  changed: G1SettingKey[];
  settingsVersion: number;
  /** Outbox intents recorded, by queue. */
  intents: Record<string, number>;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

async function upsertSetting(tx: Executor, key: string, value: unknown): Promise<void> {
  await tx.execute(sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
}

/**
 * Apply G1's settings in the caller's transaction. Each value is validated by the settings
 * registry; a key is written only when its effective value changes (a missing row counts as its
 * default). Side effects follow the admin settings flow: `ranker.thresholds` bumps
 * `ranker.settings_version` and enqueues a full `user.rank` for users active in the last 7 days
 * (plus `user.learn` for users with an active model when `strengthWeights` or `model` changed); a
 * `card_text_mode` change enqueues `house.rematch` (and `house.translate-cards` for `english`); each
 * language whose mode changed enqueues `house.reenrich {lang}`.
 */
export async function applyG1Settings(
  tx: Transaction,
  input: G1Settings,
  options: { env: SettingEnvDefaults; now: Date },
): Promise<ApplyG1Result> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('eval.apply-g1'))`);
  const locked = await tx.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM settings
     WHERE key = ANY(${sql.param([...G1_SETTING_KEYS])}::text[]) ORDER BY key FOR UPDATE`);
  const stored = new Map(locked.rows.map((row) => [row.key, row.value]));
  const current = <K extends G1SettingKey>(key: K) =>
    stored.has(key) ? parseSetting(key, stored.get(key)) : settingDefault(key, options.env);

  const oldModes = current('language_modes') ?? {};
  const next = {
    language_modes: parseSetting('language_modes', { ...oldModes, ...input.languageModes }),
    card_text_mode: parseSetting('card_text_mode', input.cardTextMode),
    'ranker.thresholds': parseSetting('ranker.thresholds', input.rankerThresholds),
    'engine.daily_budget_usd': parseSetting('engine.daily_budget_usd', input.dailyBudgetUsd),
    'translate.tier2_daily_cap': parseSetting('translate.tier2_daily_cap', input.tier2DailyCap),
  };
  const changed: G1SettingKey[] = [];
  for (const [key, value] of Object.entries(next) as [
    Exclude<G1SettingKey, 'ranker.settings_version'>,
    unknown,
  ][]) {
    if (same(current(key), value)) continue;
    await upsertSetting(tx, key, value);
    changed.push(key);
  }
  let settingsVersion = current('ranker.settings_version') ?? 0;
  const outbox = workerOutbox(tx);
  const intents: Record<string, number> = {};
  const count = (queue: string) => {
    intents[queue] = (intents[queue] ?? 0) + 1;
  };

  if (changed.includes('ranker.thresholds')) {
    settingsVersion += 1;
    await upsertSetting(tx, 'ranker.settings_version', settingsVersion);
    changed.push('ranker.settings_version');
    const since = new Date(options.now.getTime() - 7 * 24 * 3_600_000).toISOString();
    const active = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM users
       WHERE deleted_at IS NULL AND last_active_at >= ${since}::timestamptz ORDER BY id`);
    for (const { id } of active.rows) {
      await enqueueRank(
        outbox,
        { userId: id, reason: 'apply-g1', full: true },
        { revision: String(settingsVersion) },
      );
      count('user.rank');
    }
    const before = current('ranker.thresholds') ?? {};
    const after = next['ranker.thresholds'];
    if (!same(before.strengthWeights, after.strengthWeights) || !same(before.model, after.model)) {
      const models = await tx.execute<{ user_id: string }>(sql`
        SELECT DISTINCT m.user_id::text AS user_id FROM user_models m
          JOIN users u ON u.id = m.user_id
         WHERE m.active AND u.deleted_at IS NULL ORDER BY 1`);
      for (const { user_id: userId } of models.rows) {
        await enqueueLearn(outbox, { userId });
        count('user.learn');
      }
    }
  }
  if (changed.includes('card_text_mode')) {
    await enqueueRematch(outbox, {});
    count('house.rematch');
    if (next.card_text_mode === 'english') {
      await enqueueTranslateCards(outbox, {});
      count('house.translate-cards');
    }
  }
  if (changed.includes('language_modes')) {
    const langs = new Set([...Object.keys(oldModes), ...Object.keys(next.language_modes)]);
    for (const lang of [...langs].sort()) {
      if (oldModes[lang] === next.language_modes[lang]) continue;
      await enqueueReenrich(outbox, { lang });
      count('house.reenrich');
    }
  }
  return { changed: G1_SETTING_KEYS.filter((k) => changed.includes(k)), settingsVersion, intents };
}
