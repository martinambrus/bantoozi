import { randomBytes, randomUUID } from 'node:crypto';

import { createDatabase, seedQuestionSets } from '@bantoozi/db';
import {
  ALL_QUESTION_SETS,
  LATEST_QUESTION_SETS,
  QUESTION_SET_KINDS,
  type QuestionSetKind,
} from '@bantoozi/questions';
import {
  createArticle,
  createCard,
  createFeed,
  createSubscription,
  createUser,
} from '@bantoozi/testing';
import type { LightMyRequestResponse } from 'fastify';
import type { OpenAPIV3 } from 'openapi-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureWeb, rssDocument } from './support/fixture-web.js';
import {
  TEST_METRICS_TOKEN,
  apiClient,
  createApiHarness,
  createTestSession,
  createTestUser,
  type ApiClient,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';
import { listOperations, operationKey } from './support/openapi.js';
import { opmlOf, opmlUpload } from './support/opml.js';

/**
 * M4-T11 write-path grants (spec 08 §12, spec 02 §1.2): the server connects as `bantoozi_app`, and
 * every mutation operation of the OpenAPI document succeeds at least once against it. A missing
 * table/column grant, RLS policy or SECURITY DEFINER function surfaces here as a 403/500. The list
 * of operations is read from the document at runtime, so a new mutation without a case here fails
 * the coverage test. The same enumeration proves CSRF for every mutation: without
 * `X-Bantoozi-Client` each one is `403` (spec 08 §1).
 */

const TOPIC = 'grantstest';
const KEY_ID = 'k1';
const KEYS = JSON.stringify({ [KEY_ID]: randomBytes(32).toString('base64') });
const HOUR = 3600 * 1000;

let h: ApiHarness;
const web = new FixtureWeb();
let admin: TestUser;
let adminApi: ApiClient;
let doc: OpenAPIV3.Document;

let seq = 0;
const unique = (text: string) => `${text} ${(seq += 1)}-${randomUUID().slice(0, 6)}`;

const freshFence = { stateVersion: '0', contentRevision: '1' };
const fence = (item: { stateVersion: string; contentRevision: string }) => ({
  stateVersion: item.stateVersion,
  contentRevision: item.contentRevision,
});

interface Reader {
  user: TestUser;
  api: ApiClient;
  feedId: string;
}

/** A reader with one active subscription. */
async function reader(preferences: Record<string, unknown> = {}): Promise<Reader> {
  const user = await createTestUser(h);
  if (Object.keys(preferences).length > 0) {
    await h.owner.query('UPDATE users SET preferences = $2::jsonb WHERE id = $1', [
      user.id,
      JSON.stringify(preferences),
    ]);
  }
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
  return { user, api: apiClient(h.server, user), feedId: feed.id };
}

async function article(feedId: string): Promise<string> {
  return (await createArticle(h.owner, { feedIds: [feedId], title: unique('Grant article') })).id;
}

async function json(res: Promise<LightMyRequestResponse>, status = 200) {
  const awaited = await res;
  expect(awaited.statusCode, awaited.body).toBe(status);
  return awaited.json();
}

/** Run `text` as `userId` through the API role (a tenant transaction). */
async function asTenant<R extends object>(userId: string, text: string, values: unknown[]) {
  const client = await h.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await client.query<R>(text, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function libraryEntry(): Promise<{ slug: string; v1: string }> {
  const slug = unique('grants').replace(/\s+/g, '-');
  const card = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    slug,
    title: 'Grants library card',
    interest: unique('Library interest'),
  });
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, 1, $2, NULL)`,
    [slug, card.id],
  );
  return { slug, v1: card.id };
}

async function librarySuccessor(entry: { slug: string; v1: string }): Promise<string> {
  await h.owner.query('UPDATE interest_cards SET slug = NULL WHERE id = $1', [entry.v1]);
  const card = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    slug: entry.slug,
    title: 'Grants library card',
    interest: unique('Library interest, revised'),
  });
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, 2, $2, $3)`,
    [entry.slug, card.id, entry.v1],
  );
  return card.id;
}

/** A shared card created by `creator` and held by the creator plus two other users. */
async function popularSharedCard(creator: string): Promise<string> {
  const card = await createCard(h.owner, {
    visibility: 'shared',
    creatorUserId: creator,
    interest: unique('Popular shared interest'),
  });
  const holders = [creator, (await createUser(h.owner)).id, (await createUser(h.owner)).id];
  for (const holder of holders) {
    await h.owner.query(
      "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
      [holder, card.id],
    );
  }
  return card.id;
}

function lastCode(email: string): string {
  const mail = h.mailer.sent.filter((m) => m.to === email).at(-1);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  if (code === undefined) throw new Error(`no code mailed to ${email}`);
  return code;
}

async function stagedCredential(): Promise<{ revision: string; version: string }> {
  await h.owner.query('DELETE FROM provider_credentials');
  const staged = await json(
    adminApi.put('/admin/engine/credentials/ollama', {
      apiKey: 'sk-test-secret',
      expectedRevision: '0',
    }),
  );
  return { revision: staged.credential.revision, version: staged.credential.candidateVersion };
}

type Case = () => Promise<LightMyRequestResponse>;

/** One successful call per mutation operation (fixtures are created inside each case). */
const CASES: Record<string, Case> = {
  // ── Auth, invites, waitlist (spec 08 §2) ──
  'POST /auth/request-code': async () =>
    apiClient(h.server).post('/auth/request-code', {
      email: `grants-${randomUUID()}@example.test`,
    }),
  'POST /auth/verify': async () => {
    const user = await createUser(h.owner);
    await json(apiClient(h.server).post('/auth/request-code', { email: user.email }), 202);
    return apiClient(h.server).post('/auth/verify', {
      email: user.email,
      code: lastCode(user.email),
    });
  },
  'POST /auth/logout': async () =>
    apiClient(h.server, await createTestUser(h)).post('/auth/logout'),
  'DELETE /auth/sessions/:id': async () => {
    const user = await createTestUser(h);
    const other = await createTestSession(h, user);
    return apiClient(h.server, user).delete(`/auth/sessions/${other.sessionId}`);
  },
  'POST /invites': async () => {
    const user = await createTestUser(h);
    await h.owner.query('UPDATE users SET invites_left = 1 WHERE id = $1', [user.id]);
    return apiClient(h.server, user).post('/invites', { note: 'grants' });
  },
  'POST /waitlist': async () =>
    apiClient(h.server).post('/waitlist', { email: `wait-${randomUUID()}@example.test` }),

  // ── Me (§3) ──
  'PATCH /me': async () =>
    apiClient(h.server, await createTestUser(h)).patch('/me', {
      displayName: 'Grant tester',
      preferences: { theme: 'dark', defaultTier: 2 },
    }),
  'DELETE /me': async () => (await reader()).api.delete('/me'),

  // ── Subscriptions (§4) ──
  'POST /subscriptions': async () => {
    const url = `https://grants-${randomUUID()}.example.test/feed.xml`;
    web.route(url, { body: rssDocument('Grants feed'), contentType: 'application/rss+xml' });
    return apiClient(h.server, await createTestUser(h)).post('/subscriptions', {
      url,
      folder: 'Grants',
    });
  },
  'PATCH /subscriptions/:feedId': async () => {
    const r = await reader();
    return r.api.patch(`/subscriptions/${r.feedId}`, {
      titleOverride: 'Mine',
      folder: 'Folder',
      allowDuplicates: true,
      hidden: false,
      imagePolicy: 'allow',
    });
  },
  'DELETE /subscriptions/:feedId': async () => {
    const r = await reader();
    return r.api.delete(`/subscriptions/${r.feedId}`);
  },
  'POST /subscriptions/:feedId/inference': async () => {
    const user = await createTestUser(h);
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
    return apiClient(h.server, user).post(`/subscriptions/${feed.id}/inference`, {
      mode: 'training',
      expectedVersion: '0',
    });
  },
  'POST /subscriptions/:feedId/analyze': async () => {
    const user = await createTestUser(h);
    const feed = await createFeed(h.owner);
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
    const a = await createArticle(h.owner, { feedIds: [feed.id] });
    return apiClient(h.server, user).post(`/subscriptions/${feed.id}/analyze`, {
      articles: [{ id: a.id, contentRevision: a.contentRevision }],
      expectedInferenceVersion: '0',
      startTraining: true,
    });
  },
  'PUT /feed-preferences/:feedId': async () => {
    const r = await reader();
    return r.api.put(`/feed-preferences/${r.feedId}`, { imagePolicy: 'block' });
  },
  'POST /subscriptions/import-opml': async () => {
    const { payload, headers } = opmlUpload(
      opmlOf([`https://opml-grants.example.test/${randomUUID()}.xml`]),
    );
    return apiClient(h.server, await createTestUser(h)).post(
      '/subscriptions/import-opml',
      payload,
      { headers },
    );
  },
  'POST /subscriptions/folders/rename': async () => {
    const r = await reader();
    await h.owner.query("UPDATE subscriptions SET folder = 'Old' WHERE user_id = $1", [r.user.id]);
    return r.api.post('/subscriptions/folders/rename', { from: 'Old', to: 'New' });
  },
  'POST /subscriptions/:feedId/mark-read': async () => {
    const r = await reader();
    await article(r.feedId);
    const list = await json(r.api.get('/articles', { query: { lane: 'all', feedId: r.feedId } }));
    return r.api.post(`/subscriptions/${r.feedId}/mark-read`, {
      olderThan: list.asOf,
      datasetVersion: list.datasetVersion,
    });
  },

  // ── Article actions (§5.3) ──
  'POST /articles/:id/read': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/read`, freshFence);
  },
  'POST /articles/:id/unread': async () => {
    const r = await reader();
    const id = await article(r.feedId);
    const read = await json(r.api.post(`/articles/${id}/read`, freshFence));
    return r.api.post(`/articles/${id}/unread`, fence(read.item));
  },
  'POST /articles/:id/unhide': async () => {
    const r = await reader();
    const id = await article(r.feedId);
    const hidden = await json(
      r.api.post(`/articles/${id}/rating`, { ...freshFence, rating: -1, hide: true }),
    );
    return r.api.post(`/articles/${id}/unhide`, fence(hidden.item));
  },
  'POST /articles/:id/open': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/open`, freshFence);
  },
  'POST /articles/:id/dwell': async () => {
    const r = await reader({ implicitFeedback: true });
    const id = await article(r.feedId);
    const opened = await json(r.api.post(`/articles/${id}/open`, freshFence));
    await h.owner.query(
      "UPDATE user_article SET opened_at = now() - interval '1 minute' WHERE user_id = $1",
      [r.user.id],
    );
    return r.api.post(`/articles/${id}/dwell`, { ...fence(opened.item), ms: 30_000 });
  },
  'POST /articles/:id/rating': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/rating`, {
      ...freshFence,
      rating: -1,
      reason: 'clickbait',
    });
  },
  'POST /articles/:id/prompt-answer': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/prompt-answer`, {
      ...freshFence,
      liked: true,
    });
  },
  'POST /articles/:id/bookmark': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/bookmark`, freshFence);
  },
  'DELETE /articles/:id/bookmark': async () => {
    const r = await reader();
    const id = await article(r.feedId);
    const saved = await json(r.api.post(`/articles/${id}/bookmark`, freshFence));
    return r.api.delete(`/articles/${id}/bookmark`, { query: fence(saved.item) });
  },
  'POST /articles/:id/bookmark/retry-capture': async () => {
    const r = await reader();
    const id = await article(r.feedId);
    const saved = await json(r.api.post(`/articles/${id}/bookmark`, freshFence));
    await h.owner.query(
      "UPDATE user_article SET bookmark_capture_status = 'failed' WHERE user_id = $1",
      [r.user.id],
    );
    return r.api.post(`/articles/${id}/bookmark/retry-capture`, {
      ...fence(saved.item),
      captureGeneration: saved.item.bookmarkCapture.generation,
    });
  },
  'POST /articles/:id/labels': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Topic'), definition: 'Grant label' }),
      201,
    );
    return r.api.post(`/articles/${await article(r.feedId)}/labels`, {
      ...freshFence,
      labelId: label.label.id,
    });
  },
  'DELETE /articles/:id/labels/:labelId': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Topic'), definition: 'Grant label' }),
      201,
    );
    const id = await article(r.feedId);
    const labelled = await json(
      r.api.post(`/articles/${id}/labels`, { ...freshFence, labelId: label.label.id }),
    );
    return r.api.delete(`/articles/${id}/labels/${label.label.id}`, {
      query: fence(labelled.item),
    });
  },
  'POST /articles/:id/mute-story': async () => {
    const r = await reader();
    return r.api.post(`/articles/${await article(r.feedId)}/mute-story`, { days: 3 });
  },
  'POST /articles/mark-read': async () => {
    const r = await reader();
    const ids = [await article(r.feedId), await article(r.feedId)];
    return r.api.post('/articles/mark-read', {
      targets: ids.map((id) => ({ id, ...freshFence })),
    });
  },
  'POST /articles/rate-bulk': async () => {
    const r = await reader();
    const ids = [await article(r.feedId), await article(r.feedId)];
    return r.api.post('/articles/rate-bulk', {
      targets: ids.map((id) => ({ id, ...freshFence })),
      rating: 1,
    });
  },
  'POST /articles/undo': async () => {
    const r = await reader();
    const read = await json(r.api.post(`/articles/${await article(r.feedId)}/read`, freshFence));
    return r.api.post('/articles/undo', { mutationId: read.mutationId });
  },

  // ── Cards, library, labels (§7) ──
  'POST /cards': async () =>
    (await reader()).api.post('/cards', {
      title: 'Grants',
      interest: unique('Database grants and row-level security'),
      strength: 'love',
    }),
  'POST /cards/from-article': async () => {
    const r = await reader();
    return r.api.post('/cards/from-article', {
      articleId: await article(r.feedId),
      interest: unique('Cards made from articles'),
      strength: 'like',
    });
  },
  'PATCH /cards/:id': async () => {
    const r = await reader();
    const card = await json(
      r.api.post('/cards', { interest: unique('Card to edit'), strength: 'like' }),
      201,
    );
    return r.api.patch(`/cards/${card.card.id}`, {
      interest: unique('Edited card'),
      strength: 'must',
      title: 'Edited',
    });
  },
  'DELETE /cards/:id': async () => {
    const r = await reader();
    const card = await json(
      r.api.post('/cards', { interest: unique('Card to delete'), strength: 'like' }),
      201,
    );
    return r.api.delete(`/cards/${card.card.id}`);
  },
  'POST /cards/:id/examples': async () => {
    const r = await reader();
    const card = await json(
      r.api.post('/cards', { interest: unique('Card with examples'), strength: 'like' }),
      201,
    );
    return r.api.post(`/cards/${card.card.id}/examples`, {
      articleId: await article(r.feedId),
      side: 'yes',
    });
  },
  'POST /cards/:id/examples/remove': async () => {
    const r = await reader();
    const card = await json(
      r.api.post('/cards', { interest: unique('Card losing examples'), strength: 'like' }),
      201,
    );
    const forked = await json(
      r.api.post(`/cards/${card.card.id}/examples`, {
        articleId: await article(r.feedId),
        side: 'no',
      }),
    );
    return r.api.post(`/cards/${forked.card.id}/examples/remove`, {
      side: 'no',
      text: forked.card.examplesNo[0],
    });
  },
  'POST /cards/suggestions/:cardId/dismiss': async () => {
    const r = await reader();
    const entry = await libraryEntry();
    const set = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('suggest', $1, encode(sha256(convert_to($1, 'UTF8')), 'hex'), '{}'::jsonb)
       RETURNING id::text AS id`,
      [`grants-${randomUUID()}`],
    );
    await h.owner.query(
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
       VALUES ($1, $2, $3, 'jev-1', 0.5)`,
      [r.user.id, entry.v1, set.rows[0]!.id],
    );
    return r.api.post(`/cards/suggestions/${entry.v1}/dismiss`);
  },
  'POST /cards/publication-requests/:id/respond': async () => {
    const r = await reader();
    const card = await json(
      r.api.post('/cards', { interest: unique('Publishable interest'), strength: 'like' }),
      201,
    );
    const [request] = await asTenant<{ request_id: string; version: string }>(
      admin.id,
      'SELECT request_id::text, version::text FROM admin_request_card_publication($1, $2::jsonb, NULL)',
      [card.card.id, JSON.stringify({ slug: unique('pub').replace(/\s+/g, '-'), title: 'Pub' })],
    );
    return r.api.post(`/cards/publication-requests/${request!.request_id}/respond`, {
      decision: 'approve',
      expectedVersion: request!.version,
    });
  },
  'POST /library/:id/adopt': async () => {
    const entry = await libraryEntry();
    return (await reader()).api.post(`/library/${entry.v1}/adopt`, { strength: 'like' });
  },
  'POST /library/:id/updates/:newId/apply': async () => {
    const r = await reader();
    const entry = await libraryEntry();
    await json(r.api.post(`/library/${entry.v1}/adopt`, { strength: 'like' }));
    const v2 = await librarySuccessor(entry);
    return r.api.post(`/library/${entry.v1}/updates/${v2}/apply`, {
      expectedCurrentCardId: entry.v1,
    });
  },
  'POST /labels': async () =>
    (await reader()).api.post('/labels', {
      name: unique('Label'),
      definition: 'Articles about grants',
      notFor: 'Grant applications',
      color: '#123456',
    }),
  'PATCH /labels/:id': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Label'), definition: 'Before' }),
      201,
    );
    return r.api.patch(`/labels/${label.label.id}`, {
      definition: unique('After'),
      color: '#abcdef',
    });
  },
  'DELETE /labels/:id': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Label'), definition: 'Doomed' }),
      201,
    );
    return r.api.delete(`/labels/${label.label.id}`);
  },
  'POST /labels/:id/examples': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Label'), definition: 'Examples' }),
      201,
    );
    return r.api.post(`/labels/${label.label.id}/examples`, {
      articleId: await article(r.feedId),
      side: 'yes',
    });
  },
  'POST /labels/:id/examples/remove': async () => {
    const r = await reader();
    const label = await json(
      r.api.post('/labels', { name: unique('Label'), definition: 'Examples' }),
      201,
    );
    const forked = await json(
      r.api.post(`/labels/${label.label.id}/examples`, {
        articleId: await article(r.feedId),
        side: 'yes',
      }),
    );
    return r.api.post(`/labels/${forked.label.id}/examples/remove`, {
      side: 'yes',
      text: forked.label.examplesYes[0],
    });
  },

  // ── Rules (§8) ──
  'POST /rules': async () =>
    (await reader()).api.post('/rules', { kind: 'block_domain', value: 'grants.example.com' }),
  'DELETE /rules/:id': async () => {
    const r = await reader();
    const rule = await json(r.api.post('/rules', { kind: 'mute_keyword', value: 'doomed' }), 201);
    return r.api.delete(`/rules/${rule.rule.id}`);
  },

  // ── Admin (§9) ──
  'PATCH /admin/settings': async () =>
    adminApi.patch('/admin/settings', { 'engine.llm_daily_cap': 42 }),
  'POST /admin/translations/reprocess': async () =>
    adminApi.post('/admin/translations/reprocess', { reasons: ['cap'] }),
  'POST /admin/engine/reset-breaker': async () =>
    adminApi.post('/admin/engine/reset-breaker', { engine: 'typesafe' }),
  'PUT /admin/engine/credentials/:provider': async () => {
    await h.owner.query('DELETE FROM provider_credentials');
    return adminApi.put('/admin/engine/credentials/typesafe', {
      apiKey: 'sk-test-secret',
      expectedRevision: '0',
    });
  },
  'POST /admin/engine/credentials/:provider/validate': async () => {
    const { revision, version } = await stagedCredential();
    return adminApi.post('/admin/engine/credentials/ollama/validate', {
      candidateVersion: version,
      expectedRevision: revision,
    });
  },
  'POST /admin/engine/credentials/:provider/activate': async () => {
    const { revision, version } = await stagedCredential();
    await h.owner.query(
      `UPDATE provider_credentials SET candidate_status = 'valid', validated_at = now(),
              candidate_validation = '{"model":"m","concurrencyLimit":1,"capabilities":{}}'
        WHERE provider = 'ollama'`,
    );
    return adminApi.post('/admin/engine/credentials/ollama/activate', {
      candidateVersion: version,
      expectedRevision: revision,
    });
  },
  'DELETE /admin/engine/credentials/:provider': async () => {
    const { revision } = await stagedCredential();
    return adminApi.delete('/admin/engine/credentials/ollama', {
      query: { expectedRevision: revision },
    });
  },
  'PATCH /admin/feeds/:id': async () => {
    const feed = await createFeed(h.owner);
    return adminApi.patch(`/admin/feeds/${feed.id}`, { fetchOptions: { userAgent: 'GrantBot/1' } });
  },
  'POST /admin/feeds/:id/reset': async () => {
    const feed = await createFeed(h.owner, { status: 'dead' });
    return adminApi.post(`/admin/feeds/${feed.id}/reset`);
  },
  'PATCH /admin/users/:id': async () => {
    const user = await createUser(h.owner);
    return adminApi.patch(`/admin/users/${user.id}`, { plan: 'admin', invitesLeft: 7 });
  },
  'POST /admin/invites': async () => adminApi.post('/admin/invites', { count: 2, note: 'grants' }),
  'POST /admin/waitlist/:id/invite': async () => {
    const entry = await h.owner.query<{ id: string }>(
      "INSERT INTO waitlist (email, locale) VALUES ($1, 'en') RETURNING id::text AS id",
      [`waitlisted-${randomUUID()}@example.test`],
    );
    return adminApi.post(`/admin/waitlist/${entry.rows[0]!.id}/invite`);
  },
  'POST /admin/library/promotion-requests': async () => {
    const creator = await createUser(h.owner);
    return adminApi.post('/admin/library/promotion-requests', {
      cardId: await popularSharedCard(creator.id),
      title: 'Promotable',
      topicIds: [TOPIC],
    });
  },
  'POST /admin/library/promote': async () => {
    const creator = await createUser(h.owner, { lastActiveAt: new Date(Date.now() - 800 * HOUR) });
    const request = await json(
      adminApi.post('/admin/library/promotion-requests', {
        cardId: await popularSharedCard(creator.id),
        title: 'Promoted',
        topicIds: [TOPIC],
      }),
      201,
    );
    return adminApi.post('/admin/library/promote', {
      requestId: request.request.id,
      expectedVersion: request.request.version,
    });
  },
  'POST /admin/library': async () =>
    adminApi.post('/admin/library', {
      slug: unique('grants-library').replace(/\s+/g, '-'),
      title: 'Grants library',
      interest: unique('Library administration'),
      topicIds: [TOPIC],
    }),
  'PATCH /admin/library/:id': async () => {
    const created = await json(
      adminApi.post('/admin/library', {
        slug: unique('grants-edit').replace(/\s+/g, '-'),
        title: 'Before',
        interest: unique('Library to edit'),
        topicIds: [TOPIC],
      }),
      201,
    );
    return adminApi.patch(`/admin/library/${created.card.cardId}`, { title: 'After' });
  },
  'POST /admin/ops-event': async () =>
    h.server.inject({
      method: 'POST',
      url: '/api/v1/admin/ops-event',
      headers: {
        authorization: `Bearer ${TEST_METRICS_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ kind: 'backup_ok', detail: 'grants' }),
    }),
};

beforeAll(async () => {
  h = await createApiHarness({
    discoverDeps: web.deps(),
    env: { PROVIDER_MASTER_KEY_ID: KEY_ID, PROVIDER_MASTER_KEYS: KEYS },
  });
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  adminApi = apiClient(h.server, admin);
  doc = (await apiClient(h.server).get('/openapi.json')).json() as OpenAPIV3.Document;
  await h.owner.query(
    `INSERT INTO topics (id, parent_id, level, name_en, name_sk, description)
     VALUES ($1, NULL, 1, 'Grants', 'Grants', 'Topic for grant tests')`,
    [TOPIC],
  );
  // Selected training needs the classification question sets (spec 05 §2).
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );
});

afterAll(async () => {
  await h.close();
});

const mutations = () =>
  listOperations(doc)
    .filter((op) => op.method !== 'GET')
    .map(operationKey);

describe('write-path grants (spec 08 §12)', () => {
  it('the server connects as bantoozi_app', async () => {
    const role = await h.appPool.query<{ user: string }>('SELECT current_user AS user');
    expect(role.rows[0]!.user).toBe('bantoozi_app');
  });

  it('has a case for every mutation operation of the OpenAPI document, and no other', () => {
    expect(Object.keys(CASES).sort()).toEqual(mutations());
  });

  for (const [operation, run] of Object.entries(CASES)) {
    it(`${operation} succeeds as bantoozi_app`, async () => {
      const res = await run();
      expect(res.statusCode, `${operation}: ${res.body}`).toBeGreaterThanOrEqual(200);
      expect(res.statusCode, `${operation}: ${res.body}`).toBeLessThan(300);
    });
  }
});

describe('CSRF on every mutation (spec 08 §1, §12)', () => {
  it('refuses each mutation without X-Bantoozi-Client with 403, before validation', async () => {
    const user = await createTestUser(h, { role: 'admin', plan: 'admin' });
    for (const operation of mutations()) {
      const [method, path] = operation.split(' ') as [string, string];
      const res = await h.server.inject({
        method: method as 'POST',
        url: `/api/v1${path.replace(/:\w+/g, '1')}`,
        headers: { cookie: user.cookie, 'idempotency-key': randomUUID() },
        payload: {},
      });
      expect(res.statusCode, operation).toBe(403);
      expect(res.json().error.code, operation).toBe('FORBIDDEN');
    }
  });
});
