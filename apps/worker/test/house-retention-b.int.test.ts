import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';
import { RetentionWorld } from './support/retention-world.js';
import { DAY, MINUTE, RetentionBWorld } from './support/retention-b-world.js';

/**
 * M8-T2 (PLAN §14, spec 11 §5, §5.2, §6): `house.purge-articles` and `house.purge-bodies`, through
 * the registered handlers against a migrated database. The clock of most runs is a fake `NOW` 100
 * days after the real one and every fixture is placed relative to it, so a handler that reads the
 * database clock sees a different world; each boundary is probed one minute on either side. Saved
 * articles, unbookmark with its Undo pin and undo go through the real API action functions. Effects
 * are read from the database only.
 *
 * `mark_snapshot_if_unreferenced` stamps the database clock, so the tests of the unreferenced grace
 * run on clocks near the real one and read the stamp back before probing its 7-day boundary.
 */

const NOW = new Date(Date.now() + 100 * DAY);
const HOUR = 60 * MINUTE;
const before = (ms: number): Date => new Date(NOW.getTime() - ms);
const after = (ms: number): Date => new Date(NOW.getTime() + ms);
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

const PURGE_ARTICLES = 'house.purge-articles' as const;
const PURGE_BODIES = 'house.purge-bodies' as const;

let h: ClassifyHarness;
let w: RetentionWorld;
let b: RetentionBWorld;

beforeAll(async () => {
  h = await ClassifyHarness.start();
  w = new RetentionWorld(h);
  b = new RetentionBWorld(w);
}, 240_000);

afterAll(async () => {
  await w?.close();
  await h?.close();
});

/** The unreferenced stamp of a snapshot, which must be set. */
async function stamp(snapshotId: string): Promise<Date> {
  const row = await b.snapshot(snapshotId);
  expect(row).not.toBeNull();
  expect(row!.unreferenced_at).not.toBeNull();
  return row!.unreferenced_at!;
}

// ── house.purge-articles ─────────────────────────────────────────────────────────────────────

describe('house.purge-articles', () => {
  it('deletes an article 90 days after its latest carrier arrival, not one minute earlier', async () => {
    const feed = await b.feed();
    const other = await b.feed();
    const stale = await w.article([{ feedId: feed, at: before(90 * DAY + MINUTE) }]);
    const fresh = await w.article([{ feedId: feed, at: before(90 * DAY - MINUTE) }]);
    // The latest carrier decides, whatever the earlier sighting or `articles.first_seen_at` say.
    const reCarried = await w.article(
      [
        { feedId: feed, at: before(200 * DAY) },
        { feedId: other, at: before(90 * DAY - MINUTE) },
      ],
      before(200 * DAY),
    );
    const bothOld = await w.article(
      [
        { feedId: feed, at: before(200 * DAY) },
        { feedId: other, at: before(90 * DAY + MINUTE) },
      ],
      before(200 * DAY),
    );
    const clockSkew = await w.article(
      [{ feedId: feed, at: before(90 * DAY + MINUTE) }],
      before(DAY),
    );
    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(stale)).toBe(false);
    expect(await b.articleExists(fresh)).toBe(true);
    expect(await b.articleExists(reCarried)).toBe(true);
    expect(await b.articleExists(bothOld)).toBe(false);
    expect(await b.articleExists(clockSkew)).toBe(false);
  });

  it('removes the article with its carrier rows, body, reader state and feedback', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const id = await w.article([{ feedId: feed, at: before(91 * DAY) }]);
    await b.body(id, { extractedAt: before(91 * DAY) });
    await w.read(user, id, new Date());
    const count = async (table: string): Promise<number> =>
      (
        await b.rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE article_id = $1`,
          [id],
        )
      )[0]!.n;
    expect(await count('user_article')).toBe(1);
    expect(await count('feedback_events')).toBeGreaterThan(0);
    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(id)).toBe(false);
    for (const table of ['feed_items', 'article_bodies', 'user_article', 'feedback_events']) {
      expect(await count(table), table).toBe(0);
    }
  });

  it('keeps an article a user bookmarked, rated or labelled, but not one with only undone feedback', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const old = before(200 * DAY);
    const bookmarked = (await b.saved({ arrival: old, userId: user, feedId: feed })).articleId;
    const rated = await w.article([{ feedId: feed, at: old }]);
    await w.rate(user, rated, new Date(), 1);
    const labelled = await w.article([{ feedId: feed, at: old }]);
    await w.label(user, labelled, new Date());
    const unrated = await w.article([{ feedId: feed, at: old }]);
    await w.rate(user, unrated, new Date(), 1);
    await w.rate(user, unrated, new Date(), null);
    const readOnly = await w.article([{ feedId: feed, at: old }]);
    await w.read(user, readOnly, new Date());
    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(bookmarked)).toBe(true);
    expect(await b.articleExists(rated)).toBe(true);
    expect(await b.articleExists(labelled)).toBe(true);
    expect(await b.articleExists(unrated)).toBe(false);
    expect(await b.articleExists(readOnly)).toBe(false);
  });

  it('keeps an article while an Undo pin or the unreferenced grace holds its snapshot, and removes it with the elapsed ones', async () => {
    const old = before(200 * DAY);
    const t1 = after(9 * MINUTE);
    const t2 = after(11 * MINUTE);
    // Unbookmarked at NOW: the pin lives until NOW + 10 minutes, whatever the mark says.
    const pinned = await b.saved({ arrival: old });
    await b.unbookmark(pinned.userId, pinned.articleId, NOW);
    await b.mark(pinned.snapshotId, at(t1, -8 * DAY));
    expect(await b.pins(pinned.snapshotId)).toBe(1);
    // Unbookmarked in real time: its pin has elapsed on the fake clock; only the grace is left.
    const inGrace = await b.saved({ arrival: old });
    await b.unbookmark(inGrace.userId, inGrace.articleId, new Date());
    await b.mark(inGrace.snapshotId, at(t1, -7 * DAY + MINUTE));
    const graceOver = await b.saved({ arrival: old });
    await b.unbookmark(graceOver.userId, graceOver.articleId, new Date());
    await b.mark(graceOver.snapshotId, at(t1, -7 * DAY - MINUTE));

    await b.run(PURGE_ARTICLES, t1);
    expect(await b.articleExists(pinned.articleId)).toBe(true);
    expect(await b.snapshot(pinned.snapshotId)).not.toBeNull();
    expect(await b.articleExists(inGrace.articleId)).toBe(true);
    expect(await b.snapshot(inGrace.snapshotId)).not.toBeNull();
    expect(await b.articleExists(graceOver.articleId)).toBe(false);
    expect(await b.snapshot(graceOver.snapshotId)).toBeNull();
    expect(await b.pins(graceOver.snapshotId)).toBe(0);

    await b.run(PURGE_ARTICLES, t2);
    expect(await b.articleExists(pinned.articleId)).toBe(false);
    expect(await b.snapshot(pinned.snapshotId)).toBeNull();
    expect(await b.pins(pinned.snapshotId)).toBe(0);
  });

  it('keeps an article whose analysis request is within its 180-day retention, deleting it with the expired one', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const old = before(200 * DAY);
    const retained = await w.article([{ feedId: feed, at: old }]);
    await b.analysisRequest(user, feed, retained, before(180 * DAY - MINUTE));
    const retainedPending = await w.article([{ feedId: feed, at: old }]);
    await b.analysisRequest(user, feed, retainedPending, before(180 * DAY - MINUTE), 'pending');
    const expired = await w.article([{ feedId: feed, at: old }]);
    await b.analysisRequest(user, feed, expired, before(180 * DAY + MINUTE));
    const none = await w.article([{ feedId: feed, at: old }]);
    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(retained)).toBe(true);
    expect(await b.articleExists(retainedPending)).toBe(true);
    expect(await b.articleExists(expired)).toBe(false);
    expect(await b.articleExists(none)).toBe(false);
    const requests = await b.rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM analysis_requests WHERE article_id = ANY($1::bigint[])`,
      [[retained, retainedPending]],
    );
    expect(requests[0]!.n).toBe(2);
  });

  it('never purges an article the golden set references', async () => {
    const feed = await b.feed();
    const old = before(400 * DAY);
    const sampled = await w.article([{ feedId: feed, at: old }]);
    await b.evalSample(sampled);
    const labelled = await w.article([{ feedId: feed, at: old }]);
    await b.evalFacetLabel(labelled);
    const plain = await w.article([{ feedId: feed, at: old }]);
    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(sampled)).toBe(true);
    expect(await b.articleExists(labelled)).toBe(true);
    expect(await b.articleExists(plain)).toBe(false);
    expect(await b.exists('SELECT 1 FROM eval.sample WHERE article_id = $1', sampled)).toBe(true);
    expect(await b.exists('SELECT 1 FROM eval.facet_labels WHERE article_id = $1', labelled)).toBe(
      true,
    );
  });

  it('deletes a cluster whose last member was purged unless a mute_story rule names it', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const oldArticle = (): Promise<string> => w.article([{ feedId: feed, at: before(200 * DAY) }]);
    const lone = await oldArticle();
    const loneCluster = await b.storyCluster([lone]);
    const mixedOld = await oldArticle();
    const mixedYoung = await w.article([{ feedId: feed, at: before(10 * DAY) }]);
    const mixedCluster = await b.storyCluster([mixedOld, mixedYoung]);
    const muted = await oldArticle();
    const mutedCluster = await b.storyCluster([muted]);
    await b.muteStory(user, mutedCluster, after(HOUR));
    const emptyCluster = await b.storyCluster([]);

    await b.run(PURGE_ARTICLES, NOW);
    expect(await b.articleExists(lone)).toBe(false);
    expect(await b.cluster(loneCluster)).toBe(false);
    expect(await b.cluster(emptyCluster)).toBe(false);
    expect(await b.cluster(mutedCluster)).toBe(true);
    expect(await b.cluster(mixedCluster)).toBe(true);
    const mixed = await b.rows<{ size: number; representative: string }>(
      `SELECT size, representative_article_id::text AS representative
         FROM story_clusters WHERE id = $1`,
      [mixedCluster],
    );
    expect(mixed[0]).toEqual({ size: 1, representative: mixedYoung });

    // The rule expires and is deleted by its own job; the next purge then removes the cluster.
    const later = after(2 * HOUR);
    await b.run('house.expire-rules', later);
    expect(await b.exists(`SELECT 1 FROM user_rules WHERE value = $1`, mutedCluster)).toBe(false);
    await b.run(PURGE_ARTICLES, later);
    expect(await b.cluster(mutedCluster)).toBe(false);
    expect(await b.cluster(mixedCluster)).toBe(true);
  });

  describe('idle feeds', () => {
    const idleSince = before(30 * DAY + MINUTE);

    it('deletes a feed 30 days past its last subscription with its inherit preferences, and keeps every feed something still references', async () => {
      const user = await b.user();
      const prefer = async (feedId: string, policy: 'inherit' | 'allow' | 'block') => {
        await b.owner.query(
          `INSERT INTO user_feed_preferences (user_id, feed_id, image_policy) VALUES ($1, $2, $3)`,
          [user, feedId, policy],
        );
      };
      const idle = async (): Promise<string> => {
        const feed = await b.feed();
        await b.idleFeed(feed, idleSince);
        return feed;
      };

      const purged = await idle();
      const inheritOnly = await idle();
      await prefer(inheritOnly, 'inherit');
      const inGrace = await b.feed();
      await b.idleFeed(inGrace, before(30 * DAY - MINUTE));
      const resubscribed = await b.subscribedFeed([user]);
      const allow = await idle();
      await prefer(allow, 'allow');
      const block = await idle();
      await prefer(block, 'block');
      const target = await idle();
      const mergedAway = await b.feed();
      await b.owner.query(`UPDATE feeds SET status = 'dead', merged_into_id = $2 WHERE id = $1`, [
        mergedAway,
        target,
      ]);
      await b.idleFeed(mergedAway, NOW);
      const rated = await idle();
      await b.evalRaterFeed(rated);

      // A bookmarked article keeps its feed_items, and so its feed, after the subscription ended.
      const reader = await b.user();
      const saved = await b.saved({ arrival: before(200 * DAY), userId: reader });
      await b.owner.query(`DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2`, [
        reader,
        saved.feedId,
      ]);
      await b.idleFeed(saved.feedId, idleSince);

      // A feed left idle by the purge of its last article goes in the same pass of the job.
      const chained = await idle();
      const chainedArticle = await w.article([{ feedId: chained, at: before(200 * DAY) }]);

      await b.run(PURGE_ARTICLES, NOW);
      await b.run(PURGE_ARTICLES, NOW);
      expect(await b.feedExists(purged)).toBe(false);
      expect(await b.feedExists(inheritOnly)).toBe(false);
      expect(
        await b.exists('SELECT 1 FROM user_feed_preferences WHERE feed_id = $1', inheritOnly),
      ).toBe(false);
      expect(await b.feedExists(inGrace)).toBe(true);
      expect(await b.feedExists(resubscribed)).toBe(true);
      expect(await b.feedExists(allow)).toBe(true);
      expect(await b.feedExists(block)).toBe(true);
      expect(await b.exists('SELECT 1 FROM user_feed_preferences WHERE feed_id = $1', allow)).toBe(
        true,
      );
      expect(await b.feedExists(target)).toBe(true);
      expect(await b.feedExists(mergedAway)).toBe(true);
      expect(await b.feedExists(rated)).toBe(true);
      expect(await b.feedExists(saved.feedId)).toBe(true);
      expect(await b.articleExists(saved.articleId)).toBe(true);
      expect(await b.articleExists(chainedArticle)).toBe(false);
      expect(await b.feedExists(chained)).toBe(false);
    });
  });

  it('gives the same result when run twice', async () => {
    const user = await b.user();
    const feed = await b.subscribedFeed([user]);
    const idle = await b.feed();
    await b.idleFeed(idle, before(40 * DAY));
    const stale = await w.article([{ feedId: feed, at: before(95 * DAY) }]);
    const staleCluster = await b.storyCluster([stale]);
    const fresh = await w.article([{ feedId: feed, at: before(5 * DAY) }]);
    const saved = await b.saved({ arrival: before(300 * DAY), userId: user, feedId: feed });
    const orphan = await b.saved({ arrival: before(300 * DAY) });
    await b.unbookmark(orphan.userId, orphan.articleId, new Date());
    await b.mark(orphan.snapshotId, before(8 * DAY));

    const state = async (): Promise<boolean[]> => [
      await b.articleExists(stale),
      await b.articleExists(fresh),
      await b.articleExists(saved.articleId),
      await b.articleExists(orphan.articleId),
      (await b.snapshot(orphan.snapshotId)) !== null,
      (await b.snapshot(saved.snapshotId)) !== null,
      await b.cluster(staleCluster),
      await b.feedExists(idle),
      await b.feedExists(feed),
    ];
    await b.run(PURGE_ARTICLES, NOW);
    const first = await state();
    expect(first).toEqual([false, true, true, false, false, true, false, false, true]);
    await b.run(PURGE_ARTICLES, NOW);
    expect(await state()).toEqual(first);
  });

  it('works through more than one batch of expired articles within a few runs', async () => {
    const feed = await b.feed();
    const ids = await w.bulkUnread([], feed, 5_200, before(100 * DAY));
    const remaining = async (): Promise<number> =>
      (
        await b.rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM articles WHERE id = ANY($1::bigint[])`,
          [ids],
        )
      )[0]!.n;
    let runs = 0;
    while ((await remaining()) > 0 && runs < 3) {
      await b.run(PURGE_ARTICLES, NOW);
      runs += 1;
    }
    expect(await remaining()).toBe(0);
    await b.run(PURGE_ARTICLES, NOW);
    expect(await remaining()).toBe(0);
  }, 180_000);
});

// ── house.purge-bodies ───────────────────────────────────────────────────────────────────────

describe('house.purge-bodies', () => {
  it('clears an unprotected hot body 30 days after extraction, keeping body_lead, and not one minute earlier', async () => {
    const feed = await b.feed();
    const make = async (age: number): Promise<string> => {
      const arrival = before(age);
      const id = await w.article([{ feedId: feed, at: arrival }]);
      await b.body(id, { extractedAt: arrival, lead: 'THE LEAD' });
      return id;
    };
    const old = await make(30 * DAY + MINUTE);
    const young = await make(30 * DAY - MINUTE);
    await b.run(PURGE_BODIES, NOW);
    expect(await b.hot(old)).toEqual({ text: false, html: false, lead: 'THE LEAD' });
    expect(await b.hot(young)).toEqual({ text: true, html: true, lead: 'THE LEAD' });
  });

  it('keeps the hot body a pending capture needs, and clears the one a durable snapshot has made redundant', async () => {
    const arrival = before(45 * DAY);
    const pending = await b.saved({ arrival, completeness: 'partial' });
    expect(pending.captureStatus).toBe('pending');
    const satisfied = await b.saved({ arrival });
    expect(satisfied.captureStatus).toBe('saved');
    const unprotected = await w.article([{ feedId: pending.feedId, at: arrival }]);
    await b.body(unprotected, { extractedAt: arrival });
    await b.run(PURGE_BODIES, NOW);
    expect(await b.hot(pending.articleId)).toMatchObject({ text: true, html: true });
    expect(await b.hot(satisfied.articleId)).toMatchObject({ text: false, html: false });
    expect(await b.hot(unprotected)).toMatchObject({ text: false, html: false });
    expect(await b.snapshot(satisfied.snapshotId)).not.toBeNull();
  });

  it('keeps the hot body of a bookmark whose capture failed', async () => {
    const failed = await b.saved({ arrival: before(45 * DAY), completeness: 'partial' });
    await b.owner.query(
      `UPDATE user_article SET bookmark_capture_status = 'failed', bookmark_capture_error_code = 'fetch_failed'
        WHERE user_id = $1 AND article_id = $2`,
      [failed.userId, failed.articleId],
    );
    await b.run(PURGE_BODIES, NOW);
    expect(await b.hot(failed.articleId)).toMatchObject({ text: true, html: true });
  });

  it('marks a bookmark snapshot cold at 30 days and removes the redundant hot copy, as the e2e hook simulates', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY), text: 'Kept in the snapshot.' });
    const snapshot = await b.snapshot(saved.snapshotId);
    expect(snapshot!.cold_at).toBeNull();
    await b.run(PURGE_BODIES, NOW);
    const cold = await b.snapshot(saved.snapshotId);
    expect(cold!.cold_at).not.toBeNull();
    expect(cold!.body_text).toBe('Kept in the snapshot.');
    expect(cold!.body_html).toBe('<p>Kept in the snapshot.</p>');
    expect(await b.hot(saved.articleId)).toMatchObject({ text: false, html: false });
  });

  it('marks a snapshot cold exactly 30 days after its capture', async () => {
    const day = new Date(Date.now() - DAY);
    const saved = await b.saved({ arrival: day });
    const captured = (await b.snapshot(saved.snapshotId))!.captured_at;
    await b.run(PURGE_BODIES, at(captured, 30 * DAY - MINUTE));
    expect((await b.snapshot(saved.snapshotId))!.cold_at).toBeNull();
    await b.run(PURGE_BODIES, at(captured, 30 * DAY + MINUTE));
    expect((await b.snapshot(saved.snapshotId))!.cold_at).not.toBeNull();
  });

  it('reads a snapshot back byte-identical after cold compression, compressible or not', async () => {
    const compressible = 'Zażółć gęślą jaźń, 日本語のテキスト 😀 — lossless. '.repeat(6_000);
    const incompressible = randomBytes(150_000).toString('base64');
    const cases = [
      { text: compressible, html: `<article><p>${compressible}</p></article>` },
      { text: incompressible, html: `<pre>${incompressible}</pre>` },
      { text: 'short', html: null },
      { text: `${compressible}${incompressible}`, html: `<p>${incompressible}</p>` },
    ];
    const saved = [];
    for (const c of cases) {
      saved.push(await b.saved({ arrival: before(100 * DAY), text: c.text, html: c.html }));
    }
    await b.run(PURGE_BODIES, NOW);
    for (const [index, c] of cases.entries()) {
      const row = (await b.snapshot(saved[index]!.snapshotId))!;
      expect(row.cold_at, `case ${index}`).not.toBeNull();
      expect(row.body_text === c.text, `text of case ${index}`).toBe(true);
      expect(row.body_html === c.html, `html of case ${index}`).toBe(true);
      expect(Buffer.byteLength(row.body_text)).toBe(Buffer.byteLength(c.text));
      expect(row.recomputed_sha256).toBe(row.content_sha256);
    }
  }, 60_000);

  it('never deletes the snapshot of a retained bookmark, however old, cold or stale-marked', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const stale = await b.saved({ arrival: before(100 * DAY) });
    await b.mark(stale.snapshotId, before(30 * DAY));
    for (const clock of [NOW, after(400 * DAY)]) await b.run(PURGE_BODIES, clock);
    for (const s of [saved, stale]) {
      expect(await b.snapshot(s.snapshotId)).not.toBeNull();
      expect(await b.bookmarkOf(s.userId, s.articleId)).toEqual({
        snapshotId: s.snapshotId,
        captureStatus: 'saved',
      });
    }
    expect((await b.snapshot(saved.snapshotId))!.unreferenced_at).toBeNull();
  });

  it('collects a snapshot 7 days after its last release, once the Undo pin has gone and been re-marked', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const released = new Date();
    await b.unbookmark(saved.userId, saved.articleId, released);
    // The pin cleared the mark that the unbookmark set; nothing marks it again by itself.
    expect(await b.pins(saved.snapshotId)).toBe(1);
    expect((await b.snapshot(saved.snapshotId))!.unreferenced_at).toBeNull();

    await b.run(PURGE_BODIES, at(released, 5 * MINUTE));
    expect(await b.pins(saved.snapshotId)).toBe(1);
    expect((await b.snapshot(saved.snapshotId))!.unreferenced_at).toBeNull();

    await b.run(PURGE_BODIES, at(released, 11 * MINUTE));
    expect(await b.pins(saved.snapshotId)).toBe(0);
    const marked = await stamp(saved.snapshotId);

    await b.run(PURGE_BODIES, at(marked, 7 * DAY - MINUTE));
    expect(await b.snapshot(saved.snapshotId)).not.toBeNull();
    await b.run(PURGE_BODIES, at(marked, 7 * DAY + MINUTE));
    expect(await b.snapshot(saved.snapshotId)).toBeNull();
    expect(await b.articleExists(saved.articleId)).toBe(true);
  });

  it('marks a snapshot whose receipt, and so its pin, was purged without a release', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const released = new Date();
    const { mutationId } = await b.unbookmark(saved.userId, saved.articleId, released);
    await b.owner.query(`DELETE FROM api_mutations WHERE user_id = $1 AND id = $2`, [
      saved.userId,
      mutationId,
    ]);
    expect(await b.pins(saved.snapshotId)).toBe(0);
    expect((await b.snapshot(saved.snapshotId))!.unreferenced_at).toBeNull();

    await b.run(PURGE_BODIES, at(released, HOUR));
    const marked = await stamp(saved.snapshotId);
    await b.run(PURGE_BODIES, at(marked, 7 * DAY - MINUTE));
    expect(await b.snapshot(saved.snapshotId)).not.toBeNull();
    await b.run(PURGE_BODIES, at(marked, 7 * DAY + MINUTE));
    expect(await b.snapshot(saved.snapshotId)).toBeNull();
  });

  it('collects exactly at the 7-day boundary of the unreferenced stamp', async () => {
    const orphan = async (marked: Date) => {
      const saved = await b.saved({ arrival: before(100 * DAY) });
      const { mutationId } = await b.unbookmark(saved.userId, saved.articleId, new Date());
      await b.owner.query(`DELETE FROM api_mutations WHERE user_id = $1 AND id = $2`, [
        saved.userId,
        mutationId,
      ]);
      await b.mark(saved.snapshotId, marked);
      return saved;
    };
    const over = await orphan(before(7 * DAY + MINUTE));
    const within = await orphan(before(7 * DAY - MINUTE));
    await b.run(PURGE_BODIES, NOW);
    expect(await b.snapshot(over.snapshotId)).toBeNull();
    const kept = await b.snapshot(within.snapshotId);
    expect(kept).not.toBeNull();
    expect(kept!.unreferenced_at!.getTime()).toBe(before(7 * DAY - MINUTE).getTime());
  });

  it('never collects a snapshot another user still has bookmarked', async () => {
    const first = await b.saved({ arrival: before(100 * DAY) });
    const second = await b.user();
    const feed = await b.subscribedFeed([second]);
    await b.alsoSave(second, feed, first.articleId);
    const theirs = await b.bookmarkOf(second, first.articleId);
    expect(theirs.snapshotId).toBe(first.snapshotId);
    const released = new Date();
    await b.unbookmark(first.userId, first.articleId, released);
    await b.run(PURGE_BODIES, at(released, 11 * MINUTE));
    for (const clock of [NOW, after(400 * DAY)]) await b.run(PURGE_BODIES, clock);
    const row = await b.snapshot(first.snapshotId);
    expect(row).not.toBeNull();
    expect(row!.unreferenced_at).toBeNull();
    expect(await b.bookmarkOf(second, first.articleId)).toEqual(theirs);
  });

  it('cancels the collection when the article is bookmarked again during the grace', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const released = new Date();
    await b.unbookmark(saved.userId, saved.articleId, released);
    await b.run(PURGE_BODIES, at(released, 11 * MINUTE));
    const marked = await stamp(saved.snapshotId);
    await w.bookmark(saved.userId, saved.articleId, new Date());
    expect(await b.bookmarkOf(saved.userId, saved.articleId)).toMatchObject({
      snapshotId: saved.snapshotId,
    });
    await b.run(PURGE_BODIES, at(marked, 7 * DAY + HOUR));
    expect(await b.snapshot(saved.snapshotId)).not.toBeNull();
    expect((await b.snapshot(saved.snapshotId))!.unreferenced_at).toBeNull();
  });

  it('keeps the snapshot of an unbookmark that was undone', async () => {
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const released = new Date();
    const { mutationId } = await b.unbookmark(saved.userId, saved.articleId, released);
    await b.undo(saved.userId, mutationId, new Date());
    expect(await b.bookmarkOf(saved.userId, saved.articleId)).toMatchObject({
      snapshotId: saved.snapshotId,
    });
    for (const clock of [at(released, 11 * MINUTE), NOW, after(400 * DAY)]) {
      await b.run(PURGE_BODIES, clock);
    }
    expect(await b.snapshot(saved.snapshotId)).not.toBeNull();
    expect(await b.bookmarkOf(saved.userId, saved.articleId)).toMatchObject({
      snapshotId: saved.snapshotId,
    });
  });

  it('gives the same result when run twice', async () => {
    const feed = await b.feed();
    const hotArrival = before(40 * DAY);
    const hot = await w.article([{ feedId: feed, at: hotArrival }]);
    await b.body(hot, { extractedAt: hotArrival });
    const saved = await b.saved({ arrival: before(100 * DAY) });
    const released = await b.saved({ arrival: before(100 * DAY) });
    const { mutationId } = await b.unbookmark(released.userId, released.articleId, new Date());
    await b.owner.query(`DELETE FROM api_mutations WHERE user_id = $1 AND id = $2`, [
      released.userId,
      mutationId,
    ]);
    await b.mark(released.snapshotId, before(8 * DAY));
    const keptMark = await b.saved({ arrival: before(100 * DAY) });
    await b.unbookmark(keptMark.userId, keptMark.articleId, new Date());
    await b.owner.query(`DELETE FROM api_mutations WHERE user_id = $1`, [keptMark.userId]);
    await b.mark(keptMark.snapshotId, before(2 * DAY));

    const state = async (): Promise<unknown> => ({
      hot: await b.hot(hot),
      saved: await b.snapshot(saved.snapshotId),
      savedHot: await b.hot(saved.articleId),
      released: await b.snapshot(released.snapshotId),
      keptMark: await b.snapshot(keptMark.snapshotId),
    });
    await b.run(PURGE_BODIES, NOW);
    const first = (await state()) as {
      hot: unknown;
      saved: { cold_at: Date | null } | null;
      released: unknown;
      keptMark: { unreferenced_at: Date | null } | null;
    };
    expect(first.hot).toMatchObject({ text: false, html: false });
    expect(first.saved!.cold_at).not.toBeNull();
    expect(first.released).toBeNull();
    expect(first.keptMark!.unreferenced_at!.getTime()).toBe(before(2 * DAY).getTime());
    await b.run(PURGE_BODIES, NOW);
    expect(await state()).toEqual(first);
  });
});
