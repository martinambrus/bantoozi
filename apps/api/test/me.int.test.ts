import { MeExportSchema, MeSchema } from '@bantoozi/shared';
import { createArticle, createCard, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestSession,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T3 (spec 08 §3): `GET/PATCH/DELETE /me` and `GET /me/export` — the preferences deep-merge
 * (including `theme`, `folderOrder`, `onboardingCompletedAt`), the rank/learn invalidations,
 * soft deletion through both refresh functions, and the complete, tenant-only export.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function rankRevision(userId: string): Promise<number> {
  const result = await h.owner.query<{ r: number }>(
    'SELECT rank_revision::int AS r FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]!.r;
}

async function outbox(queue: string, userId: string) {
  const result = await h.owner.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM job_outbox WHERE queue = $1 AND payload->>'userId' = $2 ORDER BY id`,
    [queue, userId],
  );
  return result.rows.map((r) => r.payload);
}

describe('GET /me', () => {
  it('returns the profile, default preferences and quota usage', async () => {
    const alice = await createTestUser(h);
    await createSubscription(h.owner, { userId: alice.id, feedId: (await createFeed(h.owner)).id });
    const res = await apiClient(h.server, alice).get('/me');
    expect(res.statusCode, res.body).toBe(200);
    const me = MeSchema.parse(res.json());
    expect(me).toMatchObject({
      id: alice.id,
      email: alice.email,
      role: 'user',
      plan: 'beta',
      preferences: { theme: 'system', folderOrder: [], onboardingCompletedAt: null },
    });
    expect(me.quotas.used.maxFeeds).toBe(1);
    expect(me.quotas.limits.maxFeeds).toBe(200);
    expect((await apiClient(h.server).get('/me')).statusCode).toBe(401);
  });
});

describe('PATCH /me', () => {
  it('deep-merges preferences (arrays replaced) and updates only supplied columns', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const first = await a.patch('/me', {
      displayName: 'Alice',
      locale: 'sk',
      timezone: 'Europe/Bratislava',
      preferences: {
        theme: 'dark',
        folderOrder: ['News', 'Tech'],
        onboardingCompletedAt: '2026-09-30T10:00:00.000Z',
        demote: { clickbait: 'on' },
        swipe: { left: 'read' },
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      displayName: 'Alice',
      locale: 'sk',
      timezone: 'Europe/Bratislava',
      preferences: {
        theme: 'dark',
        folderOrder: ['News', 'Tech'],
        onboardingCompletedAt: '2026-09-30T10:00:00.000Z',
        demote: { clickbait: 'on', promotional: 'auto', shallow: 'auto', stale: 'auto' },
        swipe: { left: 'read', right: 'like' },
      },
    });

    const second = await a.patch('/me', {
      preferences: { demote: { shallow: 'off' }, folderOrder: ['Tech'] },
    });
    expect(second.statusCode, second.body).toBe(200);
    const me = second.json();
    // Earlier leaves stay; the patched leaf changes; the array is replaced, not merged.
    expect(me.preferences.demote).toEqual({
      clickbait: 'on',
      promotional: 'auto',
      shallow: 'off',
      stale: 'auto',
    });
    expect(me.preferences.folderOrder).toEqual(['Tech']);
    expect(me.preferences.theme).toBe('dark');
    expect(me.preferences.onboardingCompletedAt).toBe('2026-09-30T10:00:00.000Z');
    expect(me).toMatchObject({ displayName: 'Alice', locale: 'sk', timezone: 'Europe/Bratislava' });

    const cleared = await a.patch('/me', {
      displayName: null,
      preferences: { onboardingCompletedAt: null },
    });
    expect(cleared.json()).toMatchObject({
      displayName: null,
      preferences: { onboardingCompletedAt: null, theme: 'dark' },
    });
    // Stored as the merged document (GET reads the same).
    expect((await a.get('/me')).json().preferences).toEqual(cleared.json().preferences);
  });

  it('rejects invalid patches with 400 and leaves the user unchanged', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const before = (await a.get('/me')).json();
    for (const body of [
      {},
      { timezone: 'Mars/Olympus_Mons' },
      { locale: 'de' },
      { displayName: 'x'.repeat(101) },
      { email: 'other@example.test' },
      { preferences: {} },
      { preferences: { theme: 'neon' } },
      { preferences: { folderOrder: ['ok', ''] } },
      { preferences: { onboardingCompletedAt: 'yesterday' } },
      { preferences: { demote: { clickbait: 'sometimes' } } },
      { preferences: { unknown: true } },
      { role: 'admin' },
    ]) {
      const res = await a.patch('/me', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect((await a.get('/me')).json()).toEqual(before);
  });

  it('records a full rank for ranking preferences and user.learn for consent changes', async () => {
    const alice = await createTestUser(h);
    const a = apiClient(h.server, alice);
    const revision = await rankRevision(alice.id);

    await a.patch('/me', { preferences: { theme: 'light', folderOrder: ['A'] } });
    expect(await rankRevision(alice.id)).toBe(revision);
    expect(await outbox('user.rank', alice.id)).toEqual([]);

    await a.patch('/me', { preferences: { demote: { stale: 'off' } } });
    expect(await rankRevision(alice.id)).toBe(revision + 1);
    expect(await outbox('user.rank', alice.id)).toEqual([
      { userId: alice.id, reason: 'preferences', full: true },
    ]);
    expect(await outbox('user.learn', alice.id)).toEqual([]);

    // Re-sending the same value is not a change.
    await a.patch('/me', { preferences: { demote: { stale: 'off' } } });
    expect(await rankRevision(alice.id)).toBe(revision + 1);

    await a.patch('/me', { preferences: { implicitFeedback: true } });
    expect(await rankRevision(alice.id)).toBe(revision + 2);
    expect(await outbox('user.learn', alice.id)).toEqual([{ userId: alice.id }]);
  });
});

describe('DELETE /me', () => {
  it('soft-deletes, revokes sessions and refreshes both materializations of the user’s feeds', async () => {
    const alice = await createTestUser(h);
    const otherSession = await createTestSession(h, alice);
    const bob = await createTestUser(h);
    const shared = await createFeed(h.owner);
    const own = await createFeed(h.owner);
    for (const feed of [shared, own]) {
      await createSubscription(h.owner, { userId: alice.id, feedId: feed.id, mode: 'active' });
    }
    await createSubscription(h.owner, { userId: bob.id, feedId: shared.id, mode: 'active' });
    const card = await createCard(h.owner);
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'love')`,
      [alice.id, card.id],
    );
    await h.owner.query(`SELECT refresh_feed_subscribers($1::bigint[], '{"beta":900}'::jsonb)`, [
      [shared.id, own.id],
    ]);
    await h.owner.query('SELECT refresh_feed_cards($1::bigint[])', [[shared.id, own.id]]);
    const feedState = async () =>
      (
        await h.owner.query<{ id: string; subscriber_count: number; cards: number }>(
          `SELECT f.id::text AS id, f.subscriber_count,
                  (SELECT count(*)::int FROM feed_cards fc WHERE fc.feed_id = f.id) AS cards
             FROM feeds f WHERE f.id = ANY($1::bigint[]) ORDER BY f.id`,
          [[shared.id, own.id]],
        )
      ).rows;
    expect(await feedState()).toEqual([
      { id: shared.id, subscriber_count: 2, cards: 1 },
      { id: own.id, subscriber_count: 1, cards: 1 },
    ]);

    const res = await apiClient(h.server, alice).delete('/me');
    expect(res.statusCode, res.body).toBe(204);

    // The deleted user no longer counts as a subscriber or card holder.
    expect(await feedState()).toEqual([
      { id: shared.id, subscriber_count: 1, cards: 0 },
      { id: own.id, subscriber_count: 0, cards: 0 },
    ]);
    const user = await h.owner.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM users WHERE id = $1',
      [alice.id],
    );
    expect(user.rows[0]!.deleted_at).not.toBeNull();
    const sessions = await h.owner.query(
      'SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [alice.id],
    );
    expect(sessions.rowCount).toBe(0);
    expect((await apiClient(h.server, alice).get('/me')).statusCode).toBe(401);
    expect((await apiClient(h.server, otherSession).get('/me')).statusCode).toBe(401);
    // Subscriptions are kept for a restore within 7 days; bob is untouched.
    const kept = await h.owner.query('SELECT 1 FROM subscriptions WHERE user_id = $1', [alice.id]);
    expect(kept.rowCount).toBe(2);
    expect((await apiClient(h.server, bob).get('/me')).statusCode).toBe(200);
  });
});

describe('GET /me/export', () => {
  async function seedEverything(user: TestUser, tag: string) {
    const feed = await createFeed(h.owner, { title: `${tag} feed` });
    await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
    await h.owner.query(
      `UPDATE subscriptions SET folder = $3, title_override = $4 WHERE user_id = $1 AND feed_id = $2`,
      [user.id, feed.id, `${tag} folder`, `${tag} override`],
    );
    await h.owner.query(
      `INSERT INTO user_feed_preferences (user_id, feed_id, image_policy) VALUES ($1, $2, 'allow')`,
      [user.id, feed.id],
    );
    const card = await createCard(h.owner, { title: `${tag} card` });
    await h.owner.query(
      `INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')`,
      [user.id, card.id],
    );
    const label = await createCard(h.owner, {
      kind: 'label',
      visibility: 'private',
      ownerUserId: user.id,
      title: `${tag} label`,
    });
    await h.owner.query(`INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)`, [
      user.id,
      label.id,
      `${tag} label`,
    ]);
    await h.owner.query(
      `INSERT INTO user_rules (user_id, kind, value) VALUES ($1, 'mute_keyword', $2)`,
      [user.id, `${tag}-keyword`],
    );
    const rated = await createArticle(h.owner, { feedIds: [feed.id], title: `${tag} rated` });
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, rating, reason, rated_at)
       VALUES ($1, $2, -1, 'clickbait', now())`,
      [user.id, rated.id],
    );
    const saved = await createArticle(h.owner, { feedIds: [feed.id], title: `${tag} saved` });
    const snapshot = await h.owner.query<{ id: string }>(
      `INSERT INTO article_snapshots (article_id, source_revision, title, body_text, body_html,
                                     content_sha256, completeness, source, extractor_version)
       VALUES ($1, 1, $2, $3, $4, $5, 'complete', 'page', 'test')
       RETURNING id::text AS id`,
      [
        saved.id,
        `${tag} saved`,
        `${tag} snapshot text`,
        `<p>${tag} snapshot html</p>`,
        `sha-${tag}`,
      ],
    );
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status,
                                 bookmark_snapshot_id, bookmark_origin_feed_id)
       VALUES ($1, $2, now(), 'saved', $3, $4)`,
      [user.id, saved.id, snapshot.rows[0]!.id, feed.id],
    );
    return { feed, card, label, snapshotId: snapshot.rows[0]!.id };
  }

  it('streams every section of the caller’s data as a JSON attachment, and nothing else', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const mine = await seedEverything(alice, 'alice');
    await seedEverything(bob, 'bob');
    await apiClient(h.server, alice).patch('/me', {
      preferences: { theme: 'dark', folderOrder: ['alice folder'] },
    });

    const res = await apiClient(h.server, alice).get('/me/export');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="bantoozi-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const document = MeExportSchema.parse(JSON.parse(res.body));
    expect(document.schemaVersion).toBe(2);
    expect(document.user).toMatchObject({
      id: alice.id,
      email: alice.email,
      preferences: { theme: 'dark', folderOrder: ['alice folder'] },
    });
    expect(document.subscriptions).toEqual([
      expect.objectContaining({
        feedId: mine.feed.id,
        folder: 'alice folder',
        titleOverride: 'alice override',
        inferenceMode: 'off',
        imagePolicy: 'allow',
      }),
    ]);
    expect(document.feedPreferences).toEqual([{ feedId: mine.feed.id, imagePolicy: 'allow' }]);
    expect(document.opml).toContain('alice override');
    expect(document.cards).toEqual([
      expect.objectContaining({ id: mine.card.id, title: 'alice card', strength: 'like' }),
    ]);
    expect(document.labels).toEqual([
      expect.objectContaining({ id: mine.label.id, name: 'alice label' }),
    ]);
    expect(document.rules).toEqual([
      expect.objectContaining({ kind: 'mute_keyword', value: 'alice-keyword' }),
    ]);
    expect(document.ratings).toEqual([
      expect.objectContaining({ title: 'alice rated', rating: -1, reason: 'clickbait' }),
    ]);
    expect(document.bookmarks).toHaveLength(1);
    expect(document.bookmarks[0]).toMatchObject({
      title: 'alice saved',
      capture: { status: 'saved', snapshotId: mine.snapshotId },
      snapshot: {
        id: mine.snapshotId,
        text: 'alice snapshot text',
        html: '<p>alice snapshot html</p>',
        completeness: 'complete',
        mediaPolicyFeedId: mine.feed.id,
        effectiveImagesAllowed: true,
      },
    });

    // Tenant-only, and no secrets: no other user's rows, sessions or tokens.
    expect(res.body).not.toContain('bob');
    expect(res.body).not.toContain(alice.token);
    expect(res.body).not.toMatch(/token|password|secret|pepper/i);
  });

  it('pages through many bookmarks and exports an empty account', async () => {
    const carol = await createTestUser(h);
    const feed = await createFeed(h.owner);
    for (let i = 0; i < 45; i += 1) {
      const article = await createArticle(h.owner, { feedIds: [feed.id] });
      await h.owner.query(
        `INSERT INTO user_article (user_id, article_id, bookmarked_at, bookmark_capture_status)
         VALUES ($1, $2, now() - make_interval(secs => $3), 'pending')`,
        [carol.id, article.id, i],
      );
    }
    const res = await apiClient(h.server, carol).get('/me/export');
    expect(res.statusCode).toBe(200);
    const document = MeExportSchema.parse(JSON.parse(res.body));
    expect(document.bookmarks).toHaveLength(45);
    expect(new Set(document.bookmarks.map((b) => b.url)).size).toBe(45);
    for (const bookmark of document.bookmarks) expect(bookmark.snapshot).toBeNull();

    const empty = await createTestUser(h);
    const blank = MeExportSchema.parse(
      JSON.parse((await apiClient(h.server, empty).get('/me/export')).body),
    );
    expect(blank).toMatchObject({
      subscriptions: [],
      feedPreferences: [],
      cards: [],
      labels: [],
      rules: [],
      ratings: [],
      bookmarks: [],
    });
  });
});
