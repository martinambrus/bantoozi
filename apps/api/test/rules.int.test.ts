import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiClient, createApiHarness, createTestUser, type ApiHarness } from './support/harness.js';

/**
 * M4-T8 rules (spec 08 §8, spec 06 §3): per-kind value validation and normalization, references
 * owned by the user (404 otherwise), the `mute_story` expiry requirement, the `maxRules` quota and
 * the full-rank intent of every create and delete.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

async function reader() {
  const user = await createTestUser(h);
  const feed = await createFeed(h.owner, { title: 'Daily Planet' });
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: 'Storm hits the coast',
  });
  const { rows } = await h.owner.query<{ id: string }>(
    'INSERT INTO story_clusters (representative_article_id) VALUES ($1) RETURNING id::text AS id',
    [article.id],
  );
  const clusterId = rows[0]!.id;
  await h.owner.query('UPDATE articles SET story_cluster_id = $2 WHERE id = $1', [
    article.id,
    clusterId,
  ]);
  return { user, feed, article, clusterId, api: apiClient(h.server, user) };
}

async function rankState(userId: string) {
  const { rows } = await h.owner.query<{ revision: string; full: number }>(
    `SELECT u.rank_revision::text AS revision,
            (SELECT count(*)::int FROM job_outbox o
              WHERE o.user_id = u.id AND o.queue = 'user.rank' AND o.delivered_at IS NULL
                AND (o.payload->>'full')::boolean) AS full
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return rows[0]!;
}

async function drainOutbox(): Promise<void> {
  await h.owner.query('UPDATE job_outbox SET delivered_at = now() WHERE delivered_at IS NULL');
}

describe('POST /rules', () => {
  it('creates each kind with a normalized value and a full-rank intent', async () => {
    const r = await reader();
    const cases = [
      { body: { kind: 'mute_keyword', value: '  Formula   1 ' }, value: 'Formula 1' },
      {
        body: { kind: 'mute_story', value: r.clusterId, expiresInDays: 7 },
        value: r.clusterId,
        display: 'Storm hits the coast',
      },
      { body: { kind: 'block_feed', value: r.feed.id }, value: r.feed.id, display: 'Daily Planet' },
      { body: { kind: 'boost_feed', value: r.feed.id }, value: r.feed.id, display: 'Daily Planet' },
      { body: { kind: 'block_domain', value: 'News.Example.co.uk' }, value: 'example.co.uk' },
      { body: { kind: 'boost_domain', value: 'example.org.' }, value: 'example.org' },
      { body: { kind: 'block_author', value: ' Jane   Doe ' }, value: 'Jane Doe' },
    ];
    for (const c of cases) {
      await drainOutbox();
      const before = await rankState(r.user.id);
      const res = await r.api.post('/rules', c.body);
      expect(res.statusCode, JSON.stringify(c.body)).toBe(201);
      expect(res.json().rule).toMatchObject({
        id: expect.any(String),
        kind: c.body.kind,
        value: c.value,
        displayValue: c.display ?? c.value,
      });
      const after = await rankState(r.user.id);
      expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 1n);
      expect(after.full).toBe(1);
    }
    const listed = (await r.api.get('/rules')).json();
    expect(listed.map((rule: { kind: string }) => rule.kind)).toEqual(
      cases.map((c) => c.body.kind),
    );
    const story = listed.find((rule: { kind: string }) => rule.kind === 'mute_story');
    const days = (Date.parse(story.expiresAt) - Date.parse(story.createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 2);
    expect(
      listed.find((rule: { kind: string }) => rule.kind === 'block_feed').expiresAt,
    ).toBeNull();
  });

  it('validates the value per kind with 400', async () => {
    const r = await reader();
    for (const body of [
      { kind: 'mute_keyword', value: 'a' },
      { kind: 'mute_keyword', value: 'k'.repeat(101) },
      { kind: 'block_domain', value: 'not a domain' },
      { kind: 'block_domain', value: 'https://example.com/path' },
      { kind: 'block_domain', value: 'com' },
      { kind: 'boost_domain', value: '127.0.0.1' },
      { kind: 'block_feed', value: 'feed-1' },
      { kind: 'mute_story', value: '0', expiresInDays: 1 },
      { kind: 'block_author', value: '   ' },
      { kind: 'mute_all', value: 'x' },
      { kind: 'mute_keyword', value: 'valid', extra: 1 },
    ]) {
      const res = await r.api.post('/rules', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('requires expiresInDays ∈ {1,3,7,30} for mute_story and rejects a null expiry', async () => {
    const r = await reader();
    for (const body of [
      { kind: 'mute_story', value: r.clusterId },
      { kind: 'mute_story', value: r.clusterId, expiresInDays: null },
      { kind: 'mute_story', value: r.clusterId, expiresInDays: 2 },
      { kind: 'mute_keyword', value: 'storm', expiresInDays: null },
    ]) {
      const res = await r.api.post('/rules', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const days of [1, 3, 30]) {
      const res = await r.api.post('/rules', {
        kind: 'mute_story',
        value: r.clusterId,
        expiresInDays: days,
      });
      expect(res.statusCode).toBe(201);
    }
    // Repeated mutes of one story keep a single rule with the latest expiry.
    const stories = (await r.api.get('/rules')).json();
    expect(stories).toHaveLength(1);
    const days = (Date.parse(stories[0].expiresAt) - Date.parse(stories[0].createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(30, 2);
    const keyword = await r.api.post('/rules', {
      kind: 'mute_keyword',
      value: 'storm',
      expiresInDays: 3,
    });
    expect(keyword.statusCode).toBe(201);
    expect(keyword.json().rule.expiresAt).not.toBeNull();
  });

  it('answers 404 for a feed or story the user cannot reference', async () => {
    const a = await reader();
    const b = await reader();
    const unsubscribed = await createFeed(h.owner);
    for (const body of [
      { kind: 'block_feed', value: b.feed.id },
      { kind: 'boost_feed', value: unsubscribed.id },
      { kind: 'mute_story', value: b.clusterId, expiresInDays: 1 },
      { kind: 'mute_story', value: '987654321', expiresInDays: 1 },
    ]) {
      const res = await a.api.post('/rules', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(404);
    }
    expect((await a.api.get('/rules')).json()).toEqual([]);
  });

  it('returns the live rule for a duplicate without using quota', async () => {
    const r = await reader();
    const first = (await r.api.post('/rules', { kind: 'mute_keyword', value: 'Elections' })).json()
      .rule;
    const again = await r.api.post('/rules', { kind: 'mute_keyword', value: 'Elections' });
    expect(again.statusCode).toBe(201);
    expect(again.json().rule.id).toBe(first.id);
    expect((await r.api.get('/rules')).json()).toHaveLength(1);
  });
});

describe('maxRules (spec 08 §6)', () => {
  it('accepts the 200th rule and refuses the 201st with QUOTA_EXCEEDED', async () => {
    const r = await reader();
    await h.owner.query(
      `INSERT INTO user_rules (user_id, kind, value)
       SELECT $1, 'mute_keyword', 'filler ' || g FROM generate_series(1, 199) g`,
      [r.user.id],
    );
    // An expired rule is gone for the reader and does not count.
    await h.owner.query(
      `INSERT INTO user_rules (user_id, kind, value, expires_at)
       VALUES ($1, 'mute_keyword', 'expired', now() - interval '1 minute')`,
      [r.user.id],
    );
    const ok = await r.api.post('/rules', { kind: 'block_author', value: 'Author 200' });
    expect(ok.statusCode).toBe(201);
    const over = await r.api.post('/rules', { kind: 'block_author', value: 'Author 201' });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxRules', used: 200, max: 200 },
    });
  });
});

describe('DELETE /rules/:id', () => {
  it('deletes with a full-rank intent; foreign, missing and expired ids are 404', async () => {
    const a = await reader();
    const b = await reader();
    const rule = (await a.api.post('/rules', { kind: 'block_author', value: 'Someone' })).json()
      .rule;
    const foreign = (await b.api.post('/rules', { kind: 'block_author', value: 'Other' })).json()
      .rule;
    expect((await a.api.delete(`/rules/${foreign.id}`)).statusCode).toBe(404);
    expect((await a.api.delete('/rules/999999999')).statusCode).toBe(404);
    expect((await a.api.delete('/rules/x1')).statusCode).toBe(400);
    await drainOutbox();
    const before = await rankState(a.user.id);
    const res = await a.api.delete(`/rules/${rule.id}`);
    expect(res.statusCode).toBe(204);
    const after = await rankState(a.user.id);
    expect(BigInt(after.revision)).toBe(BigInt(before.revision) + 1n);
    expect(after.full).toBe(1);
    expect((await a.api.get('/rules')).json()).toEqual([]);
    expect((await b.api.get('/rules')).json()).toHaveLength(1);
    const { rows } = await h.owner.query<{ id: string }>(
      `INSERT INTO user_rules (user_id, kind, value, expires_at)
       VALUES ($1, 'mute_keyword', 'old', now() - interval '1 minute') RETURNING id::text AS id`,
      [a.user.id],
    );
    expect((await a.api.delete(`/rules/${rows[0]!.id}`)).statusCode).toBe(404);
  });
});
