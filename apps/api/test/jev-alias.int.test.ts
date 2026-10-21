import { randomUUID } from 'node:crypto';

import { createDatabase, readRatingFingerprint, seedQuestionSets } from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ratingDefaultsFor } from '../src/services/analysis.js';
import { liveTypesafeModel } from '../src/services/runtime.js';
import { buildServer } from '../src/server.js';

import { carriedArticle, freshFence, subscribedFeed } from './support/article-fixtures.js';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  testConfig,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * JEV-2 ruler (contract point 13): with the live setting `engine.typesafe_model = 'jev-latest'` the API
 * freezes and fingerprints the RESOLVED concrete id, never the alias. Pin present and concrete: the
 * pin wins. Pin absent: the worker's stored resolution. Neither: classification is not configured
 * (409), nothing is created and no training mode is entered.
 *
 * The server runs outside production with `TYPESAFE_MODEL` at its default (jev-1.13.0), so a result
 * of `jev-1.13.0` from the env can never be mistaken for a resolution unless the resolution row says
 * so: the resolved ids used here are jev-1.14.0 / jev-1.15.0 unless a case compares with the env id.
 */

let h: ApiHarness;
const servers: FastifyInstance[] = [];

const ALIAS = 'jev-latest';

async function build(env: Record<string, string> = {}): Promise<FastifyInstance> {
  const server = await buildServer({
    db: h.appDb,
    config: testConfig({ FETCH_ALLOW_PRIVATE: 'true', ...env }, h.db.urls.app),
    mailer: h.mailer,
  });
  await server.ready();
  servers.push(server);
  return server;
}

async function setRow(key: string, value: unknown): Promise<void> {
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

const resolution = (model: string) => ({
  alias: ALIAS,
  model,
  resolvedAt: '2026-10-01T10:00:00.000Z',
  checkedAt: '2026-10-02T10:00:00.000Z',
});
const pin = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  since: '2026-10-01T00:00:00Z',
  ...extra,
});

async function resetSettings(): Promise<void> {
  await h.owner.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
    ['engine.typesafe_model', 'engine.model_pin', 'engine.model_resolution'],
  ]);
}

async function seedActiveQuestionSets(): Promise<void> {
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );
}

beforeAll(async () => {
  h = await createApiHarness();
  await seedActiveQuestionSets();
});

afterAll(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      // closed by the test
    }
  }
  await h.close();
});

beforeEach(async () => {
  await resetSettings();
});

const requestCount = async (userId: string): Promise<number> =>
  Number(
    (
      await h.owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM analysis_requests WHERE user_id = $1',
        [userId],
      )
    ).rows[0]?.n,
  );

const modeOf = async (userId: string, feedId: string): Promise<string> =>
  (
    await h.owner.query<{ mode: string }>(
      'SELECT inference_mode AS mode FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [userId, feedId],
    )
  ).rows[0]!.mode;

/** A fresh reader with an `off` subscription and one article: the shape of a first training analysis. */
async function trainee() {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'off' });
  const article = await createArticle(h.owner, { feedIds: [feed.id] });
  return { user, feed, article };
}

async function analyze(
  server: FastifyInstance,
  t: { user: TestUser; feed: { id: string }; article: { id: string; contentRevision: string } },
) {
  return apiClient(server, t.user).post(`/subscriptions/${t.feed.id}/analyze`, {
    articles: [{ id: t.article.id, contentRevision: t.article.contentRevision }],
    expectedInferenceVersion: '0',
    startTraining: true,
  });
}

async function frozenModel(requestId: string): Promise<string | undefined> {
  const { rows } = await h.owner.query<{ input_snapshot: { model: { model: string } } }>(
    'SELECT input_snapshot FROM analysis_requests WHERE id = $1',
    [requestId],
  );
  return rows[0]?.input_snapshot.model.model;
}

describe('jev-latest: the analysis snapshot model', () => {
  it('A1 a pin wins: the frozen model is pin.model, whatever the resolution says', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_pin', pin('jev-1.12.0', { alias: ALIAS }));
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    const t = await trainee();
    const res = await analyze(await build(), t);
    expect(res.statusCode, res.body).toBe(202);
    expect(await frozenModel(res.json().requests[0].id)).toBe('jev-1.12.0');
  });

  it('A2 no pin: the stored resolution is frozen, and another resolution gives another model', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_resolution', resolution('jev-1.13.0'));
    const first = await trainee();
    const a = await analyze(await build(), first);
    expect(a.statusCode, a.body).toBe(202);
    expect(await frozenModel(a.json().requests[0].id)).toBe('jev-1.13.0');
    // negative control: a different resolution freezes a different id (not a hard-coded one)
    await setRow('engine.model_resolution', resolution('jev-1.15.0'));
    const second = await trainee();
    const b = await analyze(await build(), second);
    expect(b.statusCode, b.body).toBe(202);
    expect(await frozenModel(b.json().requests[0].id)).toBe('jev-1.15.0');
  });

  it('A3 no pin and no resolution: 409, no request row and the subscription mode unchanged', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    const t = await trainee();
    const before = await modeOf(t.user.id, t.feed.id);
    const res = await analyze(await build(), t);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(await requestCount(t.user.id)).toBe(0);
    expect(await modeOf(t.user.id, t.feed.id)).toBe(before);
    // negative control: the same user, article and server succeed once a resolution exists
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    const ok = await analyze(await build(), t);
    expect(ok.statusCode, ok.body).toBe(202);
    expect(await requestCount(t.user.id)).toBe(1);
    expect(await modeOf(t.user.id, t.feed.id)).not.toBe(before);
  });

  it('A3 an invalid resolution row counts as none', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_resolution', resolution('jev-latest'));
    const t = await trainee();
    const res = await analyze(await build(), t);
    expect(res.statusCode, res.body).toBe(409);
    expect(await requestCount(t.user.id)).toBe(0);
  });

  it('A3 rating path: the rating is stored and no request is created without a model', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    const create = async () => {
      const user = await createTestUser(h);
      const feed = await subscribedFeed(h, user.id, { mode: 'training' });
      const article = await carriedArticle(h, [feed]);
      return { user, article };
    };
    const rate = async (server: FastifyInstance, c: Awaited<ReturnType<typeof create>>) => {
      const res = await apiClient(server, c.user).post(`/articles/${c.article}/rating`, {
        ...freshFence,
        rating: 1,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const server = await build();
    const unresolved = await create();
    const body = await rate(server, unresolved);
    expect(body.item.rating).toBe(1);
    expect(await requestCount(unresolved.user.id)).toBe(0);
    // negative control: with a resolution the same action creates its analysis request
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    const resolved = await create();
    await rate(await build(), resolved);
    expect(await requestCount(resolved.user.id)).toBe(1);
  });

  it('A4 a pin whose model is the alias counts as absent', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_pin', pin(ALIAS));
    const unresolved = await trainee();
    const none = await analyze(await build(), unresolved);
    expect(none.statusCode, none.body).toBe(409);
    expect(await requestCount(unresolved.user.id)).toBe(0);
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    const resolved = await trainee();
    const ok = await analyze(await build(), resolved);
    expect(ok.statusCode, ok.body).toBe(202);
    expect(await frozenModel(ok.json().requests[0].id)).toBe('jev-1.14.0');
  });
});

describe('jev-latest: the rating fingerprint', () => {
  const fingerprint = async (server: FastifyInstance): Promise<string> =>
    readRatingFingerprint(
      createDatabase(h.owner),
      ratingDefaultsFor(server.services.config, await liveTypesafeModel(server.services)),
    );

  it('A5 the alias with a resolution fingerprints like the concrete setting without a pin', async () => {
    await setRow('engine.typesafe_model', 'jev-1.14.0');
    const concrete = await fingerprint(await build());

    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    const aliased = await fingerprint(await build());
    expect(aliased).toBe(concrete);

    // controls: another resolution differs, and an unresolved alias differs from the resolved one
    await setRow('engine.model_resolution', resolution('jev-1.15.0'));
    expect(await fingerprint(await build())).not.toBe(concrete);
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_resolution'`);
    expect(await fingerprint(await build())).not.toBe(concrete);
  });

  it('A5 a pin with the alias equals the pin without it; a different pinned model differs', async () => {
    await setRow('engine.typesafe_model', ALIAS);
    await setRow('engine.model_resolution', resolution('jev-1.15.0'));
    await setRow('engine.model_pin', pin('jev-1.13.0'));
    const plain = await fingerprint(await build());
    await setRow('engine.model_pin', pin('jev-1.13.0', { alias: ALIAS }));
    expect(await fingerprint(await build())).toBe(plain);
    await setRow('engine.model_pin', pin('jev-1.14.0', { alias: ALIAS }));
    expect(await fingerprint(await build())).not.toBe(plain);
    // the pin the worker records for a resolved alias matches the no-pin resolution of that model
    await setRow('engine.model_pin', pin('jev-1.15.0', { alias: ALIAS }));
    const pinned = await fingerprint(await build());
    await h.owner.query(`DELETE FROM settings WHERE key = 'engine.model_pin'`);
    expect(await fingerprint(await build())).toBe(pinned);
  });
});

describe('jev-latest: the suggestions fallback', () => {
  async function questionSet(): Promise<string> {
    const version = `jev-alias-${randomUUID()}`;
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('suggest', $1, encode(sha256(convert_to($1, 'UTF8')), 'hex'), '{}'::jsonb)
       RETURNING id::text AS id`,
      [version],
    );
    return rows[0]!.id;
  }

  it('A6 lists rows stamped with the resolved model when no pin exists', async () => {
    const set = await questionSet();
    const activeBefore = await h.owner.query(
      `SELECT value FROM settings WHERE key = 'question_sets.active'`,
    );
    const previous = (activeBefore.rows[0]?.value ?? {}) as Record<string, unknown>;
    await setRow('question_sets.active', { ...previous, suggest: set });
    const slug = `jev-alias-${randomUUID().slice(0, 8)}`;
    const card = await createCard(h.owner, {
      visibility: 'public',
      origin: 'library',
      slug,
      title: 'Alias suggestion',
      interest: `Alias suggestion ${slug}`,
    });
    await h.owner.query(
      `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
       VALUES ($1, 1, $2, NULL)`,
      [slug, card.id],
    );
    const user = await createTestUser(h);
    await h.owner.query(
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
       VALUES ($1, $2, $3, 'jev-1.13.0', 0.5)`,
      [user.id, card.id, set],
    );
    const list = async (server: FastifyInstance) =>
      (await apiClient(server, user).get('/cards/suggestions')).json() as {
        card: { id: string };
      }[];

    // control: the fixture itself is visible under a concrete setting of the same model
    await setRow('engine.typesafe_model', 'jev-1.13.0');
    expect((await list(await build())).map((s) => s.card.id)).toEqual([card.id]);
    await setRow('engine.typesafe_model', ALIAS);
    // unresolved: nothing matches the alias
    expect(await list(await build())).toEqual([]);
    await setRow('engine.model_resolution', resolution('jev-1.13.0'));
    expect((await list(await build())).map((s) => s.card.id)).toEqual([card.id]);
    // negative control: another resolution hides the row stamped with 1.13.0
    await setRow('engine.model_resolution', resolution('jev-1.14.0'));
    expect(await list(await build())).toEqual([]);
  });
});
