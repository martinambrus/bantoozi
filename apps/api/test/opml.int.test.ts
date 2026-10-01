import { randomUUID } from 'node:crypto';

import { parseOpml } from '@bantoozi/feeds';
import { createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type RequestOptions,
  type TestUser,
} from './support/harness.js';

/**
 * M4-T4 OPML (spec 03 §11, spec 08 §4): the import report (added/existing/invalid, quota
 * boundaries), defaults (off, no fetch, no provider demand), idempotent replay, and the export
 * round-trip through `parseOpml`.
 */

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

interface Outline {
  xmlUrl: string;
  title?: string;
  folder?: string;
}

function opmlDocument(outlines: readonly Outline[]): string {
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const line = (o: Outline) =>
    `<outline type="rss" text="${escape(o.title ?? o.xmlUrl)}" xmlUrl="${escape(o.xmlUrl)}"/>`;
  const body: string[] = [];
  const folders = new Map<string, Outline[]>();
  for (const outline of outlines) {
    if (outline.folder === undefined) {
      body.push(line(outline));
      continue;
    }
    let group = folders.get(outline.folder);
    if (group === undefined) {
      group = [];
      folders.set(outline.folder, group);
      body.push(`@@${outline.folder}@@`);
    }
    group.push(outline);
  }
  const rendered = body.map((entry) => {
    const folder = /^@@(.*)@@$/.exec(entry)?.[1];
    if (folder === undefined) return entry;
    return `<outline text="${escape(folder)}">${folders.get(folder)!.map(line).join('')}</outline>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>t</title></head><body>${rendered.join('')}</body></opml>`;
}

function upload(document: string | Buffer, contentType = 'text/x-opml') {
  const boundary = `----bantoozi${randomUUID().replaceAll('-', '')}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="subs.opml"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.isBuffer(document) ? document : Buffer.from(document, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function importOpml(user: TestUser, document: string, options: RequestOptions = {}) {
  const { payload, headers } = upload(document);
  return apiClient(h.server, user).post('/subscriptions/import-opml', payload, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
}

async function subscriptions(userId: string) {
  const result = await h.owner.query<{
    url: string;
    folder: string | null;
    inference_mode: string;
    inference_version: string;
    subscriber_count: number;
    feed_id: string;
  }>(
    `SELECT f.url, s.folder, s.inference_mode, s.inference_version::text AS inference_version,
            f.subscriber_count, f.id::text AS feed_id
       FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
      WHERE s.user_id = $1 ORDER BY f.url`,
    [userId],
  );
  return result.rows;
}

async function outboxCount(queues: readonly string[], feedIds?: readonly string[]) {
  const result = await h.owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM job_outbox
      WHERE queue = ANY($1::text[]) AND ($2::text[] IS NULL OR payload->>'feedId' = ANY($2::text[]))`,
    [queues, feedIds ?? null],
  );
  return result.rows[0]!.n;
}

const PROVIDER_QUEUES = [
  'article.enrich',
  'article.enrich.laya',
  'article.match',
  'analysis.process',
  'analysis.process.laya',
  'card.backfill',
];

const bulk = (tag: string, n: number): Outline[] =>
  Array.from({ length: n }, (_, i) => ({ xmlUrl: `https://opml.example.com/${tag}/${i}.xml` }));

describe('POST /subscriptions/import-opml', () => {
  it('reports added, existing and invalid outlines and subscribes new feeds off', async () => {
    const alice = await createTestUser(h);
    const held = await createFeed(h.owner, { url: 'https://held.example.com/feed.xml' });
    await createSubscription(h.owner, { userId: alice.id, feedId: held.id, mode: 'training' });
    const providerBefore = await outboxCount(PROVIDER_QUEUES);
    const document = opmlDocument([
      { xmlUrl: 'https://a.example.com/feed.xml', title: 'A', folder: 'Tech' },
      { xmlUrl: 'https://b.example.com/rss', title: 'B', folder: 'Tech' },
      { xmlUrl: 'ftp://files.example.com/feed.xml', title: 'FTP' },
      { xmlUrl: 'https://c.example.com/atom.xml', title: 'C' },
      { xmlUrl: 'https://held.example.com/feed.xml', title: 'Held', folder: 'Other' },
    ]);
    const res = await importOpml(alice, document);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json();
    expect(report).toMatchObject({ added: 3, existing: 1 });
    expect(report.invalid).toEqual([
      {
        index: expect.any(Number),
        url: 'ftp://files.example.com/feed.xml',
        reason: 'unsupported_scheme',
      },
    ]);

    const rows = await subscriptions(alice.id);
    expect(rows.map((r) => [r.url, r.folder, r.inference_mode])).toEqual([
      ['https://a.example.com/feed.xml', 'Tech', 'off'],
      ['https://b.example.com/rss', 'Tech', 'off'],
      ['https://c.example.com/atom.xml', null, 'off'],
      // The existing subscription keeps its mode and folder.
      ['https://held.example.com/feed.xml', null, 'training'],
    ]);
    // Both refresh functions ran for the added feeds (the held one is a raw fixture row).
    const added = rows.filter((r) => r.url !== 'https://held.example.com/feed.xml');
    for (const row of added) expect(row.subscriber_count).toBe(1);
    // New feeds are due now: no per-feed fetch intent, and no provider demand or backfill.
    expect(
      await outboxCount(
        ['feed.fetch'],
        added.map((r) => r.feed_id),
      ),
    ).toBe(0);
    expect(await outboxCount(PROVIDER_QUEUES)).toBe(providerBefore);
    const rank = await h.owner.query(
      `SELECT payload FROM job_outbox WHERE queue = 'user.rank' AND payload->>'userId' = $1`,
      [alice.id],
    );
    expect(rank.rows.map((r) => r.payload)).toEqual([
      { userId: alice.id, reason: 'opml_import', full: true },
    ]);
  });

  it('replays the same report for a retried idempotency key', async () => {
    const alice = await createTestUser(h);
    const document = opmlDocument([{ xmlUrl: 'https://replay.example.com/feed.xml' }]);
    const key = randomUUID();
    const first = await importOpml(alice, document, { idempotencyKey: key });
    const second = await importOpml(alice, document, { idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ added: 1, existing: 0 });
    // A different file under the same key is a conflict, not a second import.
    const other = await importOpml(
      alice,
      opmlDocument([{ xmlUrl: 'https://other.example.com/feed.xml' }]),
      { idempotencyKey: key },
    );
    expect(other.statusCode).toBe(409);
    expect(await subscriptions(alice.id)).toHaveLength(1);
  });

  it('accepts opmlMaxFeeds entries, reporting the maxFeeds overflow, and rejects one more', async () => {
    const carol = await createTestUser(h);
    const res = await importOpml(carol, opmlDocument(bulk('carol', 300)));
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json();
    expect(report.added).toBe(200);
    expect(report.existing).toBe(0);
    expect(report.invalid).toHaveLength(100);
    expect(new Set(report.invalid.map((i: { reason: string }) => i.reason))).toEqual(
      new Set(['quota_exceeded']),
    );
    // Document order: the first 200 were added, the last 100 reported.
    expect(report.invalid[0].url).toBe('https://opml.example.com/carol/200.xml');
    expect(await subscriptions(carol.id)).toHaveLength(200);

    const dave = await createTestUser(h);
    const over = await importOpml(dave, opmlDocument(bulk('dave', 301)));
    expect(over.statusCode, over.body).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'opmlMaxFeeds', used: 301, max: 300 },
    });
    expect(await subscriptions(dave.id)).toHaveLength(0);
  });

  it('adds up to the remaining maxFeeds room; existing feeds use no quota', async () => {
    const erin = await createTestUser(h);
    await importOpml(erin, opmlDocument(bulk('erin', 198)));
    const res = await importOpml(
      erin,
      opmlDocument([{ xmlUrl: 'https://opml.example.com/erin/0.xml' }, ...bulk('erin-more', 3)]),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      added: 2,
      existing: 1,
      invalid: [
        { index: 3, url: 'https://opml.example.com/erin-more/2.xml', reason: 'quota_exceeded' },
      ],
    });
    expect(await subscriptions(erin.id)).toHaveLength(200);
  });

  it('rejects malformed documents and non-multipart requests with 400', async () => {
    const alice = await createTestUser(h);
    const bad = await importOpml(alice, '<opml><body><outline');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'OPML_INVALID' },
    });
    const json = await apiClient(h.server, alice).post('/subscriptions/import-opml', {
      file: 'x',
    });
    expect(json.statusCode).toBe(400);
    expect(await subscriptions(alice.id)).toHaveLength(0);
  });
});

describe('GET /subscriptions/export-opml', () => {
  it('round-trips the user’s subscriptions with title overrides and folders', async () => {
    const alice = await createTestUser(h);
    const bob = await createTestUser(h);
    const imported = await importOpml(
      alice,
      opmlDocument([
        { xmlUrl: 'https://rt1.example.com/feed.xml', title: 'One & Co', folder: 'News' },
        { xmlUrl: 'https://rt2.example.com/feed.xml', title: 'Two', folder: 'News' },
        { xmlUrl: 'https://rt3.example.com/feed.xml', title: 'Three' },
      ]),
    );
    expect(imported.json().added).toBe(3);
    const rows = await subscriptions(alice.id);
    await apiClient(h.server, alice).patch(`/subscriptions/${rows[2]!.feed_id}`, {
      titleOverride: 'Renamed three',
    });
    await createSubscription(h.owner, {
      userId: bob.id,
      feedId: (await createFeed(h.owner, { url: 'https://bob-only.example.com/feed.xml' })).id,
    });

    const res = await apiClient(h.server, alice).get('/subscriptions/export-opml');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/x-opml');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.opml"$/);
    const parsed = parseOpml(res.body);
    if (!parsed.ok) throw new Error(parsed.message);
    const entries = parsed.entries
      .map((e) => ({ url: e.canonicalUrl, folder: e.folder, title: e.title }))
      .sort((a, b) => a.url.localeCompare(b.url));
    expect(entries).toEqual([
      { url: 'https://rt1.example.com/feed.xml', folder: 'News', title: 'One & Co' },
      { url: 'https://rt2.example.com/feed.xml', folder: 'News', title: 'Two' },
      { url: 'https://rt3.example.com/feed.xml', folder: null, title: 'Renamed three' },
    ]);
    expect(res.body).not.toContain('bob-only');

    // Importing the export into a fresh account recreates the same subscriptions.
    const carol = await createTestUser(h);
    const again = await importOpml(carol, res.body);
    expect(again.json()).toEqual({ added: 3, existing: 0, invalid: [] });
    expect((await subscriptions(carol.id)).map((r) => [r.url, r.folder])).toEqual(
      rows.map((r) => [r.url, r.folder]),
    );
  });
});
