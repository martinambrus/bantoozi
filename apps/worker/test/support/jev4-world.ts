import { createHash } from 'node:crypto';

import {
  FEATURE_SNAPSHOT_SPEC_SHA,
  effectiveRatingSettings,
  loadCardInputs,
  loadHeldCardIds,
  loadLearnConsent,
  readRatingFingerprint,
  type RatingDefaults,
} from '@bantoozi/db';
import {
  FEATURE_SPEC_V1_SHA,
  compareSamples,
  sampleEligibility,
  type TrainingSample,
} from '@bantoozi/ranker';
import { canonicalJson } from '@bantoozi/shared';
import { canonicalSha256 } from '@bantoozi/shared/server';

import { loadClassificationConfig, ratingDefaults } from '../../src/classify/config.js';
import { loadLearnInputs, type LearnInputs } from '../../src/learn/inputs.js';
import { recordModelPin } from '../../src/model-pin.js';
import { cardInputHashes } from '../../src/rank/items.js';
import { loadRankModelState } from '../../src/rank/model.js';
import { loadRankerSettings } from '../../src/rank/settings.js';
import type { ClassifyHarness } from './classify.js';

/**
 * JEV-4 fixtures: concrete Jev pins, the family sha computed independently of the production code
 * (the contract's definition), the pre-change context formula, and the new-contract shapes of the
 * worker's learn inputs. Production functions that do not exist yet are imported lazily so a
 * missing module fails the test that needs it, not the whole file.
 */

export const V113 = 'jev-1.13.0';
export const V114 = 'jev-1.14.0';
export const V2 = 'jev-2.0.0';

export const REGISTRY_KEY = 'engine.rating_fingerprints';
const FINGERPRINT_KEYS = [
  'engine.model_pin',
  'question_sets.active',
  'language_modes',
  'card_text_mode',
] as const;

/** The `LearnInputs` of the contract (T2): the family fields on top of today's. */
export type FamilyInputs = LearnInputs & {
  familySha: string;
  families: Record<string, string>;
  strict: boolean;
  registered: boolean;
};

export interface UserModelRow {
  version: number;
  active: boolean;
  weights: unknown;
  intercept: number;
  scaler: unknown;
  calibration: unknown;
  metrics: Record<string, unknown>;
}

/** `jev-<major>` for a concrete Jev release, any other id is its own family. */
const CONCRETE = /^jev-\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/;
export const familyOf = (model: string): string =>
  CONCRETE.test(model) ? model.slice(0, model.indexOf('.')) : model;

const primaryOf = (h: ClassifyHarness): string => h.deps.classification!.primaryModel;

export const defaultsOf = async (h: ClassifyHarness): Promise<RatingDefaults> =>
  ratingDefaults(await loadClassificationConfig(h.db, h.settingsEnv), primaryOf(h));

async function storedFingerprintSettings(h: ClassifyHarness): Promise<Map<string, unknown>> {
  const result = await h.owner.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [[...FINGERPRINT_KEYS]],
  );
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

/** The exact settings the current state is fingerprinted from (what the registry entry keeps). */
export async function effectiveSettingsOf(h: ClassifyHarness): Promise<Record<string, unknown>> {
  return effectiveRatingSettings(await storedFingerprintSettings(h), await defaultsOf(h));
}

/** The exact sha, as the API stamps it. */
export async function exactShaOf(h: ClassifyHarness): Promise<string> {
  return readRatingFingerprint(h.db, await defaultsOf(h));
}

/** The family sha by the contract: the exact hash with the pin replaced by `{family, laya?}`. */
export async function familyShaOracle(h: ClassifyHarness): Promise<string> {
  const settings = await effectiveSettingsOf(h);
  const pin = settings['engine.model_pin'] as { model: string; laya?: unknown };
  return createHash('sha256')
    .update(
      canonicalJson({
        specSha: FEATURE_SNAPSHOT_SPEC_SHA,
        settings: {
          ...settings,
          'engine.model_pin': {
            ...(CONCRETE.test(pin.model) ? { family: familyOf(pin.model) } : { id: pin.model }),
            ...(pin.laya === undefined ? {} : { laya: pin.laya }),
          },
        },
      }),
    )
    .digest('hex');
}

// ── Pin and answers ────────────────────────────────────────────────────────────────────────────

/** Every typesafe facet and card answer of the pool carries `model`: the pin's answers. */
export async function retag(h: ClassifyHarness, model: string): Promise<void> {
  await h.owner.query(`UPDATE article_facets SET model = $1 WHERE engine = 'typesafe'`, [model]);
  await h.owner.query(`UPDATE card_answers SET model = $1 WHERE engine = 'typesafe'`, [model]);
}

/** A clean start: pin `model` stored, no registry, the pool answered by `model`. */
export async function begin(h: ClassifyHarness, model: string): Promise<void> {
  await h.owner.query(`DELETE FROM settings WHERE key IN ('engine.model_pin', $1)`, [REGISTRY_KEY]);
  await h.owner.query(`INSERT INTO settings (key, value) VALUES ('engine.model_pin', $1::jsonb)`, [
    JSON.stringify({ model, since: new Date().toISOString() }),
  ]);
  await retag(h, model);
}

/** A worker start with another model (`recordModelPin`); `answers` also moves the pool's answers. */
export async function flip(
  h: ClassifyHarness,
  model: string,
  options: { answers?: boolean } = {},
): Promise<void> {
  await recordModelPin(h.db, { model }, new Date());
  if (options.answers === true) await retag(h, model);
}

// ── Registry ───────────────────────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  family: string;
  settings: Record<string, unknown>;
  firstSeenAt: string;
}

export async function registryOf(h: ClassifyHarness): Promise<Record<string, RegistryEntry>> {
  const result = await h.owner.query<{ value: Record<string, RegistryEntry> }>(
    `SELECT value FROM settings WHERE key = $1`,
    [REGISTRY_KEY],
  );
  return result.rows[0]?.value ?? {};
}

export async function registryStamp(h: ClassifyHarness): Promise<string | null> {
  const result = await h.owner.query<{ stamp: string }>(
    `SELECT updated_at::text AS stamp FROM settings WHERE key = $1`,
    [REGISTRY_KEY],
  );
  return result.rows[0]?.stamp ?? null;
}

export async function dropRegistry(h: ClassifyHarness): Promise<void> {
  await h.owner.query(`DELETE FROM settings WHERE key = $1`, [REGISTRY_KEY]);
}

/** Every settings row with its value and write time: what "no writes" compares. */
export async function settingsRows(h: ClassifyHarness): Promise<unknown[]> {
  const result = await h.owner.query(
    `SELECT key, value, updated_at::text AS updated_at FROM settings ORDER BY key`,
  );
  return result.rows;
}

/** The worker's `ensureFingerprintRegistered` (T1), loaded lazily. */
export async function ensureRegistered(
  h: ClassifyHarness,
  now: Date = new Date(),
): Promise<{ registered: boolean; evicted: number }> {
  const mod = (await import('../../src/learn/fingerprints.js')) as {
    ensureFingerprintRegistered: (
      db: ClassifyHarness['db'],
      deps: { settingsEnv: ClassifyHarness['settingsEnv']; primaryModel: string },
      now: Date,
    ) => Promise<{ registered: boolean; evicted: number }>;
  };
  return mod.ensureFingerprintRegistered(
    h.db,
    { settingsEnv: h.settingsEnv, primaryModel: primaryOf(h) },
    now,
  );
}

// ── Learn inputs and model state ───────────────────────────────────────────────────────────────

export async function learnInputs(h: ClassifyHarness, userId: string): Promise<FamilyInputs> {
  return (await loadLearnInputs(h.db, h.deps, userId, new Date())) as FamilyInputs;
}

/** How many of the user's samples are ineligible, by reason (`ok` counts the eligible ones). */
export function reasonCounts(inputs: FamilyInputs): Record<string, number> {
  const opts = {
    now: inputs.now,
    historyDays: inputs.config.model.historyDays,
    ratingSha: inputs.ratingSha,
    familySha: inputs.familySha,
    families: inputs.families,
  };
  const counts: Record<string, number> = {};
  for (const sample of inputs.samples) {
    const verdict = sampleEligibility(sample as unknown as TrainingSample, opts);
    const key = verdict.ok ? 'ok' : verdict.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function rankStatus(h: ClassifyHarness, userId: string): Promise<string> {
  const config = await loadClassificationConfig(h.db, h.settingsEnv);
  const settings = await loadRankerSettings(h.db);
  const hashes = cardInputHashes(
    await loadCardInputs(h.db, await loadHeldCardIds(h.db, userId)),
    config,
  );
  const state = await loadRankModelState(h.db, {
    userId,
    config: settings.config,
    hashes,
    ratingDefaults: ratingDefaults(config, primaryOf(h)),
  });
  return state.status;
}

export async function modelRows(h: ClassifyHarness, userId: string): Promise<UserModelRow[]> {
  const result = await h.owner.query<UserModelRow>(
    `SELECT version, active, weights, intercept, scaler, calibration, metrics
       FROM user_models WHERE user_id = $1 ORDER BY version`,
    [userId],
  );
  return result.rows;
}

export const ownIdsOf = (row: UserModelRow): string[] =>
  (Array.isArray(row.metrics['ownInputs']) ? row.metrics['ownInputs'] : []).map((entry) =>
    String((entry as { cardId: unknown }).cardId),
  );

// ── The formulas before this change ────────────────────────────────────────────────────────────

const compareBig = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : a === b ? 0 : 1);

/**
 * `modelContextSha` as it was before the family sha: the exact `ratingSha` key and nothing else
 * new, over the own inputs the stored attempt recorded.
 */
export async function oldContextSha(
  h: ClassifyHarness,
  userId: string,
  row: UserModelRow,
): Promise<string> {
  const config = (await loadRankerSettings(h.db)).config;
  const consent = await loadLearnConsent(h.db, userId);
  const { retrainFraction: _schedule, ...modelConfig } = config.model;
  const own = (row.metrics['ownInputs'] as Array<Record<string, unknown>>).map((o) => ({
    cardId: o['cardId'],
    strength: o['strength'],
    scopeFeedId: o['scopeFeedId'],
    cardInputSha256: o['cardInputSha256'],
  }));
  own.sort((a, b) => compareBig(String(a.cardId), String(b.cardId)));
  return canonicalSha256({
    ratingSha: row.metrics['ratingSha'],
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    strengthWeights: config.strengthWeights,
    model: modelConfig,
    consent: {
      implicitFeedback: consent.implicitFeedback,
      implicitNegative: consent.implicitNegative,
    },
    ownInputs: own,
  });
}

/** `inputSha` as it was before the family sha joined it. */
export function oldInputSha(inputs: LearnInputs): string {
  const inSnapshots = new Set(
    inputs.eligible.flatMap((s) => s.features?.cards.map((c) => c.id) ?? []),
  );
  const manifest = canonicalSha256(
    [...inputs.eligible]
      .sort((a, b) => compareSamples(a as TrainingSample, b as TrainingSample))
      .map((s) => ({
        articleId: s.articleId,
        eventId: s.eventId,
        signal: s.signal,
        y: s.y,
        weight: s.weight,
        explicit: s.explicit,
        groupId: s.groupId,
        features: canonicalSha256({ ...s.features, snapshotAt: null }),
      })),
  );
  return canonicalSha256({
    eligibleManifest: manifest,
    ratingSha: inputs.ratingSha,
    featureSpecSha: FEATURE_SPEC_V1_SHA,
    cards: inputs.held.filter((card) => inSnapshots.has(card.cardId)),
    strengthWeights: inputs.config.strengthWeights,
    model: inputs.config.model,
    consent: inputs.consent,
  });
}

/**
 * The state of a model stored before the deploy: its context is the old exact-sha formula and,
 * unless `keepInputSha`, its attempt's `inputSha` is something no new input hash equals.
 */
export async function simulatePreDeploy(
  h: ClassifyHarness,
  userId: string,
  options: { keepInputSha?: boolean } = {},
): Promise<{ oldContext: string }> {
  const rows = await modelRows(h, userId);
  const row = rows[rows.length - 1]!;
  const oldContext = await oldContextSha(h, userId, row);
  const patch: Record<string, string> = { contextSha: oldContext };
  if (options.keepInputSha !== true) patch['inputSha'] = 'pre-deploy';
  await h.owner.query(
    `UPDATE user_models SET metrics = metrics || $3::jsonb WHERE user_id = $1 AND version = $2`,
    [userId, row.version, JSON.stringify(patch)],
  );
  return { oldContext };
}
