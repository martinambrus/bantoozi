import {
  loadCardInputs,
  loadLearnConsent,
  readRatingFingerprint,
  type Database,
} from '@bantoozi/db';
import { FEATURE_SPEC_V1_SHA, modelContextSha } from '@bantoozi/ranker';
import { parseJobPayload, type Explain } from '@bantoozi/shared';

import { loadClassificationConfig, ratingDefaults } from '../../src/classify/config.js';
import { createUserRankHandler } from '../../src/handlers/user-rank.js';
import { cardInputHashes } from '../../src/rank/items.js';
import { loadRankerSettings } from '../../src/rank/settings.js';
import { ago, DAY, HOUR, type ClassifyHarness } from './classify.js';

/**
 * M7-T5a fixtures: `user_models` rows in the stored layout of `user.learn` (weights
 * `{features, weights}`, intercept, scaler, calibration, metrics with the model context), whose
 * context is computed exactly like the trainer: `modelContextSha` over the current rating
 * fingerprint, the feature spec, the ranker config, the consent flags and the own inputs'
 * current strength, scope and question hash. No trainer runs: the model is a hand-written
 * logistic one, so a test knows the exact P it must produce.
 */

export interface RankRow {
  lane: string;
  tier: number | null;
  p: number | null;
  source: string;
  rules: string[];
  explain: Explain | null;
  scoredAt: Date | null;
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Run `user.rank` for the user; the summary log of the run. */
export async function rank(
  h: ClassifyHarness,
  userId: string,
  options: { full?: boolean; now?: Date } = {},
): Promise<{ outcome: string; ranked: number; written: number }> {
  const logs: Array<Record<string, unknown>> = [];
  const handle = createUserRankHandler({
    ...h.deps,
    logger: { info: (obj) => logs.push(obj as Record<string, unknown>), warn() {}, error() {} },
    ...(options.now === undefined ? {} : { now: () => options.now as Date }),
  });
  await handle(
    parseJobPayload('user.rank', {
      userId,
      reason: 'test',
      ...(options.full === true ? { full: true } : {}),
    }),
    { queue: 'user.rank', jobId: 'test' },
  );
  const log = logs.find((entry) => entry['job'] === 'user.rank');
  return {
    outcome: String(log?.['outcome'] ?? 'none'),
    ranked: Number(log?.['ranked'] ?? 0),
    written: Number(log?.['written'] ?? 0),
  };
}

export async function rankRow(
  h: ClassifyHarness,
  userId: string,
  articleId: string,
): Promise<RankRow> {
  const result = await h.owner.query<{
    lane: string;
    tier: number | null;
    p_like: number | null;
    score_source: string;
    rules_fired: string[];
    explain: Explain | null;
    scored_at: Date | null;
  }>(
    `SELECT lane, tier, p_like, score_source, rules_fired, explain, scored_at
       FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no user_article row for ${articleId}`);
  return {
    lane: row.lane,
    tier: row.tier,
    p: row.p_like,
    source: row.score_source,
    rules: row.rules_fired,
    explain: row.explain,
    scoredAt: row.scored_at,
  };
}

export interface ModelSpec {
  features: string[];
  weights: number[];
  intercept?: number;
  /** Cards that are own inputs (the model's `card.<id>` features); their strength etc. are read now. */
  ownCards?: string[];
  active?: boolean;
  /** Overrides the computed context (a stored context that is not the current one). */
  contextSha?: string;
}

/** The context the current state implies for `ownCards` (spec 06 §8.1), as the trainer computes it. */
export async function currentModelContext(
  h: ClassifyHarness,
  userId: string,
  ownCards: readonly string[],
): Promise<{ contextSha: string; ratingSha: string; ownInputs: Record<string, unknown>[] }> {
  const db: Database = h.db;
  const config = (await loadRankerSettings(db)).config;
  const consent = await loadLearnConsent(db, userId);
  const classification = await loadClassificationConfig(db, h.deps.settingsEnv);
  const ratingSha = await readRatingFingerprint(
    db,
    ratingDefaults(classification, h.deps.classification?.primaryModel ?? ''),
  );
  const hashes = cardInputHashes(await loadCardInputs(db, [...ownCards]), classification);
  const held = await h.owner.query<{ card_id: string; strength: string; scope: string | null }>(
    `SELECT card_id::text AS card_id, strength, scope_feed_id::text AS scope
       FROM user_cards WHERE user_id = $1 AND card_id = ANY($2::bigint[])`,
    [userId, [...ownCards]],
  );
  const ownInputs = held.rows.map((row) => ({
    cardId: row.card_id,
    strength: row.strength,
    scopeFeedId: row.scope,
    cardInputSha256: hashes.get(row.card_id) ?? '',
  }));
  return {
    contextSha: modelContextSha({
      ratingSha,
      featureSpecSha: FEATURE_SPEC_V1_SHA,
      strengthWeights: config.strengthWeights,
      modelConfig: config.model,
      consent,
      ownInputs: ownInputs as Parameters<typeof modelContextSha>[0]['ownInputs'],
    }),
    ratingSha,
    ownInputs,
  };
}

/**
 * Store the model as the user's next version (the previous active one is deactivated when this one
 * is active) and return its version and context. Identity scaler, Platt a = 1, b = 0, so
 * P = sigmoid(intercept + sum(weight * feature)).
 */
export async function installModel(
  h: ClassifyHarness,
  userId: string,
  spec: ModelSpec,
): Promise<{ version: number; contextSha: string }> {
  const context = await currentModelContext(h, userId, spec.ownCards ?? []);
  const contextSha = spec.contextSha ?? context.contextSha;
  const active = spec.active ?? true;
  if (active) {
    await h.owner.query(`UPDATE user_models SET active = false WHERE user_id = $1 AND active`, [
      userId,
    ]);
  }
  const inserted = await h.owner.query<{ version: number }>(
    `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                              intercept, scaler, calibration, metrics, active)
     SELECT $1, coalesce(max(version), 0) + 1, $2, 60, 30, 30, $3::jsonb, $4, $5::jsonb, $6::jsonb,
            $7::jsonb, $8
       FROM user_models WHERE user_id = $1
     RETURNING version`,
    [
      userId,
      FEATURE_SPEC_V1_SHA,
      JSON.stringify({ features: spec.features, weights: spec.weights }),
      spec.intercept ?? 0,
      JSON.stringify({
        mean: spec.features.map(() => 0),
        scale: spec.features.map(() => 1),
      }),
      JSON.stringify({ method: 'platt', a: 1, b: 0 }),
      JSON.stringify({
        status: active ? 'activated' : 'rejected',
        contextSha,
        ratingSha: context.ratingSha,
        featureSpecSha: FEATURE_SPEC_V1_SHA,
        ownInputs: context.ownInputs,
      }),
      active,
    ],
  );
  return { version: inserted.rows[0]?.version ?? 0, contextSha };
}

let readers = 0;

/** An active reader of a new feed holding one `like` interest card (title set explicitly). */
export async function reader(h: ClassifyHarness) {
  readers += 1;
  const userId = await h.user();
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, 'active', ago(30 * DAY));
  const cardId = await h.heldCard(userId, {
    interest: `ocean shipping logistics harbor ${readers}`,
    title: `Ocean shipping ${readers}`,
  });
  return { userId, feedId, cardId };
}

/** A matched article with current facets and a current Jev answer of `cardId`. */
export async function matched(
  h: ClassifyHarness,
  feedId: string,
  cardId: string,
  p: number,
  options: { title?: string } = {},
): Promise<string> {
  const articleId = await h.article({ feedIds: [feedId], ...options });
  await h.enrichDirect(articleId, { state: 'matched' });
  await h.answerCard(articleId, cardId, { engine: 'typesafe', p });
  return articleId;
}

/** The simple model of most tests: P = sigmoid(-2 + 4 * best.like); a 0.9 answer gives 0.832. */
export const SIMPLE_MODEL: ModelSpec = { features: ['best.like'], weights: [4], intercept: -2 };
export const simpleP = (answer: number): number => sigmoid(-2 + 4 * answer);

export { DAY, HOUR };
