import { randomUUID } from 'node:crypto';

import { createCard, createFeed, createSubscription, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T5 library, suggestions, publication requests and topics (spec 08 §7, spec 05 §7–§8.1):
 * localized library browsing with pagination, adoption (and the superseded-version conflict),
 * opt-in library updates answered from their receipt on replay, suggestion visibility rules and
 * dismissal, the creator-only publication response and the topic taxonomy.
 */

let h: ApiHarness;

let sequence = 0;
const unique = (text: string) => {
  sequence += 1;
  return `${text} ${sequence}-${randomUUID().slice(0, 6)}`;
};

beforeAll(async () => {
  h = await createApiHarness();
  // A small taxonomy (seeded by `pnpm db:seed` in a real deployment).
  for (const [id, parent, level, en, sk, sort] of [
    ['technology', null, 1, 'Technology', 'Technológie', 1],
    ['technology.software_dev', 'technology', 2, 'Software development', 'Vývoj softvéru', 1],
    ['science', null, 1, 'Science', 'Veda', 2],
    ['science.space', 'science', 2, 'Space', 'Vesmír', 1],
  ] as const) {
    await h.owner.query(
      `INSERT INTO topics (id, parent_id, level, name_en, name_sk, description, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, parent, level, en, sk, `${en} topics`, sort],
    );
  }
});

afterAll(async () => {
  await h.close();
});

interface LibraryEntry {
  slug: string;
  ids: string[];
}

/** Append a library version (a new public card); the slug moves to the newest card. */
async function publishVersion(
  entry: LibraryEntry,
  version: { title: string; interest: string; topicIds?: string[]; sk?: Record<string, string> },
): Promise<string> {
  const previous = entry.ids.at(-1) ?? null;
  if (previous !== null) {
    await h.owner.query('UPDATE interest_cards SET slug = NULL WHERE id = $1', [previous]);
  }
  const card = await createCard(h.owner, {
    visibility: 'public',
    origin: 'library',
    slug: entry.slug,
    title: version.title,
    interest: version.interest,
    topicIds: version.topicIds ?? ['technology.software_dev'],
  });
  if (version.sk !== undefined) {
    await h.owner.query('UPDATE interest_cards SET i18n = $2::jsonb WHERE id = $1', [
      card.id,
      JSON.stringify({ sk: version.sk }),
    ]);
  }
  await h.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, $2, $3, $4)`,
    [entry.slug, entry.ids.length + 1, card.id, previous],
  );
  entry.ids.push(card.id);
  return card.id;
}

async function libraryEntry(
  ...versions: Parameters<typeof publishVersion>[1][]
): Promise<LibraryEntry> {
  const entry: LibraryEntry = { slug: unique('entry').replace(/\s+/g, '-'), ids: [] };
  for (const version of versions) await publishVersion(entry, version);
  return entry;
}

async function reader(locale: 'en' | 'sk' = 'en') {
  const user = await createTestUser(h, { locale });
  const feed = await createFeed(h.owner);
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id, mode: 'active' });
  return { user, feed, api: apiClient(h.server, user) };
}

async function heldIds(userId: string): Promise<string[]> {
  const { rows } = await h.owner.query<{ id: string }>(
    'SELECT card_id::text AS id FROM user_cards WHERE user_id = $1 ORDER BY card_id',
    [userId],
  );
  return rows.map((row) => row.id);
}

/** Run one statement as the API role inside a tenant transaction. */
async function asTenant<R extends object>(
  userId: string,
  text: string,
  values: unknown[],
): Promise<R[]> {
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

describe('GET /library', () => {
  it('lists current public cards localized to the user, filtered and paginated', async () => {
    const rust = await libraryEntry({
      title: 'Rust programming',
      interest: unique('The Rust programming language, releases and tooling'),
      topicIds: ['technology.software_dev'],
      sk: { title: 'Programovanie v Ruste', interest: 'Jazyk Rust, jeho vydania a nástroje' },
    });
    const space = await libraryEntry({
      title: 'Space launches',
      interest: unique('Rocket launches and spacecraft missions'),
      topicIds: ['science.space'],
    });
    // A shared (non-public) card and a retired public card are never listed.
    await createCard(h.owner, { visibility: 'shared', interest: unique('Shared only') });
    const retired = await createCard(h.owner, {
      visibility: 'public',
      origin: 'library',
      interest: unique('Retired library card'),
    });
    await h.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [retired.id]);

    const { api } = await reader('sk');
    const all = (await api.get('/library')).json();
    const ids = all.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(rust.ids[0]);
    expect(ids).toContain(space.ids[0]);
    expect(ids).not.toContain(retired.id);
    expect(all.nextCursor).toBeNull();
    const rustCard = all.items.find((c: { id: string }) => c.id === rust.ids[0]);
    expect(rustCard).toMatchObject({
      title: 'Programovanie v Ruste',
      interest: 'Jazyk Rust, jeho vydania a nástroje',
      slug: rust.slug,
      l1TopicId: 'technology',
      version: 1,
      held: false,
    });
    // Grouped by level-1 topic in taxonomy order: technology before science.
    expect(ids.indexOf(rust.ids[0])).toBeLessThan(ids.indexOf(space.ids[0]));

    const byTopic = (await api.get('/library', { query: { topic: 'science' } })).json();
    expect(byTopic.items.map((c: { id: string }) => c.id)).toEqual([space.ids[0]]);
    const search = (await api.get('/library', { query: { q: 'ruste' } })).json();
    expect(search.items.map((c: { id: string }) => c.id)).toEqual([rust.ids[0]]);

    const english = (await apiClient(h.server, (await reader('en')).user).get('/library')).json();
    expect(english.items.find((c: { id: string }) => c.id === rust.ids[0]).title).toBe(
      'Rust programming',
    );
  });

  it('pages with a signed cursor bound to the user and the query', async () => {
    for (let i = 0; i < 3; i += 1) {
      await libraryEntry({ title: `Paged ${i}`, interest: unique('Paged library card') });
    }
    const { user, api } = await reader();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string> = { limit: '2' };
      if (cursor !== null) query.cursor = cursor;
      const res = await api.get('/library', { query });
      expect(res.statusCode).toBe(200);
      const page = res.json();
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((c: { id: string }) => c.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    const full = (await api.get('/library', { query: { limit: '100' } })).json();
    expect(seen).toEqual(full.items.map((c: { id: string }) => c.id));
    expect(new Set(seen).size).toBe(seen.length);

    const first = (await api.get('/library', { query: { limit: '1' } })).json();
    expect(first.nextCursor).not.toBeNull();
    const other = await createTestUser(h);
    const foreign = await apiClient(h.server, other).get('/library', {
      query: { limit: '1', cursor: first.nextCursor },
    });
    expect(foreign.statusCode).toBe(400);
    const changed = await api.get('/library', {
      query: { limit: '1', cursor: first.nextCursor, q: 'paged' },
    });
    expect(changed.statusCode).toBe(400);
    expect(user.id).toBeDefined();
    expect((await api.get('/library', { query: { limit: '0' } })).statusCode).toBe(400);
    expect((await api.get('/library', { query: { sort: 'x' } })).statusCode).toBe(400);
  });
});

describe('POST /library/:id/adopt', () => {
  it('holds the current version and refuses a superseded one', async () => {
    const entry = await libraryEntry(
      { title: 'Rust', interest: unique('The Rust language') },
      { title: 'Rust programming', interest: unique('The Rust language, libraries and tooling') },
    );
    const [v1, v2] = entry.ids as [string, string];
    const { user, feed, api } = await reader();
    const old = await api.post(`/library/${v1}/adopt`, { strength: 'like' });
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'superseded', currentCardId: v2 },
    });
    const res = await api.post(`/library/${v2}/adopt`, { strength: 'love', scopeFeedId: feed.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      idChange: null,
      card: { id: v2, origin: 'library', strength: 'love', scopeFeedId: feed.id },
    });
    expect(await heldIds(user.id)).toEqual([v2]);
    // Listing shows it as held; the superseded version is not listed.
    const listed = (await api.get('/library', { query: { limit: '100' } })).json().items;
    expect(listed.find((c: { id: string }) => c.id === v2).held).toBe(true);
    expect(listed.find((c: { id: string }) => c.id === v1)).toBeUndefined();
  });

  it('answers 404 for a shared, private or missing card and 400 for a bad body', async () => {
    const { api } = await reader();
    const shared = await createCard(h.owner, { visibility: 'shared', interest: unique('Shared') });
    const owner = await createUser(h.owner);
    const fork = await createCard(h.owner, {
      visibility: 'private',
      ownerUserId: owner.id,
      interest: unique('Private'),
    });
    for (const id of [shared.id, fork.id, '999999999']) {
      expect((await api.post(`/library/${id}/adopt`, { strength: 'like' })).statusCode).toBe(404);
    }
    const entry = await libraryEntry({ title: 'Valid', interest: unique('Valid library card') });
    expect(
      (await api.post(`/library/${entry.ids[0]}/adopt`, { strength: 'adore' })).statusCode,
    ).toBe(400);
    expect((await api.post('/library/abc/adopt', { strength: 'like' })).statusCode).toBe(400);
  });
});

describe('library updates', () => {
  it('offers, applies explicitly, and answers a replay from the Idempotency-Key receipt', async () => {
    const entry = await libraryEntry({ title: 'Space', interest: unique('Rocket launches') });
    const { user, api } = await reader();
    const v1 = entry.ids[0]!;
    expect((await api.post(`/library/${v1}/adopt`, { strength: 'must' })).statusCode).toBe(200);
    await api.patch(`/cards/${v1}`, { title: 'My launches' });
    const v2 = await publishVersion(entry, {
      title: 'Space launches',
      interest: unique('Rocket launches, spacecraft missions and the launch industry'),
    });

    const offers = (await api.get('/library/updates')).json();
    expect(offers).toEqual([
      expect.objectContaining({
        currentCardId: v1,
        baseCardId: v1,
        newCardId: v2,
        librarySlug: entry.slug,
        fromVersion: 1,
        toVersion: 2,
        hasPrivateCustomization: false,
      }),
    ]);
    expect(offers[0].diff.interest).not.toBeNull();
    // Nothing is applied automatically.
    expect(await heldIds(user.id)).toEqual([v1]);

    const key = randomUUID();
    const url = `/library/${v1}/updates/${v2}/apply`;
    const body = { expectedCurrentCardId: v1 };
    const applied = await api.post(url, body, { idempotencyKey: key });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      idChange: { from: v1, to: v2 },
      card: { id: v2, strength: 'must', title: 'My launches' },
    });
    const replay = await api.post(url, body, { idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(applied.json());
    // A new key repeats the operation, whose old holding is gone: 404.
    expect((await api.post(url, body)).statusCode).toBe(404);
    expect(await heldIds(user.id)).toEqual([v2]);
    expect((await api.get('/library/updates')).json()).toEqual([]);
  });

  it('refuses a wrong lineage, another user’s holding and a private customization', async () => {
    const entry = await libraryEntry({ title: 'AI', interest: unique('LLM research') });
    const other = await libraryEntry({ title: 'Other', interest: unique('Other entry') });
    const a = await reader();
    const b = await reader();
    const v1 = entry.ids[0]!;
    await b.api.post(`/library/${v1}/adopt`, { strength: 'like' });
    const v2 = await publishVersion(entry, { title: 'AI', interest: unique('LLM research v2') });
    // A does not hold v1: 404 without creating a holding.
    expect(
      (await a.api.post(`/library/${v1}/updates/${v2}/apply`, { expectedCurrentCardId: v1 }))
        .statusCode,
    ).toBe(404);
    expect(await heldIds(a.user.id)).toEqual([]);
    // Not a successor of v1.
    expect(
      (
        await b.api.post(`/library/${v1}/updates/${other.ids[0]}/apply`, {
          expectedCurrentCardId: v1,
        })
      ).statusCode,
    ).toBe(404);
    // A private customization is a conflict, never an automatic merge.
    const feedArticle = await h.owner.query<{ id: string }>(
      `INSERT INTO articles (url, canonical_url, url_key, title, title_norm, content_hash, content_revision)
       VALUES ($1, $1, $2, 'Launch example', 'launch example', md5($1), 1) RETURNING id::text AS id`,
      [`https://x.test/${randomUUID()}`, `x.test/${randomUUID()}`],
    );
    await h.owner.query(`INSERT INTO feed_items (feed_id, article_id, guid) VALUES ($1, $2, $3)`, [
      b.feed.id,
      feedArticle.rows[0]!.id,
      randomUUID(),
    ]);
    const fork = (
      await b.api.post(`/cards/${v1}/examples`, { articleId: feedArticle.rows[0]!.id, side: 'yes' })
    ).json().card;
    const offers = (await b.api.get('/library/updates')).json();
    expect(offers).toEqual([
      expect.objectContaining({ currentCardId: fork.id, hasPrivateCustomization: true }),
    ]);
    const custom = await b.api.post(`/library/${v1}/updates/${v2}/apply`, {
      expectedCurrentCardId: fork.id,
    });
    expect(custom.statusCode).toBe(409);
    expect(custom.json().error.details.reason).toBe('private_holding');
  });
});

describe('GET /topics', () => {
  it('lists the taxonomy with both names, each level-1 topic before its children', async () => {
    const { api } = await reader();
    const topics = (await api.get('/topics')).json();
    expect(topics).toEqual([
      {
        id: 'technology',
        parent: null,
        level: 1,
        names: { en: 'Technology', sk: 'Technológie' },
        description: 'Technology topics',
      },
      expect.objectContaining({ id: 'technology.software_dev', parent: 'technology', level: 2 }),
      expect.objectContaining({ id: 'science', level: 1 }),
      expect.objectContaining({ id: 'science.space', parent: 'science', level: 2 }),
    ]);
  });
});

describe('card suggestions', () => {
  let activeSet: string;
  let otherSet: string;

  async function questionSet(version: string): Promise<string> {
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('suggest', $1, encode(sha256(convert_to($1, 'UTF8')), 'hex'), '{}'::jsonb)
       RETURNING id::text AS id`,
      [version],
    );
    return rows[0]!.id;
  }

  async function setSetting(key: string, value: unknown) {
    await h.owner.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async function suggest(
    user: TestUser,
    cardId: string,
    options: { set?: string; pin?: string; score?: number } = {},
  ) {
    await h.owner.query(
      `INSERT INTO card_suggestions (user_id, card_id, question_set_id, model_pin, score)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, cardId, options.set ?? activeSet, options.pin ?? 'jev-1', options.score ?? 0.5],
    );
  }

  beforeAll(async () => {
    activeSet = await questionSet(`suggest-test-${randomUUID()}`);
    otherSet = await questionSet(`suggest-test-${randomUUID()}`);
    await setSetting('question_sets.active', { suggest: activeSet });
    await setSetting('engine.model_pin', { model: 'jev-1' });
  });

  it('lists only current-set, current-pin, unheld, undismissed suggestions, best first', async () => {
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      const entry = await libraryEntry({ title: `Suggested ${i}`, interest: unique('Suggested') });
      cards.push(entry.ids[0]!);
    }
    const [low, high, oldSet, llm] = cards as [string, string, string, string];
    const { user, api } = await reader();
    await suggest(user, low, { score: 0.3 });
    await suggest(user, high, { score: 0.9 });
    await suggest(user, oldSet, { set: otherSet });
    // A row from another model (e.g. a fallback model's) never shows: suggestions are Jev-only.
    await suggest(user, llm, { pin: 'llm-fallback-model' });

    const list = (await api.get('/cards/suggestions')).json();
    expect(list.map((s: { card: { id: string }; score: number }) => [s.card.id, s.score])).toEqual([
      [high, expect.closeTo(0.9, 5)],
      [low, expect.closeTo(0.3, 5)],
    ]);
    expect(list[0].card).toMatchObject({ title: 'Suggested 1', held: false });

    // Adopting a suggested card removes it from the list.
    expect((await api.post(`/library/${high}/adopt`, { strength: 'like' })).statusCode).toBe(200);
    expect(
      (await api.get('/cards/suggestions')).json().map((s: { card: { id: string } }) => s.card.id),
    ).toEqual([low]);

    // Dismissal hides it; dismissing again stays 204; a card never suggested is 404.
    expect((await api.post(`/cards/suggestions/${low}/dismiss`)).statusCode).toBe(204);
    expect((await api.post(`/cards/suggestions/${low}/dismiss`)).statusCode).toBe(204);
    expect((await api.get('/cards/suggestions')).json()).toEqual([]);
    expect((await api.post(`/cards/suggestions/${oldSet}/dismiss`)).statusCode).toBe(204);
    const stranger = await reader();
    expect((await stranger.api.post(`/cards/suggestions/${llm}/dismiss`)).statusCode).toBe(404);
  });

  it('hides suggestions when the active set or the Jev model pin changes', async () => {
    const entry = await libraryEntry({ title: 'Switch', interest: unique('Switching') });
    const { user, api } = await reader();
    await suggest(user, entry.ids[0]!);
    expect((await api.get('/cards/suggestions')).json()).toHaveLength(1);
    await setSetting('engine.model_pin', { model: 'jev-2' });
    expect((await api.get('/cards/suggestions')).json()).toEqual([]);
    await setSetting('engine.model_pin', { model: 'jev-1' });
    await setSetting('question_sets.active', { suggest: otherSet });
    expect((await api.get('/cards/suggestions')).json()).toEqual([]);
    await setSetting('question_sets.active', { suggest: activeSet });
    expect((await api.get('/cards/suggestions')).json()).toHaveLength(1);
    // Another user's suggestions are never listed.
    expect((await (await reader()).api.get('/cards/suggestions')).json()).toEqual([]);
  });
});

describe('publication requests', () => {
  it('lists a request for its creator only and accepts the creator’s CAS response', async () => {
    const admin = await createUser(h.owner, { role: 'admin' });
    const creator = await reader();
    const interest = unique('Czech tech startups and their funding rounds');
    const created = (
      await creator.api.post('/cards', { title: 'Czech tech', interest, strength: 'like' })
    ).json().card;
    const [request] = await asTenant<{ request_id: string; version: string }>(
      admin.id,
      'SELECT request_id::text, version::text FROM admin_request_card_publication($1, $2::jsonb, NULL)',
      [
        created.id,
        JSON.stringify({
          slug: 'cz-tech-scene',
          title: 'Czech tech scene',
          topic_ids: ['technology.software_dev'],
          i18n: { sk: { title: 'Česká tech scéna' } },
        }),
      ],
    );
    const list = (await creator.api.get('/cards/publication-requests')).json();
    expect(list).toEqual([
      expect.objectContaining({
        id: request!.request_id,
        cardId: created.id,
        status: 'pending',
        version: '1',
        card: expect.objectContaining({ title: 'Czech tech', interest }),
        proposed: {
          slug: 'cz-tech-scene',
          title: 'Czech tech scene',
          topicIds: ['technology.software_dev'],
          i18n: { sk: { title: 'Česká tech scéna' } },
        },
        respondedAt: null,
      }),
    ]);
    expect(list[0].publicationSha).toMatch(/^[0-9a-f]{64}$/);

    // A holder of the same text is not the creator: nothing listed, a response is 404.
    const holder = await reader();
    await holder.api.post('/cards', { interest, strength: 'love' });
    expect((await holder.api.get('/cards/publication-requests')).json()).toEqual([]);
    const url = `/cards/publication-requests/${request!.request_id}/respond`;
    expect(
      (await holder.api.post(url, { decision: 'approve', expectedVersion: '1' })).statusCode,
    ).toBe(404);

    const stale = await creator.api.post(url, { decision: 'approve', expectedVersion: '7' });
    expect(stale.statusCode).toBe(409);
    expect(
      (await creator.api.post(url, { decision: 'maybe', expectedVersion: '1' })).statusCode,
    ).toBe(400);

    const approved = await creator.api.post(url, { decision: 'approve', expectedVersion: '1' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().request).toMatchObject({ status: 'approved', version: '2' });
    expect(approved.json().request.respondedAt).not.toBeNull();
    const declined = await creator.api.post(url, { decision: 'decline', expectedVersion: '2' });
    expect(declined.json().request).toMatchObject({ status: 'rejected', version: '3' });
    const { rows } = await h.owner.query<{ veto: boolean }>(
      'SELECT publication_veto_at IS NOT NULL AS veto FROM interest_cards WHERE id = $1',
      [created.id],
    );
    expect(rows[0]!.veto).toBe(true);
  });
});

describe('OpenAPI', () => {
  it('documents every card, label, library, topic and rule operation exactly once', async () => {
    const doc = (await apiClient(h.server).get('/openapi.json')).json() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const ours = operations
      .filter((op) => /\/api\/v1\/(cards|labels|library|topics|rules)\b/.test(op))
      .sort();
    expect(ours).toEqual(
      [
        'GET /api/v1/cards',
        'POST /api/v1/cards',
        'PATCH /api/v1/cards/{id}',
        'DELETE /api/v1/cards/{id}',
        'POST /api/v1/cards/{id}/examples',
        'POST /api/v1/cards/{id}/examples/remove',
        'POST /api/v1/cards/from-article',
        'GET /api/v1/cards/publication-requests',
        'POST /api/v1/cards/publication-requests/{id}/respond',
        'GET /api/v1/cards/suggestions',
        'POST /api/v1/cards/suggestions/{cardId}/dismiss',
        'GET /api/v1/library',
        'POST /api/v1/library/{id}/adopt',
        'GET /api/v1/library/updates',
        'POST /api/v1/library/{id}/updates/{newId}/apply',
        'GET /api/v1/topics',
        'GET /api/v1/labels',
        'POST /api/v1/labels',
        'PATCH /api/v1/labels/{id}',
        'DELETE /api/v1/labels/{id}',
        'POST /api/v1/labels/{id}/examples',
        'POST /api/v1/labels/{id}/examples/remove',
        'GET /api/v1/rules',
        'POST /api/v1/rules',
        'DELETE /api/v1/rules/{id}',
      ].sort(),
    );
  });
});
