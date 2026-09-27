import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY, HOUR, MINUTE, ago } from './support/classify.js';

/**
 * M2-T9 `card.backfill` (spec 05 §5.4) through the real handler: pages of 500 with the 2/6
 * priorities and a durable continuation, the skip rule for current primary answers, and admission —
 * a backfill never expands authorization to off, unselected or pre-activation arrivals.
 */

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  await h.clearOutbox();
});

/** `count` extracted articles of `feedId`, first seen 1…count minutes ago (newest first). */
async function bulkArticles(feedId: string, count: number, tag: string): Promise<string[]> {
  const result = await h.owner.query<{ id: string }>(
    `WITH a AS (
       INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt, first_seen_at,
                             content_hash, pipeline_state, lang)
       SELECT 'https://bulk.example.test/' || $2 || '/' || g, 'https://bulk.example.test/' || $2 || '/' || g,
              'bulk.example.test/' || $2 || '/' || g, 'Bulk ' || $2 || ' ' || g, 'bulk ' || $2 || ' ' || g,
              'Excerpt ' || g, now() - make_interval(mins => g), md5($2 || g), 'extracted', 'en'
         FROM generate_series(1, $3::int) AS g
       RETURNING id, first_seen_at)
     INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
     SELECT $1, id, 'bulk-' || id, first_seen_at FROM a
     RETURNING article_id::text AS id, first_seen_at`,
    [feedId, tag, count],
  );
  // Newest first: 1 minute ago is the first article of the first page.
  return result.rows
    .map((row) => row as unknown as { id: string; first_seen_at: Date })
    .sort((x, y) => y.first_seen_at.getTime() - x.first_seen_at.getTime())
    .map((row) => row.id);
}

/** Every queue row of these articles, keyed by article id. */
async function rowsOf(articleIds: readonly string[]) {
  const result = await h.owner.query<{
    article_id: string;
    card_id: string;
    priority: number;
    user_id: string | null;
    revision: string;
    lease_token: string | null;
  }>(
    `SELECT article_id::text AS article_id, card_id::text AS card_id, priority,
            user_id::text AS user_id, article_revision::text AS revision,
            lease_token::text AS lease_token
       FROM match_queue WHERE article_id = ANY($1::bigint[])
      ORDER BY match_queue.article_id, match_queue.card_id`,
    [articleIds],
  );
  return result.rows;
}

/** A reader of a new feed (active since 30 days by default) holding one shared card. */
async function reader(options: { plan?: string; mode?: 'off' | 'training' | 'active' } = {}) {
  const userId = await h.user(options.plan ?? 'beta');
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, options.mode ?? 'active', ago(30 * DAY));
  const cardId = await h.heldCard(userId);
  return { userId, feedId, cardId };
}

describe('card.backfill pages (spec 05 §5.4 steps 2–5)', () => {
  it('queues the newest 500 at priorities 2/6 and continues below the cursor until the window is covered', async () => {
    const r = await reader();
    const ids = await bulkArticles(r.feedId, 520, 'pages');

    const since = await h.mark();
    await h.dispatch('card.backfill', { userId: r.userId, cardIds: [r.cardId] });

    const first = await rowsOf(ids);
    const byArticle = new Map(first.map((row) => [row.article_id, row]));
    expect(first).toHaveLength(500);
    ids.slice(0, 500).forEach((id, index) => {
      expect(byArticle.get(id)).toMatchObject({
        card_id: r.cardId,
        priority: index < 50 ? 2 : 6,
        user_id: r.userId,
        revision: '1',
      });
    });
    for (const id of ids.slice(500)) expect(byArticle.has(id)).toBe(false);
    // Extracted articles only queue their pairs: matching waits for enrichment.
    expect(await h.payloads('article.match', since)).toEqual([]);
    expect(await h.payloads('article.enrich', since)).toEqual([]);

    const continuation = await h.payloads('card.backfill', since);
    const key = await h.owner.query<{ key: string }>(
      `SELECT to_char(first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key
         FROM feed_items WHERE article_id = $1`,
      [ids[499]],
    );
    expect(continuation).toEqual([
      {
        userId: r.userId,
        cardIds: [r.cardId],
        snapshotAt: expect.any(String),
        cursor: { firstSeenAt: key.rows[0]?.key, articleId: ids[499] },
        processedCount: 500,
      },
    ]);

    // The continuation covers the rest at priority 6 (the interactive allowance never restarts)
    // and, with a short page, records no further continuation.
    const next = await h.mark();
    expect(await h.run('card.backfill')).toBe(1);
    const all = await rowsOf(ids);
    expect(all).toHaveLength(520);
    const rest = all.filter((row) => ids.slice(500).includes(row.article_id));
    expect(rest).toHaveLength(20);
    expect(rest.every((row) => row.priority === 6 && row.user_id === r.userId)).toBe(true);
    expect(await h.payloads('card.backfill', next)).toEqual([]);
  });

  it('selects by eligible arrival inside the plan window before the snapshot', async () => {
    const r = await reader();
    const inside = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(DAY) });
    const outside = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(8 * DAY) });
    const afterSnapshot = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(MINUTE) });
    // A globally old article first carried by this feed recently is keyed by that arrival.
    const oldGlobal = await h.article({ feedIds: [], firstSeenAt: ago(20 * DAY) });
    await h.carry(r.feedId, oldGlobal, ago(2 * DAY));
    const articles = [inside, outside, afterSnapshot, oldGlobal];

    await h.dispatch('card.backfill', {
      userId: r.userId,
      cardIds: [r.cardId],
      snapshotAt: ago(HOUR).toISOString(),
    });
    expect((await rowsOf(articles)).map((row) => row.article_id).sort()).toEqual(
      [inside, oldGlobal].sort(),
    );

    // An admin plan's window is 14 days.
    const admin = await h.user('admin');
    await h.subscribe(admin, r.feedId, 'active', ago(30 * DAY));
    const adminCard = await h.heldCard(admin);
    await h.dispatch('card.backfill', { userId: admin, cardIds: [adminCard] });
    const adminRows = (await rowsOf(articles)).filter((row) => row.card_id === adminCard);
    expect(adminRows.map((row) => row.article_id).sort()).toEqual(
      [inside, outside, afterSnapshot, oldGlobal].sort(),
    );
  });
});

describe('card.backfill work (spec 05 §5.4 step 4)', () => {
  it('skips only current primary answers; fallback, prefilter and old-model answers are queued again', async () => {
    const r = await reader();
    const [primary, llm, prefilter, oldModel, missing] = [
      r.cardId,
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
    ];
    const cards = [primary, llm, prefilter, oldModel, missing];
    const enriched = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(HOUR) });
    await h.enrichDirect(enriched);
    await h.answerCard(enriched, primary, { engine: 'typesafe' });
    await h.answerCard(enriched, llm, { engine: 'llm' });
    await h.answerCard(enriched, prefilter, { engine: 'prefilter', p: 0 });
    await h.answerCard(enriched, oldModel, { engine: 'typesafe', model: 'jev-test-0' });
    // An automatic row of another requester is already leased by a running match job.
    await h.queue(enriched, [missing], { priority: 5 });
    await h.owner.query(
      `UPDATE match_queue SET lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes'
        WHERE article_id = $1`,
      [enriched],
    );
    const [leased] = await rowsOf([enriched]);
    const degraded = await h.article({
      feedIds: [r.feedId],
      state: 'degraded',
      firstSeenAt: ago(2 * HOUR),
    });
    const failed = await h.article({
      feedIds: [r.feedId],
      state: 'failed',
      firstSeenAt: ago(3 * HOUR),
    });
    const stale = await h.article({
      feedIds: [r.feedId],
      state: 'stale',
      firstSeenAt: ago(4 * HOUR),
    });

    const since = await h.mark();
    await h.dispatch('card.backfill', { userId: r.userId, cardIds: cards });

    const rows = await rowsOf([enriched, degraded, failed, stale]);
    const pairs = (articleId: string) =>
      rows.filter((row) => row.article_id === articleId).map((row) => row.card_id);
    expect(pairs(enriched)).toEqual(
      [llm, prefilter, oldModel, missing].sort((a, b) => Number(a) - Number(b)),
    );
    expect(pairs(degraded)).toEqual([...cards].sort((a, b) => Number(a) - Number(b)));
    expect(pairs(failed)).toEqual([]);
    expect(pairs(stale)).toEqual([]);
    for (const row of rows) expect(row.priority).toBe(2);
    // The leased automatic row is promoted, becomes platform-shared and keeps its live lease.
    expect(
      rows.find((row) => row.article_id === enriched && row.card_id === missing),
    ).toMatchObject({
      priority: 2,
      user_id: null,
      lease_token: leased?.lease_token,
    });
    expect(
      rows
        .filter((row) => row.article_id === enriched && row.card_id !== missing)
        .every((row) => row.user_id === r.userId),
    ).toBe(true);

    expect(await h.payloads('article.match', since)).toEqual([{ articleId: enriched }]);
    // A degraded article gets its prerequisite enrichment, interactive inside the first 50.
    expect(await h.payloads('article.enrich', since)).toEqual([
      { articleId: degraded, priority: 'interactive' },
    ]);
  });

  it('never expands authorization: off and unselected training carriers contribute nothing, a selection does', async () => {
    const userId = await h.user();
    const card = await h.heldCard(userId);
    const feeds = {
      off: await h.feed(),
      training: await h.feed(),
      selected: await h.feed(),
      active: await h.feed(),
    };
    await h.subscribe(userId, feeds.off, 'off');
    await h.subscribe(userId, feeds.training, 'training');
    await h.subscribe(userId, feeds.selected, 'training');
    await h.subscribe(userId, feeds.active, 'active', ago(30 * DAY));
    const onOff = await h.article({ feedIds: [feeds.off] });
    const onTraining = await h.article({ feedIds: [feeds.training] });
    const chosen = await h.article({ feedIds: [feeds.selected] });
    const notChosen = await h.article({ feedIds: [feeds.selected] });
    const onActive = await h.article({ feedIds: [feeds.active] });
    // Also carried by the off feed: admitted through the active carrier only.
    const both = await h.article({ feedIds: [feeds.off] });
    await h.carry(feeds.active, both);
    for (const id of [onOff, onTraining, chosen, notChosen, onActive, both]) {
      await h.enrichDirect(id);
    }
    await h.select(userId, feeds.selected, chosen);
    // A card scoped to the off feed has no admitted article at all.
    const scopedOff = await h.card();
    await h.hold(userId, scopedOff, { scopeFeedId: feeds.off });

    const since = await h.mark();
    await h.dispatch('card.backfill', { userId, cardIds: [card, scopedOff] });

    const rows = await rowsOf([onOff, onTraining, chosen, notChosen, onActive, both]);
    expect(rows.map((row) => [row.article_id, row.card_id]).sort()).toEqual(
      [
        [chosen, card],
        [onActive, card],
        [both, card],
      ].sort(),
    );
    expect(
      (await h.payloads('article.match', since)).map((payload) => payload['articleId']).sort(),
    ).toEqual([chosen, onActive, both].sort());

    // `feedIds` restricts the carriers further.
    await h.owner.query('DELETE FROM match_queue WHERE article_id = ANY($1::bigint[])', [
      [chosen, onActive, both],
    ]);
    await h.dispatch('card.backfill', { userId, cardIds: [card], feedIds: [feeds.selected] });
    expect(
      (await rowsOf([onOff, onTraining, chosen, notChosen, onActive, both])).map(
        (row) => row.article_id,
      ),
    ).toEqual([chosen]);
  });

  it('activation never backfills the hidden backlog: only arrivals after activation are admitted', async () => {
    const userId = await h.user();
    const feedId = await h.feed();
    await h.subscribe(userId, feedId, 'off');
    const card = await h.heldCard(userId);
    // One backlog article still waits for enrichment, two were enriched for other readers.
    const backlog = [await h.article({ feedIds: [feedId], firstSeenAt: ago(2 * HOUR) })];
    for (const hours of [30, 100]) {
      const id = await h.article({ feedIds: [feedId], firstSeenAt: ago(hours * HOUR) });
      await h.enrichDirect(id);
      backlog.push(id);
    }
    await h.setMode(userId, feedId, 'active');

    const since = await h.mark();
    await h.dispatch('card.backfill', { userId, cardIds: [card] });
    expect(await rowsOf(backlog)).toEqual([]);
    expect(await h.payloads('article.match', since)).toEqual([]);
    // Nor does automatic enrichment of a backlog article spend anything.
    await h.dispatch('article.enrich', { articleId: backlog[0] as string });
    expect(h.router.asks).toEqual([]);
    expect(await h.articleRow(backlog[0] as string)).toMatchObject({ state: 'extracted' });

    // An arrival at the activation instant (microseconds included) is admitted.
    const arrival = await h.article({ feedIds: [feedId], firstSeenAt: ago(MINUTE) });
    await h.owner.query(
      `UPDATE feed_items fi SET first_seen_at = s.inference_activated_at
         FROM subscriptions s
        WHERE fi.article_id = $1 AND s.user_id = $2 AND s.feed_id = fi.feed_id`,
      [arrival, userId],
    );
    await h.enrichDirect(arrival);
    await h.dispatch('card.backfill', { userId, cardIds: [card] });
    expect((await rowsOf([...backlog, arrival])).map((row) => row.article_id)).toEqual([arrival]);
  });

  it('revalidates the holder: a card no longer held or a deleted user queues nothing', async () => {
    const r = await reader();
    const article = await h.article({ feedIds: [r.feedId] });
    await h.enrichDirect(article);
    const unheld = await h.card();
    await h.dispatch('card.backfill', { userId: r.userId, cardIds: [unheld] });
    expect(await rowsOf([article])).toEqual([]);

    await h.owner.query('UPDATE users SET deleted_at = now() WHERE id = $1', [r.userId]);
    await h.dispatch('card.backfill', { userId: r.userId, cardIds: [r.cardId] });
    expect(await rowsOf([article])).toEqual([]);
  });
});
