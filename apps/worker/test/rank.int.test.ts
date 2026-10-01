import { recordRankIntents, workerOutbox } from '@bantoozi/db';
import { scoreVersion } from '@bantoozi/ranker';
import { buildJobIntent, type Explain } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createUserRankHandler,
  RANK_PAGE,
  RANK_WRITE_BATCH,
  type UserRankOptions,
} from '../src/handlers/user-rank.js';
import { ClassifyHarness, DAY, HOUR, MINUTE, ago } from './support/classify.js';

/**
 * M5-T4 `user.rank` (spec 06 §7) through the real handler: the dirty set covers each freshness
 * trigger, the window follows subscribed carrier arrival plus completed selections, full runs
 * re-rank the window, writes are fenced and touch only the ranking columns.
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

interface RunLog {
  outcome: string;
  ranked: number;
  written: number;
  moved: number;
}

/** Run `user.rank` for `userId` and return its summary log line. */
async function rank(
  userId: string,
  options: { full?: boolean; now?: Date; snapshotAt?: Date; handler?: UserRankOptions } = {},
): Promise<RunLog> {
  const logs: Array<Record<string, unknown>> = [];
  const { now } = options;
  const handle = createUserRankHandler(
    {
      ...h.deps,
      logger: { info: (obj) => logs.push(obj as Record<string, unknown>), warn() {}, error() {} },
      ...(now === undefined ? {} : { now: () => now }),
    },
    options.handler,
  );
  await handle(
    {
      userId,
      reason: 'test',
      ...(options.full === true ? { full: true } : {}),
      ...(options.snapshotAt === undefined ? {} : { snapshotAt: options.snapshotAt.toISOString() }),
    },
    { queue: 'user.rank', jobId: 'test' },
  );
  const log = logs.find((entry) => entry['job'] === 'user.rank');
  if (log === undefined) return { outcome: 'none', ranked: 0, written: 0, moved: 0 };
  return {
    outcome: String(log['outcome']),
    ranked: Number(log['ranked']),
    written: Number(log['written']),
    moved: Number(log['moved']),
  };
}

interface Row {
  lane: string;
  tier: number | null;
  p: number | null;
  source: string;
  rules: string[];
  explain: Explain | null;
  scoreVersion: string;
  rankRevision: string;
  scoredAt: Date | null;
  nextRankAt: Date | null;
}

async function rows(userId: string): Promise<Map<string, Row>> {
  const result = await h.owner.query<{
    article_id: string;
    lane: string;
    tier: number | null;
    p_like: number | null;
    score_source: string;
    rules_fired: string[];
    explain: Explain | null;
    score_version: string;
    rank_revision: string;
    scored_at: Date | null;
    next_rank_at: Date | null;
  }>(
    `SELECT article_id::text AS article_id, lane, tier, p_like, score_source, rules_fired, explain,
            score_version, rank_revision::text AS rank_revision, scored_at, next_rank_at
       FROM user_article WHERE user_id = $1`,
    [userId],
  );
  return new Map(
    result.rows.map((row) => [
      row.article_id,
      {
        lane: row.lane,
        tier: row.tier,
        p: row.p_like,
        source: row.score_source,
        rules: row.rules_fired,
        explain: row.explain,
        scoreVersion: row.score_version,
        rankRevision: row.rank_revision,
        scoredAt: row.scored_at,
        nextRankAt: row.next_rank_at,
      },
    ]),
  );
}

async function row(userId: string, articleId: string): Promise<Row> {
  const found = (await rows(userId)).get(articleId);
  if (found === undefined) throw new Error(`no row for ${articleId}`);
  return found;
}

/** An active reader of a new feed holding one `like` card. */
let readers = 0;

async function reader(interest = `ocean shipping logistics ${(readers += 1)}`) {
  const userId = await h.user();
  const feedId = await h.feed();
  await h.subscribe(userId, feedId, 'active', ago(30 * DAY));
  const cardId = await h.heldCard(userId, { interest });
  return { userId, feedId, cardId };
}

/** A matched article with current facets and a current Jev answer of `cardId`. */
async function matched(
  feedId: string,
  cardId: string,
  p: number,
  options: { title?: string } = {},
): Promise<string> {
  const articleId = await h.article({ feedIds: [feedId], ...options });
  await h.enrichDirect(articleId, { state: 'matched' });
  await h.answerCard(articleId, cardId, { engine: 'typesafe', p });
  return articleId;
}

describe('user.rank runs (spec 06 §7)', () => {
  it('ranks the window with the composite version and the rank revision; a second run writes 0 rows', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.92);
    const b = await matched(r.feedId, r.cardId, 0.1);

    const first = await rank(r.userId);
    expect(first).toMatchObject({ outcome: 'done', written: 2 });
    const stored = await rows(r.userId);
    expect(stored.get(a)).toMatchObject({
      source: 'cards',
      scoreVersion: scoreVersion(0),
      rankRevision: '0',
    });
    expect(stored.get(a)?.explain?.inputs).toMatchObject({
      contentRevision: '1',
      mediaRevision: '0',
      rankRevision: '0',
    });
    expect(stored.get(a)?.p).toBeGreaterThan(stored.get(b)?.p ?? 1);

    const second = await rank(r.userId);
    expect(second.written).toBe(0);
    const again = await rows(r.userId);
    expect(again.get(a)?.scoredAt).toEqual(stored.get(a)?.scoredAt);
    expect(again.get(b)?.scoredAt).toEqual(stored.get(b)?.scoredAt);
  });

  it('never modifies the reader-state columns', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    const labelId = await h.heldLabel(r.userId);
    const readAt = ago(10 * MINUTE);
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, read_at, opened_at, rating, reason, rated_at,
                                 dwell_ms, label_ids, state_version, feedback_prompted_at)
       VALUES ($1, $2, $3, $3, 1, NULL, $3, 4200, ARRAY[$4::bigint], 7, $3)`,
      [r.userId, a, readAt, labelId],
    );
    const readerState = `SELECT read_at, opened_at, rating, reason, rated_at, dwell_ms, bookmarked_at,
                                bookmark_snapshot_id, bookmark_origin_feed_id,
                                bookmark_capture_generation, bookmark_capture_status,
                                bookmark_capture_error_code, archived_at, label_ids::text[],
                                feedback_prompted_at, state_version
                           FROM user_article WHERE user_id = $1 AND article_id = $2`;
    const before = (await h.owner.query(readerState, [r.userId, a])).rows;

    expect((await rank(r.userId)).written).toBe(1);
    await rank(r.userId, { full: true });

    expect((await h.owner.query(readerState, [r.userId, a])).rows).toEqual(before);
    expect((await row(r.userId, a)).source).toBe('cards');
  });

  it('leaves archived articles out of the window', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    await h.owner.query(
      `INSERT INTO user_article (user_id, article_id, archived_at) VALUES ($1, $2, now())`,
      [r.userId, a],
    );
    expect(await rank(r.userId)).toMatchObject({ ranked: 0, written: 0 });
    expect((await row(r.userId, a)).scoredAt).toBeNull();
  });
});

describe('the dirty set covers each freshness trigger (spec 06 §7 step 2)', () => {
  it('time: a due next_rank_at re-ranks that row only', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    const b = await matched(r.feedId, r.cardId, 0.9);
    await rank(r.userId);
    await h.owner.query(
      `UPDATE user_article SET next_rank_at = now() - interval '1 second', scored_at = scored_at - interval '1 hour'
        WHERE user_id = $1 AND article_id = $2`,
      [r.userId, a],
    );
    const before = await rows(r.userId);
    const run = await rank(r.userId);
    expect(run.written).toBe(1);
    const after = await rows(r.userId);
    expect(after.get(a)?.scoredAt?.getTime()).toBeGreaterThan(
      before.get(a)?.scoredAt?.getTime() ?? 0,
    );
    expect(after.get(b)?.scoredAt).toEqual(before.get(b)?.scoredAt);
  });

  it('clock only: a timed mute hides until it expires, then the due row is re-ranked', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9, { title: 'Harbor strike update' });
    const expires = new Date(Date.now() + HOUR);
    const rule = await h.owner.query<{ id: string }>(
      `INSERT INTO user_rules (user_id, kind, value, expires_at)
       VALUES ($1, 'mute_keyword', 'harbor strike', $2) RETURNING id::text AS id`,
      [r.userId, expires],
    );
    await rank(r.userId);
    const hidden = await row(r.userId, a);
    expect(hidden.lane).toBe('hidden');
    expect(hidden.rules).toEqual(['mute_keyword:harbor strike']);
    expect(hidden.explain?.rules[0]).toMatchObject({ ruleId: rule.rows[0]?.id });
    expect(hidden.nextRankAt).toEqual(expires);

    const later = new Date(Date.now() + 2 * HOUR);
    expect((await rank(r.userId, { now: later })).written).toBe(1);
    const shown = await row(r.userId, a);
    expect(shown.lane).not.toBe('hidden');
    expect(shown.rules).not.toContain('mute_keyword:harbor strike');
  });

  it('undo: a full intent bumps the rank revision and re-ranks every row', async () => {
    const r = await reader();
    await matched(r.feedId, r.cardId, 0.9);
    await matched(r.feedId, r.cardId, 0.2);
    await rank(r.userId);
    const since = await h.mark();
    await h.db.transaction((tx) =>
      recordRankIntents(tx, workerOutbox(tx), [r.userId], { reason: 'undo', full: true }),
    );
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: r.userId, reason: 'undo', full: true },
    ]);
    // Even an incremental run sees every row of the old revision as dirty.
    expect((await rank(r.userId)).written).toBe(2);
    for (const stored of (await rows(r.userId)).values()) {
      expect(stored.rankRevision).toBe('1');
      expect(stored.explain?.inputs.rankRevision).toBe('1');
    }
  });

  it('model: a newer card answer re-ranks the article', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.1);
    await rank(r.userId);
    const before = await row(r.userId, a);
    await h.answerCard(a, r.cardId, { engine: 'typesafe', p: 0.95 });
    expect((await rank(r.userId)).written).toBe(1);
    const after = await row(r.userId, a);
    expect(after.p).toBeGreaterThan(before.p ?? 1);
    expect(after.explain?.cards[0]).toMatchObject({ id: r.cardId, p: 0.95 });
  });

  it('translated card text: a card translation changes the answer input and dirties the window', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    await h.setSetting('card_text_mode', 'english');
    try {
      // The answer was written under the native card text: not current under `english` mode.
      await h.answerCard(a, r.cardId, { engine: 'typesafe', p: 0.9 });
      await rank(r.userId);
      expect((await row(r.userId, a)).source).toBe('cards');
      // house.translate-cards fills the English pair: the question hash changes.
      await h.owner.query(
        `UPDATE interest_cards
            SET body = body || jsonb_build_object('interest_en', 'ocean freight', 'not_for_en', NULL)
          WHERE id = $1`,
        [r.cardId],
      );
      expect((await rank(r.userId)).written).toBe(1);
      const stale = await row(r.userId, a);
      expect(stale.source).not.toBe('cards');
      expect(stale.explain?.cards).toEqual([]);
      // The rematch answers the new question: ranked from cards again.
      await h.answerCard(a, r.cardId, { engine: 'typesafe', p: 0.9 });
      expect((await rank(r.userId)).written).toBe(1);
      expect((await row(r.userId, a)).source).toBe('cards');
    } finally {
      await h.deleteSetting('card_text_mode');
    }
  });

  it('media signal: a changed media revision makes the row dirty', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    await rank(r.userId);
    await h.owner.query(
      'UPDATE articles SET has_video = true, media_revision = media_revision + 1 WHERE id = $1',
      [a],
    );
    expect((await rank(r.userId)).written).toBe(1);
    expect((await row(r.userId, a)).explain?.inputs.mediaRevision).toBe('1');
  });

  it('media signal committed while a run is in flight: the row is not overwritten and stays dirty', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    await rank(r.userId);
    const since = await h.mark();
    const run = await rank(r.userId, {
      full: true,
      handler: {
        beforeWrite: async () => {
          await h.owner.query(
            'UPDATE articles SET media_revision = media_revision + 1, body_image_count = 3 WHERE id = $1',
            [a],
          );
        },
      },
    });
    expect(run).toMatchObject({ written: 0, moved: 1 });
    expect((await row(r.userId, a)).explain?.inputs.mediaRevision).toBe('0');
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: r.userId, reason: 'article_moved' },
    ]);
    expect((await rank(r.userId)).written).toBe(1);
    expect((await row(r.userId, a)).explain?.inputs.mediaRevision).toBe('1');
  });

  it('a translation stored after scoring makes the row dirty', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    await rank(r.userId);
    await h.owner.query(
      `INSERT INTO article_translations (article_id, article_revision, source_sha256, engine,
                                         source_lang, title, excerpt, quality)
       VALUES ($1, 1, 'x', 'libretranslate', 'sk', 'Translated title', 'Translated excerpt', 'ok')`,
      [a],
    );
    expect((await rank(r.userId)).written).toBe(1);
    expect((await row(r.userId, a)).explain?.translation).toEqual({
      engine: 'libretranslate',
      quality: 'ok',
    });
  });

  it('subscription changes: a newly subscribed carrier brings its articles into the window', async () => {
    const r = await reader();
    const other = await h.feed();
    const a = await h.article({ feedIds: [other] });
    await rank(r.userId);
    expect((await rows(r.userId)).has(a)).toBe(false);

    await h.subscribe(r.userId, other, 'active', ago(30 * DAY));
    expect((await rank(r.userId)).written).toBe(1);
    expect((await rows(r.userId)).has(a)).toBe(true);
  });

  it('windows by subscribed carrier arrival, not by global first-seen time', async () => {
    const r = await reader();
    const unsubscribed = await h.feed();
    // First seen globally 30 days ago, carried by a subscribed feed an hour ago: in the window.
    const late = await h.article({ feedIds: [unsubscribed], firstSeenAt: ago(30 * DAY) });
    await h.carry(r.feedId, late, ago(HOUR));
    // Carried by the subscribed feed 20 days ago, by another feed an hour ago: outside.
    const old = await h.article({ feedIds: [r.feedId], firstSeenAt: ago(20 * DAY) });
    await h.carry(unsubscribed, old, ago(HOUR));

    await rank(r.userId);
    const stored = await rows(r.userId);
    expect(stored.has(late)).toBe(true);
    expect(stored.has(old)).toBe(false);
  });

  it('ranks a completed selection of an older article from its published answers, also after a rebuild', async () => {
    const userId = await h.user();
    const feedId = await h.feed();
    await h.subscribe(userId, feedId, 'training');
    const cardId = await h.heldCard(userId);
    const a = await h.article({ feedIds: [feedId], firstSeenAt: ago(40 * DAY) });
    await h.enrichDirect(a, { state: 'matched' });
    const { requestId } = await h.select(userId, feedId, a);
    await h.owner.query(
      `UPDATE analysis_requests
          SET status = 'complete', completed_at = now(), result_snapshot = '{}', result_sha = 'x'
        WHERE id = $1`,
      [requestId],
    );
    await h.answerCard(a, cardId, { engine: 'typesafe', p: 0.3 });

    await rank(userId);
    const ranked = await row(userId, a);
    expect(ranked.source).toBe('cards');
    expect(ranked.explain?.cards[0]).toMatchObject({ id: cardId, p: 0.3 });

    // A model-pin rebuild refills the cache: the selected article is ranked from the new answer.
    await h.answerCard(a, cardId, { engine: 'typesafe', p: 0.97 });
    expect((await rank(userId)).written).toBe(1);
    expect((await row(userId, a)).explain?.cards[0]).toMatchObject({ p: 0.97 });
  });

  it('BM25: a changed corpus re-ranks degraded items, and the document frequencies come from the whole window', async () => {
    const r = await reader('harbor crane automation');
    const degraded = await h.article({
      feedIds: [r.feedId],
      state: 'degraded',
      title: 'Harbor crane automation spreads',
      excerpt: 'Ports automate their cranes.',
    });
    const others: string[] = [];
    for (const title of ['Harbor fees rise', 'Crane makers merge', 'Weather at sea']) {
      others.push(await matched(r.feedId, r.cardId, 0.5, { title }));
    }
    await rank(r.userId);
    const first = await row(r.userId, degraded);
    expect(first.source).toBe('degraded');

    // Only the degraded row is dirty, but its P still uses the window's document frequencies.
    await h.owner.query(
      `UPDATE user_article SET next_rank_at = now() - interval '1 second'
        WHERE user_id = $1 AND article_id = $2`,
      [r.userId, degraded],
    );
    expect((await rank(r.userId)).written).toBe(1);
    expect((await row(r.userId, degraded)).p).toBe(first.p);

    // A new window article changes the corpus: the degraded item is ranked again, the rest are not.
    const before = await rows(r.userId);
    await matched(r.feedId, r.cardId, 0.5, { title: 'Harbor cranes in winter' });
    const run = await rank(r.userId);
    expect(run.written).toBe(2);
    const after = await rows(r.userId);
    expect(after.get(degraded)?.scoredAt?.getTime()).toBeGreaterThan(
      before.get(degraded)?.scoredAt?.getTime() ?? 0,
    );
    for (const id of others) expect(after.get(id)?.scoredAt).toEqual(before.get(id)?.scoredAt);
  });
});

describe('full runs, continuations and fences (spec 06 §7 step 5)', () => {
  it('a full run re-ranks the whole window even when nothing is dirty', async () => {
    const r = await reader();
    const ids = [await matched(r.feedId, r.cardId, 0.9), await matched(r.feedId, r.cardId, 0.4)];
    await rank(r.userId);
    expect((await rank(r.userId)).written).toBe(0);
    expect((await rank(r.userId, { full: true })).written).toBe(ids.length);
  });

  it('full and incremental intents use different queue keys, so a pending incremental never swallows a full', () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const incremental = buildJobIntent('user.rank', { userId, reason: 'match' });
    const full = buildJobIntent('user.rank', { userId, reason: 'card', full: true });
    expect(incremental.send).toEqual({ kind: 'debounced', key: `rank:${userId}`, seconds: 3 });
    expect(full.send).toEqual({ kind: 'send', singletonKey: `rank-full:${userId}` });
    const continued = buildJobIntent('user.rank', {
      userId,
      reason: 'continuation',
      full: true,
      snapshotAt: new Date().toISOString(),
    });
    expect(continued.send).toEqual(full.send);
  });

  it('a stale run fails its revision guard: nothing is written and a replacement is enqueued', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.9);
    const since = await h.mark();
    const run = await rank(r.userId, {
      handler: {
        beforeWrite: async () => {
          await h.owner.query('UPDATE users SET rank_revision = rank_revision + 1 WHERE id = $1', [
            r.userId,
          ]);
        },
      },
    });
    expect(run).toMatchObject({ outcome: 'superseded', written: 0 });
    expect((await rows(r.userId)).has(a)).toBe(false);
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: r.userId, reason: 'superseded' },
    ]);
    expect((await rank(r.userId)).written).toBe(1);
    expect((await row(r.userId, a)).rankRevision).toBe('1');
  });

  it('a changed ranking settings version supersedes the run', async () => {
    const r = await reader();
    await matched(r.feedId, r.cardId, 0.9);
    try {
      const run = await rank(r.userId, {
        handler: {
          beforeWrite: async () => {
            await h.setSetting('ranker.settings_version', 1);
          },
        },
      });
      expect(run).toMatchObject({ outcome: 'superseded', written: 0 });
      expect((await rank(r.userId)).written).toBe(1);
      for (const stored of (await rows(r.userId)).values()) {
        expect(stored.scoreVersion).toBe(scoreVersion(1));
      }
    } finally {
      await h.deleteSetting('ranker.settings_version');
    }
  });

  it('a malformed ranking override fails the job visibly', async () => {
    const r = await reader();
    await matched(r.feedId, r.cardId, 0.9);
    try {
      await h.setSetting('ranker.thresholds', { windowDays: 30 });
      await expect(rank(r.userId)).rejects.toThrow();
      expect((await rows(r.userId)).size).toBe(0);
    } finally {
      await h.deleteSetting('ranker.thresholds');
    }
  });

  it('a run out of budget commits a continuation; a full continuation keeps its snapshot', async () => {
    const r = await reader();
    for (let i = 0; i < 5; i += 1) await matched(r.feedId, r.cardId, 0.5);
    await rank(r.userId);
    const since = await h.mark();
    const run = await rank(r.userId, {
      full: true,
      handler: { pageSize: 2, batchSize: 2, budgetMs: 0 },
    });
    expect(run).toMatchObject({ outcome: 'continued', written: 2 });
    const [continuation] = await h.payloads('user.rank', since);
    expect(continuation).toMatchObject({ userId: r.userId, reason: 'continuation', full: true });
    const snapshotAt = new Date(String(continuation?.['snapshotAt']));
    // The continuation forces only rows scored before the snapshot: the other three.
    const next = await rank(r.userId, { full: true, snapshotAt });
    expect(next).toMatchObject({ outcome: 'done', written: 3 });
    expect((await rank(r.userId, { full: true, snapshotAt })).written).toBe(0);
  });

  it(`drains more than ${RANK_PAGE} eligible items in bounded batches`, async () => {
    const r = await reader();
    const total = RANK_PAGE + 50;
    await h.owner.query(
      `WITH a AS (
         INSERT INTO articles (url, canonical_url, url_key, title, title_norm, excerpt,
                               first_seen_at, content_hash, pipeline_state, lang)
         SELECT 'https://bulk.example.test/' || $2 || '/' || g, 'https://bulk.example.test/' || $2 || '/' || g,
                'bulk.example.test/' || $2 || '/' || g, 'Bulk ' || g, 'bulk ' || g, 'Excerpt ' || g,
                now() - make_interval(secs => g), md5($2 || g::text), 'extracted', 'en'
           FROM generate_series(1, $3::int) AS g
         RETURNING id, first_seen_at)
       INSERT INTO feed_items (feed_id, article_id, guid, first_seen_at)
       SELECT $1, a.id, 'bulk-' || a.id, a.first_seen_at FROM a`,
      [r.feedId, r.userId, total],
    );
    const batches: number[] = [];
    const run = await rank(r.userId, {
      handler: { beforeWrite: async (ids) => void batches.push(ids.length) },
    });
    expect(run).toMatchObject({ outcome: 'done', ranked: total, written: total });
    expect(Math.max(...batches)).toBeLessThanOrEqual(RANK_WRITE_BATCH);
    expect(batches.reduce((sum, n) => sum + n, 0)).toBe(total);
    expect((await rows(r.userId)).size).toBe(total);
    for (const stored of (await rows(r.userId)).values()) expect(stored.lane).toBe('new');
    expect((await rank(r.userId)).written).toBe(0);
  }, 120_000);
});

describe('weak-translation escalation (spec 06 §7 step 6, spec 07 §3)', () => {
  async function translated(
    articleId: string,
    engine: 'libretranslate' | 'ollama',
    quality: 'ok' | 'weak' | 'fail',
  ): Promise<void> {
    await h.owner.query(
      `INSERT INTO article_translations (article_id, article_revision, source_sha256, engine,
                                         source_lang, title, excerpt, quality)
       VALUES ($1, 1, 'x', $2, 'sk', 'Translated title', 'Translated excerpt', $3)`,
      [articleId, engine, quality],
    );
  }

  const tier2 = (payloads: Array<Record<string, unknown>>, articleId: string) =>
    payloads.filter((p) => p['articleId'] === articleId && p['forceTier2'] === true);

  it('a newly maybe item with a weak tier-1 translation and no ollama row escalates once', async () => {
    const r = await reader();
    const a = await matched(r.feedId, r.cardId, 0.6);
    await translated(a, 'libretranslate', 'weak');
    const since = await h.mark();
    await rank(r.userId);
    expect((await row(r.userId, a)).lane).toBe('maybe');
    expect(tier2(await h.payloads('article.translate', since), a)).toEqual([
      { articleId: a, forceTier2: true },
    ]);

    // Still maybe on the next (full) run: not newly placed, no second escalation.
    const again = await h.mark();
    expect((await rank(r.userId, { full: true })).written).toBe(1);
    expect(tier2(await h.payloads('article.translate', again), a)).toEqual([]);
  });

  it('does not escalate once an ollama row exists, nor for an ok translation or another lane', async () => {
    const r = await reader();
    const skipped = await matched(r.feedId, r.cardId, 0.6);
    await translated(skipped, 'libretranslate', 'weak');
    await translated(skipped, 'ollama', 'fail');
    const ok = await matched(r.feedId, r.cardId, 0.6);
    await translated(ok, 'libretranslate', 'ok');
    const high = await matched(r.feedId, r.cardId, 0.97);
    await translated(high, 'libretranslate', 'weak');
    const since = await h.mark();
    await rank(r.userId);
    const stored = await rows(r.userId);
    expect(stored.get(skipped)?.lane).toBe('maybe');
    expect(stored.get(ok)?.lane).toBe('maybe');
    expect(stored.get(high)?.lane).toBe('for_you');
    expect(await h.payloads('article.translate', since)).toEqual([]);
  });
});

describe('house.expire-rules (spec 11 §6)', () => {
  it('deletes expired rules hourly and records a full rank for their users', async () => {
    const r = await reader();
    const other = await reader();
    await h.owner.query(
      `INSERT INTO user_rules (user_id, kind, value, expires_at) VALUES
         ($1, 'mute_keyword', 'expired one', now() - interval '1 minute'),
         ($1, 'mute_story', '123', now() - interval '1 hour'),
         ($2, 'mute_keyword', 'still active', now() + interval '1 hour'),
         ($2, 'block_domain', 'forever.example', NULL)`,
      [r.userId, other.userId],
    );
    const since = await h.mark();
    await h.dispatch('house.expire-rules', {});

    const left = await h.owner.query<{ user_id: string; value: string }>(
      `SELECT user_id::text AS user_id, value FROM user_rules WHERE user_id = ANY($1::uuid[])
        ORDER BY value`,
      [[r.userId, other.userId]],
    );
    expect(left.rows).toEqual([
      { user_id: other.userId, value: 'forever.example' },
      { user_id: other.userId, value: 'still active' },
    ]);
    expect(await h.payloads('user.rank', since)).toEqual([
      { userId: r.userId, reason: 'rule_expired', full: true },
    ]);
    const revisions = await h.owner.query<{ id: string; rank_revision: string }>(
      `SELECT id::text AS id, rank_revision::text AS rank_revision FROM users WHERE id = ANY($1::uuid[])`,
      [[r.userId, other.userId]],
    );
    expect(Object.fromEntries(revisions.rows.map((u) => [u.id, u.rank_revision]))).toEqual({
      [r.userId]: '1',
      [other.userId]: '0',
    });
    const progress = (await h.setting('house.progress')) as Record<string, { updatedAt: string }>;
    expect(progress['house.expire-rules']?.updatedAt).toBeDefined();

    // Nothing left to expire: no further intents.
    const next = await h.mark();
    await h.dispatch('house.expire-rules', {});
    expect(await h.payloads('user.rank', next)).toEqual([]);
  });
});
