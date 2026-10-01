import { randomUUID } from 'node:crypto';

import { planLimits } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureWeb, rssDocument } from './support/fixture-web.js';
import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiClient,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { opmlOf, opmlUpload } from './support/opml.js';

/**
 * M4-T10 quota enforcement across endpoints (spec 08 §6, §1.1), in one place: for each of the six
 * limits (`maxFeeds`, `maxCards`, `maxLabels`, `maxForks`, `maxRules`, `opmlMaxFeeds`) the maximum
 * is accepted and one more is `409 QUOTA_EXCEEDED {limit, used, max}`; every other path that adds a
 * counted holding (OPML import, `/cards/from-article`, card examples, library adopt, mute-story) is
 * enforced at the same boundary, while paths that do not grow usage (re-points, library updates,
 * label forks, existing holdings) are never blocked. Label forks are not counted in `maxForks`.
 * Concurrent last-slot requests serialize on the user row, so only one can succeed. Most rows are
 * seeded through the owner pool; only the boundary goes through the API (as `bantoozi_app`).
 */

const LIMITS = planLimits('beta');

let h: ApiHarness;
const web = new FixtureWeb();

beforeAll(async () => {
  h = await createApiHarness({ discoverDeps: web.deps() });
});

afterAll(async () => {
  await h.close();
});

const tag = () => randomUUID().slice(0, 8);

function expectQuota(res: LightMyRequestResponse, limit: string, used: number, max: number) {
  expect(res.statusCode, res.body).toBe(409);
  expect(res.json()).toEqual({
    error: {
      code: 'QUOTA_EXCEEDED',
      message: expect.any(String),
      details: { limit, used, max },
    },
  });
}

function expectStatus(res: LightMyRequestResponse, status: number) {
  expect(res.statusCode, res.body).toBe(status);
}

interface Reader {
  user: TestUser;
  api: ApiClient;
  feedId: string;
  articleId: string;
}

/** A reader with one (active) subscription carrying one article. */
async function reader(): Promise<Reader> {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: `Quota boundary article ${tag()}`,
  });
  return { user, api: apiClient(h.server, user), feedId: feed.id, articleId: article.id };
}

/** `n` extra subscriptions (fresh feeds) for `userId`. */
async function seedFeeds(userId: string, n: number): Promise<void> {
  await h.owner.query(
    `WITH f AS (
       INSERT INTO feeds (url, fetch_url, title)
       SELECT u, u, 'Quota filler' FROM (
         SELECT 'https://quota.example.test/' || $2 || '/' || g || '.xml' AS u
           FROM generate_series(1, $3::int) g) s
       RETURNING id)
     INSERT INTO subscriptions (user_id, feed_id) SELECT $1, id FROM f`,
    [userId, tag(), n],
  );
}

/**
 * `n` held cards for `userId`: shared interest cards, private interest forks, or label cards
 * (`user_labels`; `labelVisibility` private makes them label forks).
 */
async function seedHoldings(
  userId: string,
  n: number,
  kind: 'card' | 'fork' | 'label' | 'label-fork',
): Promise<string[]> {
  const isLabel = kind === 'label' || kind === 'label-fork';
  const isPrivate = kind === 'fork' || kind === 'label-fork';
  const created = await h.owner.query<{ id: string }>(
    `INSERT INTO interest_cards (kind, title, body, text_hash, lang, topic_ids, origin, visibility,
                                 owner_user_id, creator_user_id)
     SELECT $1, 'Filler ' || g,
            jsonb_build_object('interest', 'Filler interest ' || $2 || ' ' || g, 'not_for', NULL,
                               'interest_en', NULL, 'not_for_en', NULL),
            encode(sha256(convert_to($2 || ':' || g, 'UTF8')), 'hex'), 'en', '{}',
            $3, $4, $5, $5
       FROM generate_series(1, $6::int) g
     RETURNING id::text AS id`,
    [
      isLabel ? 'label' : 'interest',
      tag(),
      isPrivate ? 'fork' : 'user',
      isPrivate ? 'private' : 'shared',
      isPrivate ? userId : null,
      n,
    ],
  );
  const ids = created.rows.map((row) => row.id);
  if (isLabel) {
    await h.owner.query(
      `INSERT INTO user_labels (user_id, card_id, name)
       SELECT $1, id, 'Filler label ' || id FROM unnest($2::bigint[]) id`,
      [userId, ids],
    );
  } else {
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength)
       SELECT $1, id, 'like' FROM unnest($2::bigint[]) id`,
      [userId, ids],
    );
  }
  return ids;
}

async function seedRules(userId: string, n: number): Promise<void> {
  await h.owner.query(
    `INSERT INTO user_rules (user_id, kind, value)
     SELECT $1, 'mute_keyword', 'filler ' || g FROM generate_series(1, $2::int) g`,
    [userId, n],
  );
}

/** A public library card at version 1 (a library entry of its own). */
async function libraryCard(): Promise<{ slug: string; v1: string }> {
  const slug = `quota-${tag()}`;
  const v1 = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    title: 'Quota library card',
    interest: `Library interest ${slug}`,
  });
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, 1, $2, NULL)`,
    [slug, v1.id],
  );
  return { slug, v1: v1.id };
}

/** Publish version 2 of a library entry; returns the new card id. */
async function librarySuccessor(entry: { slug: string; v1: string }): Promise<string> {
  const v2 = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    title: 'Quota library card',
    interest: `Library interest ${entry.slug} (revised)`,
  });
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, 2, $2, $3)`,
    [entry.slug, v2.id, entry.v1],
  );
  return v2.id;
}

async function usage(api: ApiClient): Promise<Record<string, number>> {
  const me = await api.get('/me');
  expectStatus(me, 200);
  return me.json().quotas.used as Record<string, number>;
}

function serveFeed(url: string) {
  web.route(url, { body: rssDocument(`Feed ${url}`), contentType: 'application/rss+xml' });
}

function importOpml(api: ApiClient, urls: readonly string[]) {
  const { payload, headers } = opmlUpload(opmlOf(urls));
  return api.post('/subscriptions/import-opml', payload, { headers });
}

describe('maxFeeds', () => {
  it('POST /subscriptions: the maximum is accepted, one more is 409; a held feed uses none', async () => {
    const r = await reader();
    await seedFeeds(r.user.id, LIMITS.maxFeeds - 2);
    const last = `https://quota-last-${tag()}.example.test/feed.xml`;
    serveFeed(last);
    expectStatus(await r.api.post('/subscriptions', { url: last }), 201);
    expect((await usage(r.api)).maxFeeds).toBe(LIMITS.maxFeeds);
    const over = `https://quota-over-${tag()}.example.test/feed.xml`;
    serveFeed(over);
    expectQuota(
      await r.api.post('/subscriptions', { url: over }),
      'maxFeeds',
      LIMITS.maxFeeds,
      LIMITS.maxFeeds,
    );
    expectStatus(await r.api.post('/subscriptions', { url: last }), 200);
    expect((await usage(r.api)).maxFeeds).toBe(LIMITS.maxFeeds);
  });

  it('OPML import adds up to the remaining room and reports the rest, never exceeding maxFeeds', async () => {
    const r = await reader();
    await seedFeeds(r.user.id, LIMITS.maxFeeds - 2);
    const urls = [1, 2].map((i) => `https://opml-quota.example.test/${tag()}/${i}.xml`);
    const res = await importOpml(r.api, urls);
    expectStatus(res, 200);
    expect(res.json()).toEqual({
      added: 1,
      existing: 0,
      invalid: [{ index: 1, url: urls[1], reason: 'quota_exceeded' }],
    });
    // At the limit, nothing more is added.
    const full = await importOpml(r.api, [`https://opml-quota.example.test/${tag()}/3.xml`]);
    expectStatus(full, 200);
    expect(full.json()).toMatchObject({ added: 0, invalid: [{ reason: 'quota_exceeded' }] });
    expect((await usage(r.api)).maxFeeds).toBe(LIMITS.maxFeeds);
  });

  it('two concurrent subscribes for the last slot: exactly one succeeds', async () => {
    const r = await reader();
    await seedFeeds(r.user.id, LIMITS.maxFeeds - 2);
    const urls = [1, 2].map((i) => `https://race-${i}-${tag()}.example.test/feed.xml`);
    urls.forEach(serveFeed);
    const results = await Promise.all(urls.map((url) => r.api.post('/subscriptions', { url })));
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect((await usage(r.api)).maxFeeds).toBe(LIMITS.maxFeeds);
  });
});

describe('opmlMaxFeeds', () => {
  it(`a document of ${LIMITS.opmlMaxFeeds} feeds is accepted, one more is 409 with nothing added`, async () => {
    const big = Array.from(
      { length: LIMITS.opmlMaxFeeds + 1 },
      (_, i) => `https://opml-max.example.test/${i}.xml`,
    );
    const r = await reader();
    expectQuota(
      await importOpml(r.api, big),
      'opmlMaxFeeds',
      LIMITS.opmlMaxFeeds + 1,
      LIMITS.opmlMaxFeeds,
    );
    expect((await usage(r.api)).maxFeeds).toBe(1);
    const ok = await importOpml(r.api, big.slice(0, LIMITS.opmlMaxFeeds));
    expectStatus(ok, 200);
    // maxFeeds still bounds the import: the document is accepted, the overflow reported.
    expect(ok.json().added).toBe(LIMITS.maxFeeds - 1);
    expect(ok.json().invalid).toHaveLength(LIMITS.opmlMaxFeeds - LIMITS.maxFeeds + 1);
    expect((await usage(r.api)).maxFeeds).toBe(LIMITS.maxFeeds);
  });
});

describe('maxCards', () => {
  it('POST /cards: the maximum is accepted, one more is 409; re-creating a held card uses none', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxCards - 1, 'card');
    const ok = await r.api.post('/cards', { interest: `Last card ${tag()}`, strength: 'like' });
    expectStatus(ok, 201);
    expectQuota(
      await r.api.post('/cards', { interest: `One too many ${tag()}`, strength: 'like' }),
      'maxCards',
      LIMITS.maxCards,
      LIMITS.maxCards,
    );
    expectStatus(
      await r.api.post('/cards', { interest: ok.json().card.interest, strength: 'like' }),
      201,
    );
    expect((await usage(r.api)).maxCards).toBe(LIMITS.maxCards);
  });

  it('POST /cards/from-article: the maximum is accepted, one more is 409 maxCards', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxCards - 1, 'card');
    const body = (interest: string) => ({ articleId: r.articleId, interest, strength: 'like' });
    expectStatus(await r.api.post('/cards/from-article', body(`From article ${tag()}`)), 201);
    expectQuota(
      await r.api.post('/cards/from-article', body(`From article ${tag()}`)),
      'maxCards',
      LIMITS.maxCards,
      LIMITS.maxCards,
    );
  });

  it('POST /library/:id/adopt: the maximum is accepted, one more is 409 maxCards', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxCards - 1, 'card');
    const first = await libraryCard();
    const second = await libraryCard();
    expectStatus(await r.api.post(`/library/${first.v1}/adopt`, { strength: 'like' }), 200);
    expectQuota(
      await r.api.post(`/library/${second.v1}/adopt`, { strength: 'like' }),
      'maxCards',
      LIMITS.maxCards,
      LIMITS.maxCards,
    );
  });

  it('at the limit, changes that do not add a holding still succeed (edit, library update)', async () => {
    const r = await reader();
    const library = await libraryCard();
    expectStatus(await r.api.post(`/library/${library.v1}/adopt`, { strength: 'like' }), 200);
    const v2 = await librarySuccessor(library);
    const [filler] = await seedHoldings(r.user.id, LIMITS.maxCards - 1, 'card');
    expect((await usage(r.api)).maxCards).toBe(LIMITS.maxCards);
    const applied = await r.api.post(`/library/${library.v1}/updates/${v2}/apply`, {
      expectedCurrentCardId: library.v1,
    });
    expectStatus(applied, 200);
    expect(applied.json().idChange).toEqual({ from: library.v1, to: v2 });
    const edited = await r.api.patch(`/cards/${filler}`, { interest: `Edited filler ${tag()}` });
    expectStatus(edited, 200);
    expect(edited.json().idChange).not.toBeNull();
    expect((await usage(r.api)).maxCards).toBe(LIMITS.maxCards);
  });

  it('two concurrent creates for the last slot: exactly one succeeds', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxCards - 1, 'card');
    const results = await Promise.all(
      [1, 2].map((i) =>
        r.api.post('/cards', { interest: `Race card ${i} ${tag()}`, strength: 'like' }),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect((await usage(r.api)).maxCards).toBe(LIMITS.maxCards);
  });
});

describe('maxForks', () => {
  it('POST /cards/:id/examples: the maximum is accepted, one more is 409 maxForks', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxForks - 1, 'fork');
    const [first, second] = await seedHoldings(r.user.id, 2, 'card');
    const add = (cardId: string) =>
      r.api.post(`/cards/${cardId}/examples`, { articleId: r.articleId, side: 'yes' });
    expectStatus(await add(first!), 200);
    expectQuota(await add(second!), 'maxForks', LIMITS.maxForks, LIMITS.maxForks);
    expect((await usage(r.api)).maxForks).toBe(LIMITS.maxForks);
  });

  it('POST /cards/from-article at the fork limit is 409 maxForks (cards still have room)', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxForks - 1, 'fork');
    const body = () => ({
      articleId: r.articleId,
      interest: `Fork from article ${tag()}`,
      strength: 'like',
    });
    expectStatus(await r.api.post('/cards/from-article', body()), 201);
    expectQuota(
      await r.api.post('/cards/from-article', body()),
      'maxForks',
      LIMITS.maxForks,
      LIMITS.maxForks,
    );
  });

  it('label forks are not counted in maxForks, and card forks do not block label examples', async () => {
    const r = await reader();
    // Label forks are held labels, never card forks: card forks keep their full room.
    const labelForks = 5;
    await seedHoldings(r.user.id, labelForks, 'label-fork');
    const used = await usage(r.api);
    expect(used.maxForks).toBe(0);
    expect(used.maxLabels).toBe(labelForks);
    await seedHoldings(r.user.id, LIMITS.maxForks - 1, 'fork');
    const [card] = await seedHoldings(r.user.id, 1, 'card');
    expectStatus(
      await r.api.post(`/cards/${card}/examples`, { articleId: r.articleId, side: 'yes' }),
      200,
    );
    // At the card-fork limit, a label example (a label fork) is still accepted.
    const label = await r.api.post('/labels', {
      name: `Fork-free label ${tag()}`,
      definition: 'Organizational label',
    });
    expectStatus(label, 201);
    const forked = await r.api.post(`/labels/${label.json().label.id}/examples`, {
      articleId: r.articleId,
      side: 'yes',
    });
    expectStatus(forked, 200);
    expect(forked.json().idChange).not.toBeNull();
    const after = await usage(r.api);
    expect(after.maxForks).toBe(LIMITS.maxForks);
    expect(after.maxLabels).toBe(labelForks + 1);
  });
});

describe('maxLabels', () => {
  it('POST /labels: the maximum is accepted, one more is 409; a label example adds none', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxLabels - 1, 'label');
    const ok = await r.api.post('/labels', { name: `Last ${tag()}`, definition: 'Last label' });
    expectStatus(ok, 201);
    expectQuota(
      await r.api.post('/labels', { name: `Over ${tag()}`, definition: 'One too many' }),
      'maxLabels',
      LIMITS.maxLabels,
      LIMITS.maxLabels,
    );
    // At the limit a label fork re-points the holding: no new label, not a card fork.
    expectStatus(
      await r.api.post(`/labels/${ok.json().label.id}/examples`, {
        articleId: r.articleId,
        side: 'no',
      }),
      200,
    );
    const used = await usage(r.api);
    expect(used.maxLabels).toBe(LIMITS.maxLabels);
    expect(used.maxForks).toBe(0);
  });

  it('two concurrent creates for the last slot: exactly one succeeds', async () => {
    const r = await reader();
    await seedHoldings(r.user.id, LIMITS.maxLabels - 1, 'label');
    const results = await Promise.all(
      [1, 2].map((i) => r.api.post('/labels', { name: `Race ${i} ${tag()}`, definition: 'Race' })),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect((await usage(r.api)).maxLabels).toBe(LIMITS.maxLabels);
  });
});

describe('maxRules', () => {
  it('POST /rules: the maximum is accepted, one more is 409; a live duplicate uses none', async () => {
    const r = await reader();
    await seedRules(r.user.id, LIMITS.maxRules - 1);
    expectStatus(await r.api.post('/rules', { kind: 'mute_keyword', value: 'last rule' }), 201);
    expectQuota(
      await r.api.post('/rules', { kind: 'mute_keyword', value: 'one too many' }),
      'maxRules',
      LIMITS.maxRules,
      LIMITS.maxRules,
    );
    expectStatus(await r.api.post('/rules', { kind: 'mute_keyword', value: 'last rule' }), 201);
    expect((await usage(r.api)).maxRules).toBe(LIMITS.maxRules);
  });

  it('POST /articles/:id/mute-story goes through the same live-rule quota', async () => {
    const r = await reader();
    await seedRules(r.user.id, LIMITS.maxRules - 1);
    const other = await createArticle(h.owner, { feedIds: [r.feedId] });
    expectStatus(await r.api.post(`/articles/${r.articleId}/mute-story`, { days: 7 }), 201);
    expectQuota(
      await r.api.post(`/articles/${other.id}/mute-story`, { days: 7 }),
      'maxRules',
      LIMITS.maxRules,
      LIMITS.maxRules,
    );
    // Muting the same story again extends the live rule instead of adding one.
    expectStatus(await r.api.post(`/articles/${r.articleId}/mute-story`, { days: 30 }), 201);
    expect((await usage(r.api)).maxRules).toBe(LIMITS.maxRules);
  });

  it('two concurrent creates for the last slot: exactly one succeeds', async () => {
    const r = await reader();
    await seedRules(r.user.id, LIMITS.maxRules - 1);
    const results = await Promise.all(
      ['race one', 'race two'].map((value) =>
        r.api.post('/rules', { kind: 'mute_keyword', value }),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect((await usage(r.api)).maxRules).toBe(LIMITS.maxRules);
  });
});
