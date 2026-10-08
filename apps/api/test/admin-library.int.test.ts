import { createCard, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T9 (spec 08 §9.2, spec 05 §8, §8.1): promotion candidates, consent-gated promotion (the
 * original creator's exact approval or verified 720-hour inactivity, never popularity alone), the
 * API's own three-holder check, and library metadata edits versus new semantic versions.
 */

const HOUR = 3600 * 1000;
const TOPIC = 'admintest';

let h: ApiHarness;
let admin: TestUser;

async function hold(cardId: string, userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [userId, cardId],
    );
  }
}

/** A shared interest card by `creator`, held by the creator and `extra` other users. */
async function sharedCard(creator: string, extra: number): Promise<string> {
  const card = await createCard(h.owner, { visibility: 'shared', creatorUserId: creator });
  const others: string[] = [];
  for (let i = 0; i < extra; i += 1) others.push((await createUser(h.owner)).id);
  await hold(card.id, [creator, ...others]);
  return card.id;
}

async function respondAsCreator(
  creator: string,
  requestId: string,
  version: string,
  approve: boolean,
): Promise<void> {
  const client = await h.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [creator]);
    await client.query('SELECT * FROM respond_card_publication($1, $2, $3)', [
      requestId,
      version,
      approve,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function requestPromotion(cardId: string, title = 'Rust tooling') {
  return apiClient(h.server, admin).post('/admin/library/promotion-requests', {
    cardId,
    title,
    titleSk: 'Nástroje pre Rust',
    topicIds: [TOPIC],
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  admin = await createTestUser(h, { role: 'admin', plan: 'admin' });
  await h.owner.query(
    `INSERT INTO topics (id, parent_id, level, name_en, name_sk, description)
     VALUES ($1, NULL, 1, 'Admin test', 'Admin test', 'Topic for admin tests')
     ON CONFLICT (id) DO NOTHING`,
    [TOPIC],
  );
});

afterAll(async () => {
  await h.close();
});

describe('promotion candidates (spec 08 §9.2)', () => {
  it('lists shared interest cards with enough holders and never private forks', async () => {
    const creator = await createUser(h.owner);
    const popular = await sharedCard(creator.id, 3);
    const thin = await sharedCard(creator.id, 0);
    const fork = await createCard(h.owner, { visibility: 'private', ownerUserId: creator.id });
    await hold(fork.id, [creator.id]);

    const client = apiClient(h.server, admin);
    const res = await client.get('/admin/library/candidates');
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((item: { cardId: string }) => item.cardId);
    expect(ids).toContain(popular);
    expect(ids).not.toContain(thin);
    expect(ids).not.toContain(fork.id);
    const item = res.json().items.find((c: { cardId: string }) => c.cardId === popular);
    expect(item).toMatchObject({
      holders: 4,
      creatorKnown: true,
      vetoed: false,
      request: null,
      promotionEligibility: { status: 'held', basis: null, reason: 'no_request' },
    });

    const all = await client.get('/admin/library/candidates', { query: { minHolders: '1' } });
    const allIds = all.json().items.map((c: { cardId: string }) => c.cardId);
    expect(allIds).toContain(thin);
    expect(allIds).not.toContain(fork.id);
    expect(
      (await client.get('/admin/library/candidates', { query: { minHolders: '0' } })).statusCode,
    ).toBe(400);
  });
});

describe('promotion requests and consent (spec 05 §8.1)', () => {
  it('refuses a request for a card with fewer than three holders or that is not shared', async () => {
    const creator = await createUser(h.owner);
    const two = await sharedCard(creator.id, 1);
    const res = await requestPromotion(two);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toMatchObject({ reason: 'insufficient_holders', holders: 2 });

    const fork = await createCard(h.owner, { visibility: 'private', ownerUserId: creator.id });
    expect((await requestPromotion(fork.id)).statusCode).toBe(404);
    const pub = await createCard(h.owner, { visibility: 'public' });
    const notShared = await requestPromotion(pub.id);
    expect(notShared.statusCode).toBe(409);
    expect(notShared.json().error.details).toMatchObject({ reason: 'not_shared' });
    expect((await requestPromotion('999999999')).statusCode).toBe(404);
    const enough = await sharedCard(creator.id, 2);
    const badTopic = await apiClient(h.server, admin).post('/admin/library/promotion-requests', {
      cardId: enough,
      title: 'Unknown topic',
      topicIds: ['nosuchtopic'],
    });
    expect(badTopic.statusCode).toBe(400);
    expect(badTopic.json().error.details).toMatchObject({ field: 'topicIds' });
  });

  it('does not promote over a recently active creator without approval', async () => {
    const creator = await createUser(h.owner, { lastActiveAt: new Date() });
    const cardId = await sharedCard(creator.id, 2);
    const created = await requestPromotion(cardId);
    expect(created.statusCode).toBe(201);
    const request = created.json().request;
    expect(request).toMatchObject({
      cardId,
      status: 'pending',
      version: '1',
      expiresAt: null,
      holders: 3,
      payload: { title: 'Rust tooling', titleSk: 'Nástroje pre Rust', topicIds: [TOPIC] },
      promotionEligibility: { status: 'held', basis: null, reason: 'awaiting_approval' },
    });
    expect(request.payload.slug).toBe(`rust-tooling-${cardId}`);

    const promote = await apiClient(h.server, admin).post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: '1',
    });
    expect(promote.statusCode).toBe(409);
    const card = await h.owner.query<{ visibility: string }>(
      'SELECT visibility FROM interest_cards WHERE id = $1',
      [cardId],
    );
    expect(card.rows[0]?.visibility).toBe('shared');
  });

  it('promotes after 720 hours of creator inactivity, not one minute earlier, and falls back to created_at', async () => {
    const client = apiClient(h.server, admin);

    const almost = await createUser(h.owner, {
      lastActiveAt: new Date(Date.now() - 720 * HOUR + 60_000),
    });
    const almostCard = await sharedCard(almost.id, 2);
    const almostRequest = (await requestPromotion(almostCard)).json().request;
    expect(almostRequest.promotionEligibility.reason).toBe('awaiting_approval');
    const early = await client.post('/admin/library/promote', {
      requestId: almostRequest.id,
      expectedVersion: almostRequest.version,
    });
    expect(early.statusCode).toBe(409);

    const inactive = await createUser(h.owner, { lastActiveAt: new Date(Date.now() - 721 * HOUR) });
    const cardId = await sharedCard(inactive.id, 2);
    const request = (await requestPromotion(cardId)).json().request;
    expect(request.promotionEligibility).toEqual({
      status: 'eligible',
      basis: 'creator_inactive_30d',
      reason: null,
    });
    const candidates = await client.get('/admin/library/candidates');
    const listed = candidates.json().items.find((c: { cardId: string }) => c.cardId === cardId);
    expect(listed.request.id).toBe(request.id);
    expect(listed.promotionEligibility.basis).toBe('creator_inactive_30d');

    const promoted = await client.post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: request.version,
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({
      cardId,
      authorizationKind: 'creator_inactive_30d',
      request: { status: 'promoted', respondedAt: null, authorizationKind: 'creator_inactive_30d' },
    });
    const row = await h.owner.query<{
      visibility: string;
      slug: string;
      title: string;
      topic_ids: string[];
      evidence: Record<string, unknown>;
    }>(
      `SELECT c.visibility, c.slug, c.title, c.topic_ids, r.authorization_evidence AS evidence
         FROM interest_cards c JOIN card_publication_requests r ON r.card_id = c.id
        WHERE c.id = $1`,
      [cardId],
    );
    expect(row.rows[0]).toMatchObject({
      visibility: 'public',
      slug: `rust-tooling-${cardId}`,
      title: 'Rust tooling',
      topic_ids: [TOPIC],
    });
    expect(row.rows[0]?.evidence['anchorSource']).toBe('last_active_at');
    const versions = await h.owner.query<{ version: number }>(
      'SELECT version FROM library_card_versions WHERE card_id = $1',
      [cardId],
    );
    expect(versions.rows).toEqual([{ version: 1 }]);

    // Idempotent: promoting the same request at the same version reports the same basis.
    const again = await client.post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: request.version,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().authorizationKind).toBe('creator_inactive_30d');

    // A creator who never became active is measured from account creation.
    const dormant = await createUser(h.owner, {
      createdAt: new Date(Date.now() - 800 * HOUR),
      lastActiveAt: null,
    });
    const dormantCard = await sharedCard(dormant.id, 2);
    const dormantRequest = (await requestPromotion(dormantCard, 'Quiet topics')).json().request;
    expect(dormantRequest.promotionEligibility.basis).toBe('creator_inactive_30d');
    const dormantPromoted = await client.post('/admin/library/promote', {
      requestId: dormantRequest.id,
      expectedVersion: dormantRequest.version,
    });
    expect(dormantPromoted.statusCode).toBe(200);
    const anchor = await h.owner.query<{ evidence: Record<string, unknown> }>(
      'SELECT authorization_evidence AS evidence FROM card_publication_requests WHERE id = $1',
      [dormantRequest.id],
    );
    expect(anchor.rows[0]?.evidence['anchorSource']).toBe('created_at');
  });

  it('promotes on the creator approval of the exact version and never after a decline', async () => {
    const client = apiClient(h.server, admin);
    const creator = await createUser(h.owner, { lastActiveAt: new Date() });
    const cardId = await sharedCard(creator.id, 2);
    const request = (await requestPromotion(cardId)).json().request;
    await respondAsCreator(creator.id, request.id, request.version, true);

    const stale = await client.post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: request.version,
    });
    expect(stale.statusCode).toBe(409);
    const promoted = await client.post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: '2',
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({
      authorizationKind: 'creator_approval',
      request: { status: 'promoted' },
    });
    expect(promoted.json().request.respondedAt).toEqual(expect.any(String));

    // Declined: a veto holds the card even after the creator goes quiet.
    const decliner = await createUser(h.owner, { lastActiveAt: new Date() });
    const declinedCard = await sharedCard(decliner.id, 2);
    const declined = (await requestPromotion(declinedCard, 'Declined card')).json().request;
    await respondAsCreator(decliner.id, declined.id, declined.version, false);
    await h.owner.query(
      `UPDATE users SET last_active_at = now() - interval '800 hours' WHERE id = $1`,
      [decliner.id],
    );
    const refused = await client.post('/admin/library/promote', {
      requestId: declined.id,
      expectedVersion: '2',
    });
    expect(refused.statusCode).toBe(409);
    const candidates = await client.get('/admin/library/candidates');
    const held = candidates.json().items.find((c: { cardId: string }) => c.cardId === declinedCard);
    expect(held).toMatchObject({
      vetoed: true,
      request: null,
      promotionEligibility: { status: 'held', reason: 'declined' },
    });
    expect(
      (
        await client.post('/admin/library/promote', {
          requestId: '999999999',
          expectedVersion: '1',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('library administration (spec 08 §9, spec 05 §8)', () => {
  it('creates a slug at version 1, edits metadata in place and versions semantic changes', async () => {
    const client = apiClient(h.server, admin);
    const created = await client.post('/admin/library', {
      slug: 'admin-test-gardening',
      title: 'Gardening',
      interest: 'Home vegetable gardening and composting',
      examplesYes: ['Planting tomatoes'],
      topicIds: [TOPIC],
      i18n: { sk: { title: 'Záhradkárčenie' } },
    });
    expect(created.statusCode).toBe(201);
    const card = created.json().card;
    expect(card).toMatchObject({
      slug: 'admin-test-gardening',
      version: 1,
      title: 'Gardening',
      holders: 0,
      topicIds: [TOPIC],
      i18n: { sk: { title: 'Záhradkárčenie' } },
      retiredAt: null,
    });
    expect(created.json().idChange).toBeNull();

    const dup = await client.post('/admin/library', {
      slug: 'admin-test-gardening',
      title: 'Gardening 2',
      interest: 'Another gardening interest entirely',
      topicIds: [],
    });
    expect(dup.statusCode).toBe(409);
    const badTopic = await client.post('/admin/library', {
      slug: 'admin-test-bad-topic',
      title: 'Bad',
      interest: 'A card with an unknown topic',
      topicIds: ['nosuchtopic'],
    });
    expect(badTopic.statusCode).toBe(400);

    const holder = await createUser(h.owner);
    await hold(card.cardId, [holder.id]);

    // Metadata in place.
    const renamed = await client.patch(`/admin/library/${card.cardId}`, {
      title: 'Home gardening',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      card: { cardId: card.cardId, title: 'Home gardening', version: 1, holders: 1 },
      idChange: null,
    });

    // Semantic change: a new immutable version takes the slug; the holder keeps the old card.
    const versioned = await client.patch(`/admin/library/${card.cardId}`, {
      interest: 'Home vegetable gardening, composting and seed saving',
    });
    expect(versioned.statusCode).toBe(200);
    const next = versioned.json();
    expect(next.idChange).toEqual({ from: card.cardId, to: next.card.cardId });
    expect(next.card).toMatchObject({
      slug: 'admin-test-gardening',
      version: 2,
      title: 'Home gardening',
      holders: 0,
    });
    const held = await h.owner.query<{ card_id: string }>(
      'SELECT card_id::text AS card_id FROM user_cards WHERE user_id = $1',
      [holder.id],
    );
    expect(held.rows).toEqual([{ card_id: card.cardId }]);

    // The superseded version cannot change semantically any more.
    const old = await client.patch(`/admin/library/${card.cardId}`, {
      interest: 'Yet another gardening interest text',
    });
    expect(old.statusCode).toBe(409);

    const retired = await client.patch(`/admin/library/${next.card.cardId}`, { retired: true });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().card.retiredAt).toEqual(expect.any(String));

    const listed = await client.get('/admin/library', { query: { q: 'gardening' } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((c: { cardId: string }) => c.cardId)).toContain(
      next.card.cardId,
    );

    expect((await client.patch('/admin/library/999999999', { title: 'X' })).statusCode).toBe(404);
    expect((await client.patch(`/admin/library/${card.cardId}`, {})).statusCode).toBe(400);
  });

  it('reads the card under its locks, so overlapping patches keep both changes', async () => {
    const client = apiClient(h.server, admin);
    const created = await client.post('/admin/library', {
      slug: 'admin-test-overlap',
      title: 'Overlap',
      interest: 'Concurrent edits of one library card',
      topicIds: [],
    });
    expect(created.statusCode).toBe(201);
    const cardId = created.json().card.cardId as string;

    // A rename holds the card's locks while a topics-only patch starts and reads the card.
    const rename = await h.owner.connect();
    try {
      await rename.query('BEGIN');
      await rename.query(`SELECT pg_advisory_xact_lock(hashtext('library:admin-test-overlap'))`);
      await rename.query('SELECT id FROM interest_cards WHERE id = $1 FOR UPDATE', [cardId]);
      const topics = client.patch(`/admin/library/${cardId}`, { topicIds: [TOPIC] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rename.query(`UPDATE interest_cards SET title = 'Renamed' WHERE id = $1`, [cardId]);
      await rename.query('COMMIT');
      const res = await topics;
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().card).toMatchObject({ title: 'Renamed', topicIds: [TOPIC] });
    } finally {
      rename.release();
    }
  });
});

describe('publication provenance on the library read (spec 09 §8)', () => {
  type Basis = 'creator_approval' | 'creator_inactive_30d';
  interface Publication {
    requestId: string;
    authorizationKind: Basis;
    promotedAt: string;
  }
  interface ListedCard {
    cardId: string;
    publication: Publication | null;
  }

  async function listedCard(q: string, cardId: string): Promise<ListedCard> {
    const res = await apiClient(h.server, admin).get('/admin/library', { query: { q } });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json().items as ListedCard[]).filter((card) => card.cardId === cardId);
    expect(rows, `library rows of card ${cardId}`).toHaveLength(1);
    return rows[0]!;
  }

  async function storedPromotedAt(requestId: string): Promise<string | undefined> {
    const stored = await h.owner.query<{ promoted_at: Date }>(
      'SELECT promoted_at FROM card_publication_requests WHERE id = $1',
      [requestId],
    );
    return stored.rows[0]?.promoted_at.toISOString();
  }

  async function promoteCard(
    title: string,
    basis: Basis,
  ): Promise<{ cardId: string; publication: Publication }> {
    const approval = basis === 'creator_approval';
    const creator = await createUser(h.owner, {
      lastActiveAt: approval ? new Date() : new Date(Date.now() - 721 * HOUR),
    });
    const cardId = await sharedCard(creator.id, 2);
    const request = (await requestPromotion(cardId, title)).json().request;
    if (approval) await respondAsCreator(creator.id, request.id, request.version, true);
    const promoted = await apiClient(h.server, admin).post('/admin/library/promote', {
      requestId: request.id,
      expectedVersion: approval ? '2' : request.version,
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().authorizationKind).toBe(basis);
    return {
      cardId,
      publication: {
        requestId: request.id,
        authorizationKind: basis,
        promotedAt: promoted.json().request.promotedAt,
      },
    };
  }

  /** Promotion is final, so no API flow gives a card a second promoted request. */
  async function addPromotedRequest(
    requestId: string,
    cardId: string,
    promotedAt: Date,
  ): Promise<string> {
    const client = await h.owner.connect();
    try {
      await client.query('BEGIN');
      const copy = await client.query<{ id: string }>(
        `INSERT INTO card_publication_requests (user_id, card_id, requested_by, card_text_hash,
                                                publication_payload, publication_sha)
         SELECT user_id, card_id, requested_by, card_text_hash, publication_payload, publication_sha
           FROM card_publication_requests WHERE id = $1
         RETURNING id::text AS id`,
        [requestId],
      );
      const id = copy.rows[0]!.id;
      await client.query(`SELECT set_config('bantoozi.card_promotion', $1, true)`, [cardId]);
      await client.query(
        `UPDATE card_publication_requests
            SET status = 'promoted', promoted_at = $2, authorization_kind = 'creator_inactive_30d',
                authorization_evidence = '{"policyVersion": 1}'::jsonb
          WHERE id = $1`,
        [id, promotedAt],
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('shows each promoted card the basis, request id and audit time of its own promotion', async () => {
    const approved = await promoteCard('Provenance approved', 'creator_approval');
    const inactive = await promoteCard('Provenance inactive', 'creator_inactive_30d');

    const approvedCard = await listedCard('Provenance', approved.cardId);
    expect(approvedCard.publication).toEqual(approved.publication);
    const inactiveCard = await listedCard('Provenance', inactive.cardId);
    expect(inactiveCard.publication).toEqual(inactive.publication);
    expect(await storedPromotedAt(approved.publication.requestId)).toBe(
      approvedCard.publication?.promotedAt,
    );
    expect(await storedPromotedAt(inactive.publication.requestId)).toBe(
      inactiveCard.publication?.promotedAt,
    );
  });

  it('is null for a card created in the library, on every route that returns it', async () => {
    const client = apiClient(h.server, admin);
    const created = await client.post('/admin/library', {
      slug: 'provenance-library-card',
      title: 'Provenance library card',
      interest: 'A card written by an administrator',
      topicIds: [TOPIC],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { cardId } = created.json().card;
    expect(created.json().card.publication).toBeNull();

    const renamed = await client.patch(`/admin/library/${cardId}`, { title: 'Provenance renamed' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().card.publication).toBeNull();

    expect((await listedCard('Provenance renamed', cardId)).publication).toBeNull();
  });

  it('keeps the basis through an in-place edit and gives a new semantic version none', async () => {
    const client = apiClient(h.server, admin);
    const promoted = await promoteCard('Provenance edit', 'creator_approval');

    const renamed = await client.patch(`/admin/library/${promoted.cardId}`, {
      title: 'Provenance edited',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().idChange).toBeNull();
    expect(renamed.json().card.publication).toEqual(promoted.publication);

    const versioned = await client.patch(`/admin/library/${promoted.cardId}`, {
      interest: 'A rewritten interest for the next version',
    });
    expect(versioned.statusCode, versioned.body).toBe(200);
    const next = versioned.json();
    expect(next.idChange).toEqual({ from: promoted.cardId, to: next.card.cardId });
    expect(next.card.version).toBe(2);
    expect(next.card.publication).toBeNull();

    const previous = await listedCard('Provenance edited', promoted.cardId);
    expect(previous.publication).toEqual(promoted.publication);
    expect((await listedCard('Provenance edited', next.card.cardId)).publication).toBeNull();
  });

  it('lists a card once, with its latest promotion', async () => {
    const promoted = await promoteCard('Provenance twice', 'creator_approval');
    const later = new Date(Date.now() + 24 * HOUR);
    const laterRequestId = await addPromotedRequest(
      promoted.publication.requestId,
      promoted.cardId,
      later,
    );

    const card = await listedCard('Provenance twice', promoted.cardId);
    expect(card.publication).toEqual({
      requestId: laterRequestId,
      authorizationKind: 'creator_inactive_30d',
      promotedAt: later.toISOString(),
    });
  });

  it('stays administrator-only', async () => {
    const reader = await createTestUser(h);
    const res = await apiClient(h.server, reader).get('/admin/library');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
