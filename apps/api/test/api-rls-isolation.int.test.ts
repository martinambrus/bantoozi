import { randomUUID } from 'node:crypto';

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

import { FixtureWeb } from './support/fixture-web.js';
import {
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
 * M4-T11 RLS isolation and cross-user writes (spec 08 §12). User B owns a full set of private data —
 * a private feed and articles, reader state on an article both users can read (rating, label,
 * bookmark with a retained snapshot), a subscription title override and folder, a private fork of a
 * shared card that user A also holds, labels, rules (including a muted story), a selected analysis
 * request, sessions, an invite, a publication request addressed to B, a card suggestion, a library
 * update offer and a remembered feed image policy — all created through B's own API calls where an
 * endpoint exists. Then:
 *
 * 1. user A calls **every** non-admin GET operation of the OpenAPI document (enumerated at runtime;
 *    admin GETs are called too and must be 403), with path parameters and filters filled with B's
 *    ids, and no response body contains anything of B's: the marker word in B's texts, B's email,
 *    user id, session ids, invite code or any id only B can hold (id sequences are offset per table,
 *    so a quoted id cannot collide with another table's);
 * 2. user A calls **every** mutation operation with B's ids: foreign path/body ids are `404` (body
 *    references may be `400` as invalid nested ids), admin operations `403`, and operations that take
 *    no foreign id act only on A; afterwards a digest of every B-owned row is unchanged.
 */

const MARK = 'bzleakb';

let h: ApiHarness;
const web = new FixtureWeb();
let doc: OpenAPIV3.Document;

let a: TestUser;
let aApi: ApiClient;
let b: TestUser;
let bApi: ApiClient;

/** B's ids and secrets; `foreign` lists every value that must never reach A. */
const B = {
  sessions: [] as string[],
  sharedFeed: '',
  privateFeed: '',
  privateFeedUrl: `https://${MARK}.example.test/feed.xml`,
  sharedArticle: '',
  privateArticles: [] as string[],
  sharedCard: '',
  fork: '',
  privateCard: '',
  label: '',
  rules: [] as string[],
  cluster: '',
  analysisRequest: '',
  invite: '',
  publicationRequest: '',
  snapshots: [] as string[],
  ratingMutation: '',
  suggestedCard: '',
  library: { v1: '', v2: '' },
  foreign: [] as string[],
};

const freshFence = { stateVersion: '0', contentRevision: '1' };

async function json(res: Promise<LightMyRequestResponse>, status = 200) {
  const awaited = await res;
  expect(awaited.statusCode, awaited.body).toBe(status);
  return awaited.json();
}

/** Offset every id sequence into its own range, so ids of different tables never coincide. */
async function separateIdRanges(): Promise<void> {
  const seqs = await h.owner.query<{ name: string }>(
    "SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1",
  );
  for (const [i, seq] of seqs.rows.entries()) {
    await h.owner.query('SELECT setval($1::regclass, $2)', [seq.name, (i + 1) * 1_000_000_000]);
  }
}

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

async function libraryVersion(slug: string, version: number, previous: string | null) {
  if (previous !== null) {
    await h.owner.query('UPDATE interest_cards SET slug = NULL WHERE id = $1', [previous]);
  }
  const card = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    slug,
    title: 'Isolation library card',
    interest: `Library interest ${slug} v${version}`,
  });
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, $2, $3, $4)`,
    [slug, version, card.id, previous],
  );
  return card.id;
}

/** Every row B owns, as one canonical JSON text. */
async function bDigest(): Promise<string> {
  const result = await h.owner.query<{ digest: string }>(
    `SELECT jsonb_build_object(
       'user', (SELECT to_jsonb(u) FROM users u WHERE u.id = $1),
       'subscriptions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.feed_id) FROM subscriptions s WHERE s.user_id = $1),
       'preferences', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.feed_id) FROM user_feed_preferences p WHERE p.user_id = $1),
       'cards', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.card_id) FROM user_cards c WHERE c.user_id = $1),
       'labels', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.card_id) FROM user_labels l WHERE l.user_id = $1),
       'rules', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM user_rules r WHERE r.user_id = $1),
       'reader', (SELECT jsonb_agg(to_jsonb(ua) ORDER BY ua.article_id) FROM user_article ua WHERE ua.user_id = $1),
       'sessions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM sessions s WHERE s.user_id = $1),
       'invites', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.code) FROM invites i WHERE i.created_by = $1),
       'analysis', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM analysis_requests r WHERE r.user_id = $1),
       'suggestions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.card_id) FROM card_suggestions s WHERE s.user_id = $1),
       'publication', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM card_publication_requests p WHERE p.user_id = $1),
       'forks', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM interest_cards c WHERE c.owner_user_id = $1),
       'events', (SELECT count(*) FROM feedback_events e WHERE e.user_id = $1),
       'receipts', (SELECT count(*) FROM api_mutations m WHERE m.user_id = $1),
       'snapshots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM article_snapshots s WHERE s.id = ANY($2::bigint[]))
     )::text AS digest`,
    [b.id, B.snapshots],
  );
  return result.rows[0]!.digest;
}

/** Fails when `body` contains the marker word or any of B's private values. */
function expectNoLeak(context: string, body: string) {
  expect(body.toLowerCase(), context).not.toContain(MARK);
  for (const value of B.foreign) {
    expect(
      body.includes(`"${value}"`) || (value.length > 12 && body.includes(value)),
      `${context} leaks ${value}`,
    ).toBe(false);
  }
}

beforeAll(async () => {
  h = await createApiHarness({ discoverDeps: web.deps() });
  await separateIdRanges();
  doc = (await apiClient(h.server).get('/openapi.json')).json() as OpenAPIV3.Document;
  const versions = {} as Record<QuestionSetKind, string>;
  for (const kind of QUESTION_SET_KINDS) versions[kind] = LATEST_QUESTION_SETS[kind].version;
  await createDatabase(h.owner).transaction((tx) =>
    seedQuestionSets(tx, ALL_QUESTION_SETS, versions),
  );

  a = await createTestUser(h);
  aApi = apiClient(h.server, a);
  b = await createTestUser(h, { email: `${MARK}-owner@example.test` });
  bApi = apiClient(h.server, b);
  B.sessions.push(b.sessionId, (await createTestSession(h, b)).sessionId);
  await h.owner.query('UPDATE users SET invites_left = 2 WHERE id = $1', [b.id]);
  await h.owner.query('UPDATE users SET invites_left = 0 WHERE id = $1', [a.id]);
  await json(
    bApi.patch('/me', {
      displayName: `${MARK} display name`,
      preferences: { folderOrder: [`${MARK} folder`] },
    }),
  );

  // Feeds: one both read, one only B reads.
  const shared = await createFeed(h.owner, { title: 'Shared feed' });
  B.sharedFeed = shared.id;
  const priv = await createFeed(h.owner, { url: B.privateFeedUrl, title: `${MARK} private feed` });
  B.privateFeed = priv.id;
  for (const user of [a, b]) {
    await createSubscription(h.owner, { userId: user.id, feedId: shared.id, mode: 'active' });
  }
  await createSubscription(h.owner, { userId: b.id, feedId: priv.id, mode: 'active' });
  await json(
    bApi.patch(`/subscriptions/${shared.id}`, {
      titleOverride: `${MARK} override`,
      folder: `${MARK} folder`,
    }),
  );
  await json(bApi.put(`/feed-preferences/${priv.id}`, { imagePolicy: 'allow' }));

  B.sharedArticle = (
    await createArticle(h.owner, { feedIds: [shared.id], title: 'Shared story' })
  ).id;
  for (const n of [1, 2]) {
    const article = await createArticle(h.owner, {
      feedIds: [priv.id],
      title: `${MARK} private story ${n}`,
      url: `https://${MARK}.example.test/story-${n}`,
      excerpt: `${MARK} private excerpt ${n}`,
    });
    B.privateArticles.push(article.id);
  }
  const [p1, p2] = B.privateArticles as [string, string];

  // Reader state on the shared article and a private one.
  const label = await json(
    bApi.post('/labels', { name: `${MARK} label`, definition: `${MARK} label definition` }),
    201,
  );
  B.label = label.label.id;
  const rated = await json(
    bApi.post(`/articles/${B.sharedArticle}/rating`, {
      ...freshFence,
      rating: -1,
      reason: 'other',
    }),
  );
  B.ratingMutation = rated.mutationId;
  const labelled = await json(
    bApi.post(`/articles/${B.sharedArticle}/labels`, {
      stateVersion: rated.item.stateVersion,
      contentRevision: '1',
      labelId: B.label,
    }),
  );
  const savedShared = await json(
    bApi.post(`/articles/${B.sharedArticle}/bookmark`, {
      stateVersion: labelled.item.stateVersion,
      contentRevision: '1',
    }),
  );
  const savedPrivate = await json(bApi.post(`/articles/${p1}/bookmark`, freshFence));
  B.snapshots = [
    savedShared.item.bookmarkCapture.snapshotId,
    savedPrivate.item.bookmarkCapture.snapshotId,
  ];
  // The private snapshot retains B's text (from the article), which must never reach A.
  const retained = await h.owner.query<{ text: string }>(
    'SELECT body_text AS text FROM article_snapshots WHERE id = $1',
    [B.snapshots[1]],
  );
  expect(retained.rows[0]!.text).toContain(MARK);

  // A shared card both hold; B's private fork of it carries B's article title as an example.
  const sharedInterest = `Grid-scale battery storage ${randomUUID().slice(0, 6)}`;
  B.sharedCard = (
    await json(bApi.post('/cards', { interest: sharedInterest, strength: 'like' }), 201)
  ).card.id;
  const aShared = await json(
    aApi.post('/cards', { interest: sharedInterest, strength: 'like' }),
    201,
  );
  expect(aShared.card.id).toBe(B.sharedCard);
  const forked = await json(
    bApi.post(`/cards/${B.sharedCard}/examples`, { articleId: p1, side: 'yes' }),
  );
  B.fork = forked.card.id;
  expect(B.fork).not.toBe(B.sharedCard);
  B.privateCard = (
    await json(
      bApi.post('/cards', {
        title: `${MARK} card`,
        interest: `${MARK} secret interest`,
        strength: 'must',
      }),
      201,
    )
  ).card.id;

  // Rules, including a muted story (which creates the story's cluster).
  B.rules.push(
    (await json(bApi.post('/rules', { kind: 'mute_keyword', value: `${MARK}keyword` }), 201)).rule
      .id,
    (await json(bApi.post('/rules', { kind: 'block_feed', value: priv.id }), 201)).rule.id,
  );
  const muted = await json(bApi.post(`/articles/${p2}/mute-story`, { days: 7 }), 201);
  B.rules.push(muted.rule.id);
  B.cluster = muted.rule.value;

  // A selected analysis request on B's private feed.
  const analyzed = await json(
    bApi.post(`/subscriptions/${priv.id}/analyze`, {
      articles: [{ id: p2, contentRevision: '1' }],
      expectedInferenceVersion: '1',
    }),
    202,
  );
  B.analysisRequest = analyzed.requests[0].id;

  // An invite B sent, a publication request addressed to B, a suggestion and a library update.
  const invite = await json(
    bApi.post('/invites', { email: `${MARK}-friend@example.test`, note: `${MARK} note` }),
    201,
  );
  B.invite = invite.code;
  const admin = await createUser(h.owner, { role: 'admin' });
  const [request] = await asTenant<{ request_id: string }>(
    admin.id,
    'SELECT request_id::text FROM admin_request_card_publication($1, $2::jsonb, NULL)',
    [B.privateCard, JSON.stringify({ slug: `${MARK}-slug`, title: `${MARK} proposed title` })],
  );
  B.publicationRequest = request!.request_id;
  const slug = `isolation-${randomUUID().slice(0, 8)}`;
  B.library.v1 = await libraryVersion(slug, 1, null);
  await json(bApi.post(`/library/${B.library.v1}/adopt`, { strength: 'love' }));
  B.library.v2 = await libraryVersion(slug, 2, B.library.v1);
  B.suggestedCard = await libraryVersion(`suggested-${slug}`, 1, null);
  const set = await h.owner.query<{ id: string }>(
    `INSERT INTO question_sets (kind, version, sha256, definition)
     VALUES ('suggest', 'isolation', encode(sha256(convert_to('isolation', 'UTF8')), 'hex'), '{}')
     RETURNING id::text AS id`,
  );
  await h.owner.query(
    `INSERT INTO settings (key, value) VALUES ('engine.model_pin', '{"model":"jev-1"}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  await h.owner.query(
    `UPDATE settings SET value = jsonb_set(value, '{suggest}', to_jsonb($1::text))
      WHERE key = 'question_sets.active'`,
    [set.rows[0]!.id],
  );
  await h.owner.query(
    `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
     VALUES ($1, $2, $3, 'jev-1', 0.9)`,
    [b.id, B.suggestedCard, set.rows[0]!.id],
  );

  // B can see all of it (the fixtures are real).
  expect((await json(bApi.get('/cards/suggestions'))).length).toBe(1);
  expect((await json(bApi.get('/library/updates'))).length).toBe(1);
  expect((await json(bApi.get('/cards/publication-requests'))).length).toBe(1);

  B.foreign = [
    b.id,
    b.email,
    ...B.sessions,
    B.privateFeed,
    B.privateFeedUrl,
    ...B.privateArticles,
    B.fork,
    B.privateCard,
    B.label,
    ...B.rules,
    B.cluster,
    B.analysisRequest,
    B.invite,
    B.publicationRequest,
    ...B.snapshots,
    B.ratingMutation,
  ];
  // Nothing addressed to B may surface through the test-only last-email route either.
  h.mailer.sent.length = 0;
});

afterAll(async () => {
  await h.close();
});

/** GET requests for one operation, with path parameters and filters set to B's ids. */
function getRequests(path: string): { url: string; query?: Record<string, string> }[] {
  const [p1] = B.privateArticles as [string];
  switch (path) {
    case '/analysis-requests/:id':
      return [{ url: `/analysis-requests/${B.analysisRequest}` }];
    case '/articles/:id':
      return [
        { url: `/articles/${p1}` },
        { url: `/articles/${p1}`, query: { view: 'saved' } },
        { url: `/articles/${B.sharedArticle}` },
        { url: `/articles/${B.sharedArticle}`, query: { view: 'saved' } },
        { url: `/articles/${B.sharedArticle}`, query: { sourceFeedId: B.privateFeed } },
      ];
    case '/articles':
      return [
        ...['for_you', 'maybe', 'everything', 'new', 'all', 'bookmarks', 'hidden'].map((lane) => ({
          url: '/articles',
          query: { lane, status: 'all' },
        })),
        { url: '/articles', query: { lane: 'all', feedId: B.privateFeed } },
        { url: '/articles', query: { lane: 'all', labelId: B.label } },
        { url: '/articles', query: { lane: 'all', folder: `${MARK} folder` } },
      ];
    case '/articles/counts':
      return [
        { url: '/articles/counts', query: { status: 'all' } },
        { url: '/articles/counts', query: { feedId: B.privateFeed } },
        { url: '/articles/counts', query: { labelId: B.label } },
        { url: '/articles/counts', query: { folder: `${MARK} folder` } },
      ];
    case '/library':
      return [{ url: '/library' }, { url: '/library', query: { q: MARK } }];
    default:
      if (path.includes(':')) throw new Error(`no B ids for GET ${path}: extend getRequests`);
      return [{ url: path }];
  }
}

describe('every GET operation as A leaks nothing of B (spec 08 §12)', () => {
  it('control: the leak probe finds B data in what B itself reads', async () => {
    for (const url of [
      '/me/export',
      '/cards',
      '/rules',
      '/auth/sessions',
      `/analysis-requests/${B.analysisRequest}`,
    ]) {
      const res = await bApi.get(url);
      expect(res.statusCode, url).toBe(200);
      expect(() => expectNoLeak(url, res.body), url).toThrow();
    }
  });

  it('sweeps the OpenAPI GET operations with B ids', async () => {
    const gets = listOperations(doc).filter((op) => op.method === 'GET');
    expect(gets.length).toBeGreaterThan(30);
    const seen: string[] = [];
    for (const op of gets) {
      for (const request of getRequests(op.path)) {
        const res = await aApi.get(
          request.url,
          request.query === undefined ? {} : { query: request.query },
        );
        const context = `${operationKey(op)} ${JSON.stringify(request.query ?? {})} → ${res.statusCode}`;
        expect(res.statusCode, context).toBeLessThan(500);
        if (op.path.startsWith('/admin/') || op.path === '/metrics') {
          expect(res.statusCode, context).toBe(403);
        }
        expectNoLeak(context, res.body);
        seen.push(operationKey(op));
      }
    }
    expect(new Set(seen)).toEqual(new Set(gets.map(operationKey)));
  });

  it("B's private ids are 404 for A; the shared article shows only A's own state", async () => {
    const [p1] = B.privateArticles as [string];
    for (const url of [`/articles/${p1}`, `/analysis-requests/${B.analysisRequest}`]) {
      expect((await aApi.get(url)).statusCode, url).toBe(404);
    }
    expect(
      (await aApi.get(`/articles/${B.sharedArticle}`, { query: { view: 'saved' } })).statusCode,
    ).toBe(404);
    const detail = await json(aApi.get(`/articles/${B.sharedArticle}`));
    expect(detail).toMatchObject({
      rating: null,
      reason: null,
      labelIds: [],
      bookmarkedAt: null,
      bookmarkCapture: null,
      bookmarkSnapshot: null,
      stateVersion: '0',
      feed: { id: B.sharedFeed, title: 'Shared feed' },
    });
    const list = await json(aApi.get('/articles', { query: { lane: 'all' } }));
    expect(list.items.map((item: { id: string }) => item.id)).toEqual([B.sharedArticle]);
    const bookmarks = await json(aApi.get('/articles', { query: { lane: 'bookmarks' } }));
    expect(bookmarks.items).toEqual([]);
    const counts = await json(aApi.get('/articles/counts', { query: { status: 'all' } }));
    expect(counts).toMatchObject({ bookmarks: 0, total: 1 });
  });

  it("A's lists hold only A's rows: cards without B's fork, no labels/rules/sessions/invites of B", async () => {
    const cards = await json(aApi.get('/cards'));
    expect(cards).toEqual([
      expect.objectContaining({ id: B.sharedCard, examplesYes: [], examplesNo: [] }),
    ]);
    expect(await json(aApi.get('/labels'))).toEqual([]);
    expect(await json(aApi.get('/rules'))).toEqual([]);
    expect(await json(aApi.get('/feed-preferences'))).toEqual([]);
    expect(await json(aApi.get('/cards/suggestions'))).toEqual([]);
    expect(await json(aApi.get('/cards/publication-requests'))).toEqual([]);
    expect(await json(aApi.get('/library/updates'))).toEqual([]);
    expect((await json(aApi.get('/invites'))).items).toEqual([]);
    const sessions = await json(aApi.get('/auth/sessions'));
    expect(sessions.map((s: { id: string }) => s.id)).toEqual([a.sessionId]);
    const subscriptions = await json(aApi.get('/subscriptions'));
    expect(subscriptions).toEqual([
      expect.objectContaining({
        titleOverride: null,
        folder: null,
        feed: expect.objectContaining({ id: B.sharedFeed }),
      }),
    ]);
  });

  it("the export and OPML contain A's data only", async () => {
    const exported = await aApi.get('/me/export');
    expect(exported.statusCode).toBe(200);
    const body = exported.json();
    expect(body.user.id).toBe(a.id);
    expect(body.subscriptions).toHaveLength(1);
    expect(body.cards).toHaveLength(1);
    expect(body.labels).toEqual([]);
    expect(body.rules).toEqual([]);
    expect(body.ratings).toEqual([]);
    expect(body.bookmarks).toEqual([]);
    expectNoLeak('GET /me/export', exported.body);
    const opml = await aApi.get('/subscriptions/export-opml');
    expect(opml.statusCode).toBe(200);
    expect(opml.body).toContain('Shared feed');
    expectNoLeak('GET /subscriptions/export-opml', opml.body);
  });
});

type Attempt = () => Promise<LightMyRequestResponse>;

/**
 * A's attempts per mutation operation and the statuses each may answer. `own` marks operations
 * without a foreign-id input (they act on A only; B's digest proves it).
 */
function crossUserCases(): Record<string, { attempts: Attempt[]; statuses: number[]; own?: true }> {
  const [p1, p2] = B.privateArticles as [string, string];
  const anon = apiClient(h.server);
  const shared = B.sharedArticle;
  const notFound = (...attempts: Attempt[]) => ({ attempts, statuses: [404] });
  const invalidOrNotFound = (...attempts: Attempt[]) => ({ attempts, statuses: [400, 404] });
  const forbidden = (...attempts: Attempt[]) => ({ attempts, statuses: [403] });
  return {
    'POST /auth/request-code': {
      attempts: [() => anon.post('/auth/request-code', { email: b.email })],
      statuses: [202],
      own: true,
    },
    'POST /auth/verify': {
      attempts: [() => anon.post('/auth/verify', { email: b.email, code: '000000' })],
      statuses: [400],
    },
    'POST /auth/logout': {
      attempts: [
        async () => apiClient(h.server, await createTestSession(h, a)).post('/auth/logout'),
      ],
      statuses: [204],
      own: true,
    },
    'DELETE /auth/sessions/:id': notFound(
      ...B.sessions.map((id) => () => aApi.delete(`/auth/sessions/${id}`)),
    ),
    'POST /invites': {
      attempts: [() => aApi.post('/invites', { email: b.email })],
      statuses: [409],
      own: true,
    },
    'POST /waitlist': {
      attempts: [() => anon.post('/waitlist', { email: b.email })],
      statuses: [202],
      own: true,
    },
    'PATCH /me': {
      attempts: [() => aApi.patch('/me', { displayName: 'A only' })],
      statuses: [200],
      own: true,
    },
    'DELETE /me': {
      attempts: [async () => apiClient(h.server, await createTestUser(h)).delete('/me')],
      statuses: [204],
      own: true,
    },
    'POST /subscriptions': {
      // B's private feed URL is not served by the offline web: discovery fails before anything.
      attempts: [
        () => aApi.post('/subscriptions', { url: `https://${MARK}.example.test/other.xml` }),
      ],
      statuses: [422],
      own: true,
    },
    'PATCH /subscriptions/:feedId': notFound(() =>
      aApi.patch(`/subscriptions/${B.privateFeed}`, { folder: 'Hijacked' }),
    ),
    'DELETE /subscriptions/:feedId': notFound(() => aApi.delete(`/subscriptions/${B.privateFeed}`)),
    'POST /subscriptions/:feedId/inference': notFound(() =>
      aApi.post(`/subscriptions/${B.privateFeed}/inference`, { mode: 'off', expectedVersion: '1' }),
    ),
    'POST /subscriptions/:feedId/analyze': notFound(() =>
      aApi.post(`/subscriptions/${B.privateFeed}/analyze`, {
        articles: [{ id: p1, contentRevision: '1' }],
        expectedInferenceVersion: '1',
        startTraining: true,
      }),
    ),
    'PUT /feed-preferences/:feedId': notFound(() =>
      aApi.put(`/feed-preferences/${B.privateFeed}`, { imagePolicy: 'block' }),
    ),
    'POST /subscriptions/import-opml': {
      attempts: [
        () => {
          const { payload, headers } = opmlUpload(opmlOf(['https://a-only.example.test/feed.xml']));
          return aApi.post('/subscriptions/import-opml', payload, { headers });
        },
      ],
      statuses: [200],
      own: true,
    },
    'POST /subscriptions/folders/rename': {
      attempts: [
        async () => {
          const res = await aApi.post('/subscriptions/folders/rename', {
            from: `${MARK} folder`,
            to: 'Hijacked',
          });
          expect(res.json()).toEqual({ count: 0 });
          return res;
        },
      ],
      statuses: [200],
      own: true,
    },
    'POST /subscriptions/:feedId/mark-read': notFound(() =>
      aApi.post(`/subscriptions/${B.privateFeed}/mark-read`, {
        olderThan: new Date().toISOString(),
        datasetVersion: 'x',
      }),
    ),
    'POST /articles/:id/read': notFound(() => aApi.post(`/articles/${p1}/read`, freshFence)),
    'POST /articles/:id/unread': notFound(() => aApi.post(`/articles/${p1}/unread`, freshFence)),
    'POST /articles/:id/unhide': notFound(() => aApi.post(`/articles/${p1}/unhide`, freshFence)),
    'POST /articles/:id/open': notFound(() => aApi.post(`/articles/${p1}/open`, freshFence)),
    'POST /articles/:id/dwell': notFound(() =>
      aApi.post(`/articles/${p1}/dwell`, { ...freshFence, ms: 1000 }),
    ),
    'POST /articles/:id/rating': {
      attempts: [
        () => aApi.post(`/articles/${p1}/rating`, { ...freshFence, rating: 1 }),
        // B's analysis request cannot carry A's feedback.
        () =>
          aApi.post(`/articles/${p2}/rating`, {
            ...freshFence,
            rating: 1,
            analysisRequestId: B.analysisRequest,
          }),
      ],
      statuses: [404],
    },
    'POST /articles/:id/prompt-answer': notFound(() =>
      aApi.post(`/articles/${p1}/prompt-answer`, { ...freshFence, liked: true }),
    ),
    'POST /articles/:id/bookmark': {
      attempts: [
        () => aApi.post(`/articles/${p1}/bookmark`, freshFence),
        () =>
          aApi.post(`/articles/${shared}/bookmark`, {
            ...freshFence,
            mediaPolicyFeedId: B.privateFeed,
          }),
      ],
      statuses: [400, 404],
    },
    'DELETE /articles/:id/bookmark': notFound(() =>
      aApi.delete(`/articles/${p1}/bookmark`, { query: freshFence }),
    ),
    'POST /articles/:id/bookmark/retry-capture': notFound(() =>
      aApi.post(`/articles/${p1}/bookmark/retry-capture`, {
        ...freshFence,
        captureGeneration: '1',
      }),
    ),
    'POST /articles/:id/labels': notFound(
      () => aApi.post(`/articles/${shared}/labels`, { ...freshFence, labelId: B.label }),
      () => aApi.post(`/articles/${p1}/labels`, { ...freshFence, labelId: B.label }),
    ),
    'DELETE /articles/:id/labels/:labelId': notFound(() =>
      aApi.delete(`/articles/${shared}/labels/${B.label}`, { query: freshFence }),
    ),
    'POST /articles/:id/mute-story': notFound(() =>
      aApi.post(`/articles/${p2}/mute-story`, { days: 1 }),
    ),
    'POST /articles/mark-read': notFound(() =>
      aApi.post('/articles/mark-read', {
        targets: [
          { id: shared, ...freshFence },
          { id: p1, ...freshFence },
        ],
      }),
    ),
    'POST /articles/rate-bulk': notFound(() =>
      aApi.post('/articles/rate-bulk', {
        targets: [
          { id: shared, ...freshFence },
          { id: p1, ...freshFence },
        ],
        rating: -1,
      }),
    ),
    'POST /articles/undo': notFound(() =>
      aApi.post('/articles/undo', { mutationId: B.ratingMutation }),
    ),
    'POST /cards': invalidOrNotFound(() =>
      aApi.post('/cards', {
        interest: 'Scoped elsewhere',
        strength: 'like',
        scopeFeedId: B.privateFeed,
      }),
    ),
    'POST /cards/from-article': notFound(() =>
      aApi.post('/cards/from-article', {
        articleId: p1,
        interest: 'Stolen example',
        strength: 'like',
      }),
    ),
    'PATCH /cards/:id': notFound(
      () => aApi.patch(`/cards/${B.fork}`, { strength: 'never' }),
      () => aApi.patch(`/cards/${B.privateCard}`, { title: 'Hijacked' }),
    ),
    'DELETE /cards/:id': notFound(
      () => aApi.delete(`/cards/${B.fork}`),
      () => aApi.delete(`/cards/${B.privateCard}`),
    ),
    'POST /cards/:id/examples': notFound(
      () => aApi.post(`/cards/${B.fork}/examples`, { articleId: shared, side: 'yes' }),
      () => aApi.post(`/cards/${B.sharedCard}/examples`, { articleId: p1, side: 'yes' }),
    ),
    'POST /cards/:id/examples/remove': notFound(() =>
      aApi.post(`/cards/${B.fork}/examples/remove`, {
        side: 'yes',
        text: `${MARK} private story 1`,
      }),
    ),
    'POST /cards/suggestions/:cardId/dismiss': notFound(() =>
      aApi.post(`/cards/suggestions/${B.suggestedCard}/dismiss`),
    ),
    'POST /cards/publication-requests/:id/respond': notFound(() =>
      aApi.post(`/cards/publication-requests/${B.publicationRequest}/respond`, {
        decision: 'decline',
        expectedVersion: '1',
      }),
    ),
    'POST /library/:id/adopt': invalidOrNotFound(() =>
      aApi.post(`/library/${B.library.v2}/adopt`, { strength: 'like', scopeFeedId: B.privateFeed }),
    ),
    'POST /library/:id/updates/:newId/apply': notFound(() =>
      aApi.post(`/library/${B.library.v1}/updates/${B.library.v2}/apply`, {
        expectedCurrentCardId: B.library.v1,
      }),
    ),
    'POST /labels': {
      attempts: [() => aApi.post('/labels', { name: 'A label', definition: 'Only for A' })],
      statuses: [201],
      own: true,
    },
    'PATCH /labels/:id': notFound(() => aApi.patch(`/labels/${B.label}`, { name: 'Hijacked' })),
    'DELETE /labels/:id': notFound(() => aApi.delete(`/labels/${B.label}`)),
    'POST /labels/:id/examples': notFound(() =>
      aApi.post(`/labels/${B.label}/examples`, { articleId: shared, side: 'yes' }),
    ),
    'POST /labels/:id/examples/remove': notFound(() =>
      aApi.post(`/labels/${B.label}/examples/remove`, { side: 'yes', text: 'x' }),
    ),
    'POST /rules': invalidOrNotFound(
      () => aApi.post('/rules', { kind: 'block_feed', value: B.privateFeed }),
      () => aApi.post('/rules', { kind: 'mute_story', value: B.cluster, expiresInDays: 1 }),
    ),
    'DELETE /rules/:id': notFound(...B.rules.map((id) => () => aApi.delete(`/rules/${id}`))),
    'POST /admin/ops-event': {
      // A browser session is not the bearer: refused, never stored.
      attempts: [() => aApi.post('/admin/ops-event', { kind: 'backup_ok' })],
      statuses: [401, 403],
    },
    'PATCH /admin/settings': forbidden(() =>
      aApi.patch('/admin/settings', { signup_mode: 'open' }),
    ),
    'POST /admin/translations/reprocess': forbidden(() =>
      aApi.post('/admin/translations/reprocess', {}),
    ),
    'POST /admin/engine/reset-breaker': forbidden(() =>
      aApi.post('/admin/engine/reset-breaker', { engine: 'typesafe' }),
    ),
    'PUT /admin/engine/credentials/:provider': forbidden(() =>
      aApi.put('/admin/engine/credentials/typesafe', { apiKey: 'x', expectedRevision: '0' }),
    ),
    'POST /admin/engine/credentials/:provider/validate': forbidden(() =>
      aApi.post('/admin/engine/credentials/typesafe/validate', {
        candidateVersion: '1',
        expectedRevision: '1',
      }),
    ),
    'POST /admin/engine/credentials/:provider/activate': forbidden(() =>
      aApi.post('/admin/engine/credentials/typesafe/activate', {
        candidateVersion: '1',
        expectedRevision: '1',
      }),
    ),
    'DELETE /admin/engine/credentials/:provider': forbidden(() =>
      aApi.delete('/admin/engine/credentials/typesafe', { query: { expectedRevision: '1' } }),
    ),
    'PATCH /admin/feeds/:id': forbidden(() =>
      aApi.patch(`/admin/feeds/${B.privateFeed}`, { fetchOptions: { userAgent: 'x' } }),
    ),
    'POST /admin/feeds/:id/reset': forbidden(() =>
      aApi.post(`/admin/feeds/${B.privateFeed}/reset`),
    ),
    'PATCH /admin/users/:id': forbidden(() => aApi.patch(`/admin/users/${b.id}`, { role: 'user' })),
    'POST /admin/invites': forbidden(() => aApi.post('/admin/invites', { count: 1 })),
    'POST /admin/waitlist/:id/invite': forbidden(() => aApi.post('/admin/waitlist/1/invite')),
    'POST /admin/library/promotion-requests': forbidden(() =>
      aApi.post('/admin/library/promotion-requests', {
        cardId: B.privateCard,
        title: 'x',
        topicIds: ['x'],
      }),
    ),
    'POST /admin/library/promote': forbidden(() =>
      aApi.post('/admin/library/promote', {
        requestId: B.publicationRequest,
        expectedVersion: '1',
      }),
    ),
    'POST /admin/library': forbidden(() =>
      aApi.post('/admin/library', { slug: 'x', title: 'x', interest: 'x', topicIds: [] }),
    ),
    'PATCH /admin/library/:id': forbidden(() =>
      aApi.patch(`/admin/library/${B.library.v2}`, { retired: true }),
    ),
  };
}

describe('every mutation as A with B ids changes nothing of B (spec 08 §12 "Cross-user writes")', () => {
  it('covers every mutation operation of the OpenAPI document', () => {
    const mutations = listOperations(doc)
      .filter((op) => op.method !== 'GET')
      .map(operationKey);
    expect(Object.keys(crossUserCases()).sort()).toEqual(mutations);
  });

  it('answers 404 (or 400 for nested ids, 403 for admin) and leaves B untouched', async () => {
    const before = await bDigest();
    for (const [operation, { attempts, statuses }] of Object.entries(crossUserCases())) {
      for (const [i, attempt] of attempts.entries()) {
        const res = await attempt();
        const context = `${operation} #${i} → ${res.statusCode} ${res.body.slice(0, 200)}`;
        expect(statuses, context).toContain(res.statusCode);
        expectNoLeak(context, res.body);
      }
    }
    expect(await bDigest()).toBe(before);
    // The mixed bulk requests failed atomically: A's state of the shared article is untouched.
    const shared = await json(aApi.get(`/articles/${B.sharedArticle}`));
    expect(shared).toMatchObject({ readAt: null, rating: null, stateVersion: '0' });
  });

  it("B still sees all of B's data", async () => {
    expect((await json(bApi.get('/rules'))).length).toBe(3);
    expect((await json(bApi.get('/labels'))).map((l: { id: string }) => l.id)).toEqual([B.label]);
    const cards = (await json(bApi.get('/cards'))).map((c: { id: string }) => c.id);
    expect(cards).toEqual(expect.arrayContaining([B.fork, B.privateCard]));
    const detail = await json(bApi.get(`/articles/${B.sharedArticle}`));
    expect(detail).toMatchObject({ rating: -1, labelIds: [B.label] });
    expect(detail.bookmarkedAt).not.toBeNull();
  });
});
