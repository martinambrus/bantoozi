import { createHash } from 'node:crypto';

import { createDatabase, clearHotBodiesPage, markSnapshotsColdPage } from '@bantoozi/db';
import { MeExportSchema } from '@bantoozi/shared';
import { createArticle, createFeed, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiClient,
  createApiHarness,
  createTestUser,
  type ApiHarness,
  type TestUser,
} from './support/harness.js';

/**
 * Launch checklist item 14 (spec 11 §9, spec 02 §3.5): a bookmark's export carries the snapshot
 * exactly as stored. The checksum the capture function wrote (`snapshot_content_sha256`, computed
 * by `capture_bookmark_snapshot`, not a placeholder) equals the checksum recomputed from the
 * exported text/HTML, before and after cold maintenance (`house.purge-bodies`'s cold step).
 */

let h: ApiHarness;
let user: TestUser;
let articleId: string;
let snapshotId: string;

const TITLE = 'Košice "quotes", backslash \\ and <b>markup</b>';
const AUTHOR = 'Ľudmila Ďurčová';
const TEXT = 'První odstavec\nDruhý odstavec s emoji ✓ a "uvozovkami" & ampersandom.';
const HTML =
  '<p>První odstavec</p>\n<p>Druhý odstavec s emoji ✓ a &quot;uvozovkami&quot; &amp; ampersandom.</p>';

beforeAll(async () => {
  h = await createApiHarness();
  user = await createTestUser(h);
  const feed = await createFeed(h.owner, { title: 'Checksum feed' });
  await createSubscription(h.owner, { userId: user.id, feedId: feed.id });
  const article = await createArticle(h.owner, {
    feedIds: [feed.id],
    title: TITLE,
    author: AUTHOR,
    publishedAt: new Date('2026-03-04T05:06:07.089Z'),
  });
  articleId = article.id;
  await h.owner.query(
    `INSERT INTO article_bodies (article_id, article_revision, status, body_text, body_html,
                                 completeness, extractor_version, extracted_at)
     VALUES ($1, $2, 'ok', $3, $4, 'complete', 'readability-v1', now() - interval '1 hour')`,
    [articleId, article.contentRevision, TEXT, HTML],
  );
  // The real capture function, as the API role in the user's tenant transaction.
  const client = await h.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
    await client.query('SELECT * FROM capture_bookmark_snapshot($1, NULL)', [articleId]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const row = await h.owner.query<{ id: string }>(
    'SELECT bookmark_snapshot_id::text AS id FROM user_article WHERE user_id = $1 AND article_id = $2',
    [user.id, articleId],
  );
  snapshotId = row.rows[0]!.id;
});

afterAll(async () => {
  await h.close();
});

/** Canonical checksum input of spec 02 §3.5: the jsonb text of [title, author, published, url, text, html]. */
function recompute(snapshot: {
  title: string;
  author: string | null;
  publishedAt: string | null;
  sourceUrl: string | null;
  text: string;
  html: string | null;
}): string {
  const published =
    snapshot.publishedAt === null
      ? null
      : new Date(snapshot.publishedAt).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  const items = [
    snapshot.title,
    snapshot.author,
    published,
    snapshot.sourceUrl,
    snapshot.text,
    snapshot.html,
  ];
  const text = `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function exportedSnapshot() {
  const res = await apiClient(h.server, user).get('/me/export');
  expect(res.statusCode, res.body).toBe(200);
  const document = MeExportSchema.parse(JSON.parse(res.body));
  expect(document.bookmarks).toHaveLength(1);
  const snapshot = document.bookmarks[0]!.snapshot;
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

async function stored() {
  const result = await h.owner.query<{
    content_sha256: string;
    sql_sha: string;
    cold: boolean;
    body_text: string;
    body_html: string | null;
  }>(
    `SELECT content_sha256, cold_at IS NOT NULL AS cold, body_text, body_html,
            snapshot_content_sha256(title, author, published_at, source_url, body_text, body_html) AS sql_sha
       FROM article_snapshots WHERE id = $1`,
    [snapshotId],
  );
  return result.rows[0]!;
}

describe('export checksum (spec 11 §9 item 14)', () => {
  it('equals the stored checksum when recomputed over the exported snapshot, also after cold maintenance', async () => {
    const before = await stored();
    expect(before.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(before.cold).toBe(false);

    const hot = await exportedSnapshot();
    expect(hot).toMatchObject({ id: snapshotId, text: TEXT, html: HTML, title: TITLE });
    expect(recompute(hot)).toBe(before.content_sha256);
    expect(before.sql_sha).toBe(before.content_sha256);

    // Thirty-one days later (the purge steps take `now` as input): the cold step verifies the checksum, then hot bodies are cleared.
    const db = createDatabase(h.worker);
    const now = new Date(Date.now() + 31 * 86_400_000);
    const cold = await db.transaction((tx) =>
      markSnapshotsColdPage(tx, { now, after: null, limit: 100 }),
    );
    expect(cold.mismatched).toBe(0);
    expect(cold.changed).toBeGreaterThanOrEqual(1);
    await db.transaction((tx) => clearHotBodiesPage(tx, { now, after: null, limit: 100 }));
    const body = await h.owner.query<{ body_text: string | null; body_html: string | null }>(
      'SELECT body_text, body_html FROM article_bodies WHERE article_id = $1',
      [articleId],
    );
    expect(body.rows[0]).toEqual({ body_text: null, body_html: null });

    const after = await stored();
    expect(after.cold).toBe(true);
    expect(after.content_sha256).toBe(before.content_sha256);
    expect(after.body_text).toBe(TEXT);

    const coldExport = await exportedSnapshot();
    expect(coldExport.text).toBe(TEXT);
    expect(coldExport.html).toBe(HTML);
    expect(recompute(coldExport)).toBe(after.content_sha256);
  });
});
