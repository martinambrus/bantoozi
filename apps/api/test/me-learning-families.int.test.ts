import { createHash } from 'node:crypto';

import {
  createDatabase,
  effectiveRatingSettings,
  FEATURE_SNAPSHOT_SPEC_SHA,
  readRatingFingerprint,
  type RatingDefaults,
} from '@bantoozi/db';
import { FEATURE_SPEC_V1_FACET_NAMES, RAW_SNAPSHOT_SPEC_SHA } from '@bantoozi/ranker';
import { canonicalJson, LearningStatusSchema } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * JEV-4 (design visible-learning §4.2): `GET /me/learning` counts the ratings stamped under another
 * model of the current fingerprint's family, but only those whose exact sha the worker registered in
 * `settings['engine.rating_fingerprints']` under the current family sha. The endpoint only reads.
 */

const REGISTRY = 'engine.rating_fingerprints';
const KEYS = ['engine.model_pin', REGISTRY];
const CURRENT = 'jev-1.14.0';

let h: ApiHarness;
let defaults: RatingDefaults;
let previous: Map<string, unknown>;

beforeAll(async () => {
  h = await createApiHarness();
  defaults = {
    model: h.config.typesafeModel,
    languageModes: h.config.languageModes,
    cardTextMode: 'as_written',
  };
  const rows = await h.owner.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [KEYS],
  );
  previous = new Map(rows.rows.map((row) => [row.key, row.value]));
});

afterAll(async () => {
  for (const key of KEYS) {
    const value = previous.get(key);
    if (value === undefined) await h.owner.query(`DELETE FROM settings WHERE key = $1`, [key]);
    else await setSetting(key, value);
  }
  await h.close();
});

async function setSetting(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

interface Shas {
  sha: string;
  familySha: string;
  entry: { family: string; settings: Record<string, unknown>; firstSeenAt: string };
}

/** The exact and family sha of the fingerprint settings as they read with `model` pinned. */
async function shasOf(model: string): Promise<Shas> {
  await setSetting('engine.model_pin', { model });
  const rows = await h.owner.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [['engine.model_pin', 'question_sets.active', 'language_modes', 'card_text_mode']],
  );
  const stored = new Map(rows.rows.map((row) => [row.key, row.value]));
  const settings = effectiveRatingSettings(stored, defaults);
  const family = model.slice(0, model.indexOf('.'));
  const familySha = createHash('sha256')
    .update(
      canonicalJson({
        specSha: FEATURE_SNAPSHOT_SPEC_SHA,
        settings: { ...settings, 'engine.model_pin': { family } },
      }),
    )
    .digest('hex');
  const sha = await readRatingFingerprint(createDatabase(h.owner), defaults);
  return {
    sha,
    familySha,
    entry: { family: familySha, settings, firstSeenAt: '2026-10-01T00:00:00.000Z' },
  };
}

/** The three fingerprints of the scenarios, with the current pin stored again afterwards. */
async function fingerprints() {
  const old = await shasOf('jev-1.13.0');
  const major2 = await shasOf('jev-2.0.0');
  const current = await shasOf(CURRENT);
  return { old, major2, current };
}

async function status(user: TestUser) {
  const res = await apiClient(h.server, user).get('/me/learning');
  expect(res.statusCode, res.body).toBe(200);
  return LearningStatusSchema.parse(res.json());
}

async function trainingFeed(user: TestUser): Promise<{ feedId: string; cardId: string }> {
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, {
    userId: user.id,
    feedId: feed.id,
    mode: 'training',
    activatedAt: new Date(Date.now() - 30 * 86_400_000),
  });
  const card = await createCard(h.owner, { title: 'Family card' });
  return { feedId: feed.id, cardId: card.id };
}

async function rateAll(
  user: TestUser,
  scope: { feedId: string; cardId: string },
  ratingSha: string,
  each: number,
): Promise<void> {
  for (const [rating, p] of [
    [1, 0.9],
    [-1, 0.1],
  ] as const) {
    for (let i = 0; i < each; i += 1) {
      const at = new Date(Date.now() - 3_600_000);
      const article = await createArticle(h.owner, { feedIds: [scope.feedId] });
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, rating, rated_at) VALUES ($1, $2, $3, $4)`,
        [user.id, article.id, rating, at],
      );
      const facets = Object.fromEntries(FEATURE_SPEC_V1_FACET_NAMES.map((name) => [name, 0.5]));
      const features = {
        specSha: RAW_SNAPSHOT_SPEC_SHA,
        ratingSha,
        snapshotAt: at.toISOString(),
        cards: [{ id: scope.cardId, strength: 'love', p, engine: 'typesafe' }],
        values: {
          facets,
          facetsEngine: 'typesafe',
          wordCount: 400,
          ageHours: 3,
          lang: 'en',
          hasImage: false,
          hasVideo: false,
          bodyImageCount: 0,
          clusterId: null,
          clusterSize: 0,
          sourceFeedId: scope.feedId,
          author: null,
        },
        sourceManifest: {
          contentRevision: '1',
          mediaRevision: '1',
          inferenceFeedIds: [scope.feedId],
        },
      };
      await h.owner.query(
        `INSERT INTO feedback_events (user_id, article_id, kind, value, created_at)
         VALUES ($1, $2, 'rate', $3::jsonb, $4)`,
        [
          user.id,
          article.id,
          JSON.stringify({
            v: 1,
            rating,
            reason: null,
            hide: false,
            contentRevision: '1',
            signalOrigin: 'explicit',
            learningConsent: { implicitFeedback: false, implicitNegative: false },
            features,
          }),
          at,
        ],
      );
    }
  }
}

async function clearRegistry() {
  await h.owner.query(`DELETE FROM settings WHERE key = $1`, [REGISTRY]);
}

async function storeAttempt(user: TestUser, metrics: Record<string, unknown>) {
  await h.owner.query(
    `INSERT INTO user_models (user_id, version, feature_spec_sha, n_labels, n_pos, n_neg, weights,
                              intercept, scaler, calibration, metrics, active, trained_at)
     VALUES ($1, 1, $2, 0, 0, 0, '{}', 0, '{}', '{}', $3::jsonb, false, now())`,
    [user.id, 'a'.repeat(64), JSON.stringify(metrics)],
  );
}

async function scenario(old: number, current: number) {
  const user = await createTestUser(h);
  const scope = await trainingFeed(user);
  const fp = await fingerprints();
  await rateAll(user, scope, fp.old.sha, old);
  await rateAll(user, scope, fp.current.sha, current);
  return { user, scope, fp };
}

describe('GET /me/learning across a model upgrade within a family', () => {
  it('counts ratings stamped under a registered same-family sha with the current ones', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry });
    const body = await status(user);
    expect(body.model.counts).toEqual({ explicit: 32, likes: 16, dislikes: 16 });
    expect(body.feeds[0]).toMatchObject({ status: 'ready', likes: 16, dislikes: 16 });
    expect(body.feeds[0]!.auc).toBe(1);
  });

  it('counts the same-family ratings when the registry also holds the current sha', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry, [fp.current.sha]: fp.current.entry });
    expect((await status(user)).model.counts).toEqual({ explicit: 32, likes: 16, dislikes: 16 });
  });

  it('excludes the old-stamp ratings when the registry row is absent', async () => {
    const { user } = await scenario(10, 6);
    await clearRegistry();
    const body = await status(user);
    expect(body.model.counts).toEqual({ explicit: 12, likes: 6, dislikes: 6 });
    expect(body.feeds[0]).toMatchObject({ likes: 6, dislikes: 6 });
  });

  it('excludes a sha that is not registered even when others of the family are', async () => {
    const user = await createTestUser(h);
    const scope = await trainingFeed(user);
    const fp = await fingerprints();
    const unknown = (await shasOf('jev-1.12.0')).sha;
    await shasOf(CURRENT);
    await rateAll(user, scope, unknown, 8);
    await rateAll(user, scope, fp.old.sha, 5);
    await rateAll(user, scope, fp.current.sha, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry });
    expect((await status(user)).model.counts).toEqual({ explicit: 22, likes: 11, dislikes: 11 });
  });

  it('excludes ratings stamped under another major version even when the worker registered them', async () => {
    const user = await createTestUser(h);
    const scope = await trainingFeed(user);
    const fp = await fingerprints();
    await rateAll(user, scope, fp.major2.sha, 10);
    await rateAll(user, scope, fp.old.sha, 4);
    await rateAll(user, scope, fp.current.sha, 6);
    await setSetting(REGISTRY, {
      [fp.major2.sha]: fp.major2.entry,
      [fp.old.sha]: fp.old.entry,
    });
    expect((await status(user)).model.counts).toEqual({ explicit: 20, likes: 10, dislikes: 10 });
  });

  it('excludes a registered sha whose stored family is not the current family', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, {
      [fp.old.sha]: { ...fp.old.entry, family: fp.major2.familySha },
    });
    expect((await status(user)).model.counts).toEqual({ explicit: 12, likes: 6, dislikes: 6 });
  });

  it('ignores a registry entry that fails its schema', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: { ...fp.old.entry, family: 'jev-1' } });
    expect((await status(user)).model.counts).toEqual({ explicit: 12, likes: 6, dislikes: 6 });
  });

  it('answers 200 and keeps the current ratings when the registry value is not an object', async () => {
    const { user } = await scenario(10, 6);
    await setSetting(REGISTRY, 'garbage');
    expect((await status(user)).model.counts).toEqual({ explicit: 12, likes: 6, dislikes: 6 });
  });
});

describe('ratings stamped with the current sha', () => {
  it('count with an empty registry', async () => {
    const { user } = await scenario(0, 8);
    await setSetting(REGISTRY, {});
    expect((await status(user)).model.counts).toEqual({ explicit: 16, likes: 8, dislikes: 8 });
  });

  it('count with no registry row at all', async () => {
    const { user } = await scenario(0, 8);
    await clearRegistry();
    expect((await status(user)).model.counts).toEqual({ explicit: 16, likes: 8, dislikes: 8 });
  });
});

describe('strict mode after an upgrade regression', () => {
  const attempt = () => ({
    status: 'rejected',
    reason: 'upgrade_regression',
    attemptAt: new Date().toISOString(),
    cvAuc: 0.6,
    baselineAuc: 0.7,
  });

  it('counts only the current sha while the last attempt is strict for it', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry });
    await storeAttempt(user, { ...attempt(), strictRatingSha: fp.current.sha });
    expect((await status(user)).model.counts).toEqual({ explicit: 12, likes: 6, dislikes: 6 });
  });

  it('is over once the exact sha has changed since the marker', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry });
    await storeAttempt(user, { ...attempt(), strictRatingSha: fp.major2.sha });
    expect((await status(user)).model.counts).toEqual({ explicit: 32, likes: 16, dislikes: 16 });
  });
});

describe('the endpoint only reads settings', () => {
  const snapshot = async () =>
    (
      await h.owner.query(
        `SELECT key, value, updated_at::text AS updated_at FROM settings ORDER BY key`,
      )
    ).rows;

  it('leaves every settings row, the registry included, untouched', async () => {
    const { user, fp } = await scenario(10, 6);
    await setSetting(REGISTRY, { [fp.old.sha]: fp.old.entry });
    await status(user);
    const before = await snapshot();
    await status(user);
    await status(user);
    expect(await snapshot()).toEqual(before);
  });

  it('does not register the current sha when the registry lacks it', async () => {
    const { user } = await scenario(0, 6);
    await clearRegistry();
    const before = await snapshot();
    await status(user);
    expect(await snapshot()).toEqual(before);
    const registry = await h.owner.query(`SELECT 1 FROM settings WHERE key = $1`, [REGISTRY]);
    expect(registry.rowCount).toBe(0);
  });
});
