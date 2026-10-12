import { MATCH_INTERACTIVE_MAX_PRIORITY, MATCH_MAX_ATTEMPTS, workerOutbox } from '@bantoozi/db';
import { enqueueTranslate } from '@bantoozi/shared';
import { pseudoTranslate } from '@bantoozi/testing';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pgBossBroker } from '../src/boss.js';
import { relayOnce } from '../src/outbox-relay.js';

import {
  DAY,
  HOUR,
  LLM_MODEL,
  MINUTE,
  PRIMARY_MODEL,
  ago,
  forArticles,
} from './support/classify.js';
import {
  MODES_NATIVE,
  MODES_SK_TRANSLATE,
  OLD_MODEL,
  asEarlierMatchSet,
  cardDigest,
  drainRebuild,
  joinCluster,
  matchSetSha,
  pendingWork,
  queueState,
  reader,
  resetWindow,
  selectComplete,
  startReprocessWorld,
  storedAnswers,
  translateCard,
  type ReprocessWorld,
} from './support/reprocess-world.js';

/**
 * M8-T2 `house.reenrich` and `house.rematch` (PLAN §14 "Done when", spec 05 §2, spec 11 §6 and §8)
 * through the real handlers, the real article stages and the outbox run loop. A long window is
 * rebuilt in batches, so every test drains the rebuild queues (continuation jobs included) until no
 * work is left. The rebuild is bulk priority with no LLM fallback (owner decision). The scripted
 * router and the fake LibreTranslate server stand in for every provider.
 */

let w: ReprocessWorld;
let h: ReprocessWorld['h'];

beforeAll(async () => {
  w = await startReprocessWorld();
  h = w.h;
});

afterAll(async () => {
  await w?.close();
});

beforeEach(async () => {
  await resetWindow(w);
});

const SLOVAK = {
  title: 'Nové električky v Bratislave jazdia od pondelka',
  excerpt: 'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky.',
  bodyLead:
    'Od pondelka jazdia na petržalskej trati prvé nové nízkopodlažné električky. Dopravný podnik ' +
    'ich nasadil najskôr na linku, ktorá vedie cez Starý most, pretože tam je najviac cestujúcich.',
};

const ids = (payloads: ReadonlyArray<Record<string, unknown>>): string[] =>
  payloads.map((payload) => String(payload['articleId'])).sort();

/** The payloads of `queue` recorded after `since` that concern one of `articleIds`. */
async function recorded(queue: string, since: string, articleIds: readonly string[]) {
  return (await h.payloads(queue, since)).filter((p) =>
    articleIds.includes(String(p['articleId'])),
  );
}

/** An enriched English article of `feedId` whose Call A answers come from an older model. */
async function oldEnriched(feedId: string, arrivedAgo: number, title = 'An older model read this') {
  const articleId = await h.article({ feedIds: [feedId], title, firstSeenAt: ago(arrivedAgo) });
  await h.enrichDirect(articleId, { model: OLD_MODEL, state: 'enriched' });
  return articleId;
}

/** An article with current primary facets in state `matched`, ready to carry card answers. */
async function currentArticle(feedId: string, arrivedAgo = HOUR, title = 'A current article') {
  const articleId = await h.article({ feedIds: [feedId], title, firstSeenAt: ago(arrivedAgo) });
  await h.enrichDirect(articleId, { state: 'matched' });
  return articleId;
}

const facetModel = async (articleId: string) => (await h.facetRow(articleId))?.model;

// ── house.reenrich ──────────────────────────────────────────────────────────────────────────────

describe('house.reenrich (spec 05 §2, spec 11 §6)', () => {
  it('re-enqueues an admitted article whose carrier arrival was 10 days ago, in bulk, and no article outside the window', async () => {
    const r = await reader(h);
    const r2 = await reader(h);
    const off = await reader(h, 'off');
    const a10 = await oldEnriched(r.feedId, 10 * DAY);
    const a15 = await oldEnriched(r.feedId, 15 * DAY);
    // Published long ago, but carried by a second active feed 2 days ago: the eligible arrival counts.
    const fresh = await oldEnriched(r.feedId, 20 * DAY);
    await h.carry(r2.feedId, fresh, ago(2 * DAY));
    // A recent arrival through a feed nobody runs inference on is not an eligible arrival.
    const offCarried = await oldEnriched(r.feedId, 20 * DAY);
    await h.carry(off.feedId, offCarried, ago(DAY));
    const all = [a10, a15, fresh, offCarried];

    const since = await h.mark();
    await h.dispatch('house.reenrich', {});

    const queued = await recorded('article.enrich', since, all);
    expect(ids(queued)).toEqual([a10, fresh].sort());
    // Rebuild work is bulk: the LLM fallback never serves it.
    expect(queued.every((payload) => payload['priority'] === 'bulk')).toBe(true);

    await drainRebuild(h);
    expect(await facetModel(a10)).toBe(PRIMARY_MODEL);
    expect(await facetModel(fresh)).toBe(PRIMARY_MODEL);
    expect(await facetModel(a15)).toBe(OLD_MODEL);
    expect(await facetModel(offCarried)).toBe(OLD_MODEL);
    expect(h.router.asks.length).toBeGreaterThan(0);
    expect(h.router.asks.every((ask) => ask.priority === 'bulk')).toBe(true);
    expect(
      h.router.asks.every((ask) => ask.articleId !== undefined && all.includes(ask.articleId)),
    ).toBe(true);
  });

  it('honours an explicit since: only arrivals at or after it, selected articles aside', async () => {
    const r = await reader(h);
    const recent = await oldEnriched(r.feedId, 2 * DAY);
    const older = await oldEnriched(r.feedId, 10 * DAY);

    const since = await h.mark();
    await h.dispatch('house.reenrich', { since: ago(5 * DAY).toISOString() });
    expect(ids(await recorded('article.enrich', since, [recent, older]))).toEqual([recent]);
  });

  it('includes an article with a current completed explicit selection whatever its arrival, and nothing else outside the window; an off feed is never opted in', async () => {
    const active = await reader(h);
    const training = await reader(h, 'training');
    const trainingTwo = await reader(h, 'training');
    const off = await reader(h, 'off');
    const outsideActive = await oldEnriched(active.feedId, 20 * DAY);
    const unselected = await oldEnriched(training.feedId, DAY);
    const offRecent = await oldEnriched(off.feedId, DAY);
    await h.heldCard(trainingTwo.userId);
    const selected = await oldEnriched(trainingTwo.feedId, 20 * DAY);
    await selectComplete(h, trainingTwo.userId, trainingTwo.feedId, selected);
    const all = [outsideActive, unselected, offRecent, selected];

    const since = await h.mark();
    await h.dispatch('house.reenrich', {});
    expect(ids(await recorded('article.enrich', since, all))).toEqual([selected]);
    await drainRebuild(h);
    expect(await facetModel(selected)).toBe(PRIMARY_MODEL);
    for (const untouched of [outsideActive, unselected, offRecent]) {
      expect(await facetModel(untouched)).toBe(OLD_MODEL);
    }
  });

  it('a language mode switched to translate re-enters that language only: an enriched native article is translated first, then reset through resetArticleAnswers and re-enriched from its translation', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(DAY),
    });
    await h.enrichDirect(sk, { state: 'matched' });
    await h.answerCard(sk, card, { engine: 'typesafe' });
    await joinCluster(h, sk);
    // Not yet enriched: it re-enters at the translation too.
    const skFresh = await h.article({ feedIds: [r.feedId], lang: 'sk', ...SLOVAK, title: 'Druhý' });
    const skOutside = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      title: 'Starý',
      firstSeenAt: ago(20 * DAY),
    });
    await h.enrichDirect(skOutside, { state: 'enriched' });
    // Another language is not the changed one.
    const cs = await h.article({
      feedIds: [r.feedId],
      lang: 'cs',
      title: 'Česky',
      firstSeenAt: ago(DAY),
    });
    await h.enrichDirect(cs, { model: OLD_MODEL, state: 'enriched' });
    const all = [sk, skFresh, skOutside, cs];
    expect(await h.facetRow(sk)).toMatchObject({ variant: 'native', revision: '1' });

    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    const since = await h.mark();
    await h.dispatch('house.reenrich', { lang: 'sk' });

    // Translation comes first, as a mode-change job (its own queue key, spec 03 §2).
    const translations = await recorded('article.translate', since, all);
    expect(translations).toHaveLength(2);
    expect(ids(translations)).toEqual([sk, skFresh].sort());
    expect(translations.every((p) => p['modeChange'] === true)).toBe(true);
    expect(await recorded('article.enrich', since, [cs, skOutside])).toEqual([]);

    // The translation resets the enriched article through resetArticleAnswers.
    await h.run('article.translate', forArticles(sk, skFresh));
    expect(await h.articleRow(sk)).toMatchObject({
      state: 'translated',
      revision: '2',
      clusterId: null,
    });
    expect(await h.facetRow(sk)).toBeNull();
    expect(await h.cardAnswers(sk)).toEqual([]);
    expect(ids(await recorded('article.enrich', since, [sk]))).toEqual([sk]);

    // And it is re-enriched from the translation.
    await drainRebuild(h);
    expect(await h.facetRow(sk)).toMatchObject({ variant: 'translated', revision: '2' });
    const ask = h.router.asksFor(sk, 'enrich').at(-1);
    expect(ask?.articleRevision).toBe('2');
    expect(JSON.stringify(ask?.request.state)).toContain(pseudoTranslate(SLOVAK.title));
    expect(await h.facetRow(skFresh)).toMatchObject({ variant: 'translated' });
    expect(await facetModel(cs)).toBe(OLD_MODEL);
    expect(await h.facetRow(skOutside)).toMatchObject({ variant: 'native', revision: '1' });
  });

  it("a language mode switched back to native resets a translated article's answers and cluster membership before re-enrichment", async () => {
    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(DAY),
    });
    await h.dispatch('article.translate', { articleId: sk });
    await h.run('article.enrich', forArticles(sk));
    expect(await h.facetRow(sk)).toMatchObject({ variant: 'translated', revision: '1' });
    await h.answerCard(sk, card, { engine: 'typesafe' });
    const storyId = await joinCluster(h, sk);
    expect(await h.cardAnswers(sk)).toHaveLength(1);
    expect((await h.articleRow(sk)).clusterId).toBe(storyId);
    await h.clearOutbox();
    const askedBefore = h.router.asks.length;

    await h.setSetting('language_modes', MODES_NATIVE);
    const since = await h.mark();
    await h.dispatch('house.reenrich', { lang: 'sk' });

    // No translation job runs in this direction: the job resets the article itself.
    expect(await recorded('article.translate', since, [sk])).toEqual([]);
    const row = await h.articleRow(sk);
    expect(row.revision).toBe('2');
    expect(row.clusterId).toBeNull();
    expect(row.clusterSetId).toBeNull();
    expect(await h.facetRow(sk)).toBeNull();
    expect(await h.cardAnswers(sk)).toEqual([]);
    expect(ids(await recorded('article.enrich', since, [sk]))).toEqual([sk]);
    // The story it left no longer lists it.
    const story = await h.owner.query<{ size: number }>(
      'SELECT size FROM story_clusters WHERE id = $1',
      [storyId],
    );
    expect(story.rows.every((s) => s.size === 0)).toBe(true);

    expect(h.router.asks).toHaveLength(askedBefore);
    await drainRebuild(h);
    expect(await h.facetRow(sk)).toMatchObject({ variant: 'native', revision: '2' });
    expect(h.router.asks.length).toBeGreaterThan(askedBefore);
  });

  it('a pending plain article.translate job for the same article absorbs neither the mode-change job nor a forceTier2 job', async () => {
    const r = await reader(h);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(HOUR),
    });
    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    const boss = new PgBoss({
      connectionString: h.testDb.urls.worker,
      migrate: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      const broker = pgBossBroker(boss);
      // A plain job and a forced tier-2 job wait for a worker (nothing consumes them here).
      await h.db.transaction(async (tx) => {
        await enqueueTranslate(workerOutbox(tx), { articleId: sk });
        await enqueueTranslate(workerOutbox(tx), { articleId: sk, forceTier2: true });
      });
      await relayOnce(h.db, broker, { handlers: h.handlers });
      await h.dispatch('house.reenrich', { lang: 'sk' });
      await relayOnce(h.db, broker, { handlers: h.handlers });

      const jobs = await h.owner.query<{
        singleton_key: string | null;
        data: Record<string, unknown>;
        state: string;
      }>(
        `SELECT singleton_key, data, state::text AS state FROM pgboss.job
          WHERE name = 'article.translate' AND data ->> 'articleId' = $1 ORDER BY singleton_key`,
        [sk],
      );
      expect(jobs.rows.map((job) => job.singleton_key).sort()).toEqual(
        [`translate-mode:${sk}`, `translate-t2:${sk}`, `translate:${sk}`].sort(),
      );
      expect(jobs.rows.every((job) => job.state === 'created')).toBe(true);
      const modeJob = jobs.rows.find((job) => job.singleton_key === `translate-mode:${sk}`);
      expect(modeJob?.data).toMatchObject({ articleId: sk, modeChange: true });
    } finally {
      await boss.stop({ graceful: false, wait: true });
    }
  });

  it('running it twice adds no duplicate work', async () => {
    const r = await reader(h);
    const a = await oldEnriched(r.feedId, 3 * DAY, 'First');
    const b = await oldEnriched(r.feedId, 5 * DAY, 'Second');
    const mine = [a, b];

    await h.dispatch('house.reenrich', {});
    const once = await pendingWork(h, ['article.enrich', 'article.translate'], mine);
    expect(once.length).toBe(2);
    await h.dispatch('house.reenrich', {});
    expect(await pendingWork(h, ['article.enrich', 'article.translate'], mine)).toEqual(once);

    // Once rebuilt, another run asks the provider for nothing and changes no answer.
    await drainRebuild(h);
    const asked = h.router.asks.length;
    const facets = [await h.facetRow(a), await h.facetRow(b)];
    await h.dispatch('house.reenrich', {});
    await drainRebuild(h);
    expect(h.router.asks).toHaveLength(asked);
    expect([await h.facetRow(a), await h.facetRow(b)]).toEqual(facets);
  });

  it('walks a window larger than one batch through continuation jobs until every article is re-enqueued', async () => {
    const r = await reader(h);
    const articles: string[] = [];
    for (let i = 0; i < 205; i += 1) {
      articles.push(await oldEnriched(r.feedId, HOUR + i * MINUTE, `Batch article ${i}`));
    }
    const since = await h.mark();
    await h.dispatch('house.reenrich', {});
    await drainRebuild(h, ['house.reenrich']);
    const queued = await recorded('article.enrich', since, articles);
    expect(new Set(ids(queued)).size).toBe(articles.length);
  }, 120_000);

  it('queues nothing while Jev is unavailable (open breaker, no key, no budget) and never reaches the LLM fallback', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    const stale = await oldEnriched(r.feedId, DAY, 'Waiting for Jev');
    const matched = await currentArticle(r.feedId, 2 * HOUR, 'Waiting for Jev too');
    await h.answerCard(matched, card, { engine: 'typesafe', model: OLD_MODEL });
    const mine = [stale, matched];
    const work = ['article.enrich', 'article.match', 'article.translate'];
    const closed = { state: 'closed', reopenCount: 0 } as const;
    const open = {
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(Date.now() + 10 * MINUTE).toISOString(),
      reopenCount: 1,
    } as const;
    const setBreaker = (typesafe: Record<string, unknown>) =>
      h.setSetting('engine.circuit', { typesafe, llm: closed, resetRequested: {} });

    const attempt = async () => {
      await h.dispatch('house.reenrich', {});
      await h.dispatch('house.rematch', {});
      await drainRebuild(h);
    };
    const unavailable = async () => {
      await attempt();
      expect(await pendingWork(h, work, mine)).toEqual([]);
      expect(await queueState(h, mine)).toEqual([]);
      expect(h.router.asks).toEqual([]);
      expect(await facetModel(stale)).toBe(OLD_MODEL);
    };
    await setBreaker(open);
    await unavailable();
    await setBreaker(closed);
    h.router.credential = { source: 'none', enabled: false };
    await unavailable();
    h.router.credential = { source: 'env', enabled: true };
    h.router.spendable = false;
    await unavailable();

    // Available again: the same jobs rebuild the window, in bulk, from Jev alone.
    h.router.spendable = true;
    await attempt();
    expect(await facetModel(stale)).toBe(PRIMARY_MODEL);
    expect((await storedAnswers(h, matched)).map((a) => [a.engine, a.model])).toEqual([
      ['typesafe', PRIMARY_MODEL],
    ]);
    expect(h.router.asks.length).toBeGreaterThan(0);
    expect(h.router.asks.every((ask) => ask.priority === 'bulk')).toBe(true);
    expect(await h.owner.query("SELECT 1 FROM article_facets WHERE engine = 'llm'")).toMatchObject({
      rowCount: 0,
    });
  });
});

// ── house.rematch ───────────────────────────────────────────────────────────────────────────────

/** A matched article whose answer to `cardId` was given by `engine` (default: the primary engine). */
async function answered(
  feedId: string,
  cardIds: readonly string[],
  answers: Record<string, { engine?: 'typesafe' | 'prefilter' | 'llm'; model?: string | null }>,
  arrivedAgo = HOUR,
  title?: string,
) {
  const articleId = await currentArticle(feedId, arrivedAgo, title);
  for (const cardId of cardIds) {
    const answer = answers[cardId];
    if (answer === undefined) continue;
    await h.answerCard(articleId, cardId, {
      engine: answer.engine ?? 'typesafe',
      ...(answer.model === undefined ? {} : { model: answer.model }),
    });
  }
  return articleId;
}

const queuedCards = async (articleId: string) =>
  (await h.queueRows(articleId)).map((row) => row.cardId).sort();

describe('house.rematch (spec 05 §2, spec 11 §6)', () => {
  it('re-enqueues the pairs a match-set change made incompatible, newest first, in bulk, with full reranks for active users only', async () => {
    const r = await reader(h);
    const idle = await reader(h, 'active', { feedId: r.feedId, lastActiveAt: ago(30 * DAY) });
    const [c1, c2] = [await h.heldCard(r.userId), await h.heldCard(r.userId)] as [string, string];
    await h.hold(idle.userId, c1);
    const x = await answered(r.feedId, [c1, c2], { [c1]: {}, [c2]: {} });
    // The only match set of the code cannot be replaced: answers of an earlier set stand in for it.
    await asEarlierMatchSet(h, x, c1);
    // Outside the window and without a selection: left alone however stale.
    const outside = await answered(r.feedId, [c1], { [c1]: {} }, 20 * DAY, 'Outside');
    await asEarlierMatchSet(h, outside);

    const since = await h.mark();
    await h.dispatch('house.rematch', {});
    await drainRebuild(h, ['house.rematch']);

    expect(await queuedCards(x)).toEqual([c1]);
    const [row] = await h.queueRows(x);
    expect(row?.priority).toBeGreaterThan(MATCH_INTERACTIVE_MAX_PRIORITY);
    expect(row?.revision).toBe((await h.articleRow(x)).revision);
    expect(ids(await recorded('article.match', since, [x, outside]))).toEqual([x]);
    expect(await queuedCards(outside)).toEqual([]);
    const ranked = (await h.payloads('user.rank', since)).filter((p) => p['full'] === true);
    expect(ranked.map((p) => p['userId'])).toContain(r.userId);
    expect(ranked.map((p) => p['userId'])).not.toContain(idle.userId);

    await drainRebuild(h);
    const sha = await matchSetSha(h);
    expect((await storedAnswers(h, x)).map((a) => [a.cardId, a.questionSetSha, a.model])).toEqual([
      [c1, sha, PRIMARY_MODEL],
      [c2, sha, PRIMARY_MODEL],
    ]);
    const asks = h.router.asksFor(x).filter((ask) => ask.cards.length > 0);
    expect(asks.map((ask) => ask.cards)).toEqual([[c1]]);
    expect(h.router.asks.every((ask) => ask.priority === 'bulk')).toBe(true);
  });

  it('rematches a card-text-mode change in either direction (english → as_written → english), also already-translated cards', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId, {
      interest: 'Elektrické automobily a nabíjecie siete',
    });
    await translateCard(h, card, { interestEn: 'Electric cars and charging networks' });
    const english = await cardDigest(h, card, 'english');
    const asWritten = await cardDigest(h, card, 'as_written');
    expect(english).not.toBe(asWritten);

    await h.setSetting('card_text_mode', 'english');
    const x = await answered(r.feedId, [card], { [card]: {} });
    expect((await storedAnswers(h, x)).map((a) => a.cardInputSha)).toEqual([english]);

    // english → as_written
    await h.setSetting('card_text_mode', 'as_written');
    let since = await h.mark();
    await h.dispatch('house.rematch', {});
    expect(await queuedCards(x)).toEqual([card]);
    expect(ids(await recorded('article.match', since, [x]))).toEqual([x]);
    await drainRebuild(h);
    expect((await storedAnswers(h, x)).map((a) => a.cardInputSha)).toEqual([asWritten]);
    expect(await queuedCards(x)).toEqual([]);

    // as_written → english: the translated card is asked again with its English text.
    await h.setSetting('card_text_mode', 'english');
    since = await h.mark();
    await h.dispatch('house.rematch', {});
    expect(await queuedCards(x)).toEqual([card]);
    expect(ids(await recorded('article.match', since, [x]))).toEqual([x]);
    await drainRebuild(h);
    expect((await storedAnswers(h, x)).map((a) => a.cardInputSha)).toEqual([english]);
    expect(h.router.asksFor(x).filter((ask) => ask.cards.length > 0)).toHaveLength(2);

    // Nothing left to rebuild: another run asks nothing.
    await h.dispatch('house.rematch', {});
    await drainRebuild(h);
    expect(h.router.asksFor(x).filter((ask) => ask.cards.length > 0)).toHaveLength(2);
    expect(await queuedCards(x)).toEqual([]);
  });

  it('rematches a prefilter change in either direction, including the prefilter markers', async () => {
    const r = await reader(h);
    const [c1, c2, c3] = [
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
    ] as [string, string, string];

    // on → off: the markers were decided by the prefilter; the real answer is asked now.
    await h.setSetting('engine.prefilter_enabled', true);
    const x = await answered(r.feedId, [c1, c2, c3], {
      [c1]: { engine: 'prefilter' },
      [c2]: { engine: 'prefilter' },
      [c3]: {},
    });
    await h.setSetting('engine.prefilter_enabled', false);
    let since = await h.mark();
    await h.dispatch('house.rematch', {});
    expect(await queuedCards(x)).toEqual([c1, c2].sort());
    expect(ids(await recorded('article.match', since, [x]))).toEqual([x]);
    await drainRebuild(h);
    expect((await storedAnswers(h, x)).map((a) => [a.cardId, a.engine])).toEqual([
      [c1, 'typesafe'],
      [c2, 'typesafe'],
      [c3, 'typesafe'],
    ]);

    // off → on: the markers (and only the markers or incompatible answers) go back to the queue.
    const y = await answered(
      r.feedId,
      [c1, c2, c3],
      {
        [c1]: { engine: 'prefilter' },
        [c2]: {},
        [c3]: {},
      },
      2 * HOUR,
      'Second',
    );
    await h.setSetting('engine.prefilter_enabled', true);
    since = await h.mark();
    await h.dispatch('house.rematch', {});
    expect(await queuedCards(y)).toEqual([c1]);
    expect(ids(await recorded('article.match', since, [y]))).toEqual([y]);
    // The first article's real answers stay.
    expect(await queuedCards(x)).toEqual([]);
  });

  it('rematches after a model-pin change: answers of another model and prefilter markers, not current ones', async () => {
    const r = await reader(h);
    const [c1, c2, c3] = [
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
    ] as [string, string, string];
    const x = await answered(r.feedId, [c1, c2, c3], {
      [c1]: { model: OLD_MODEL },
      [c2]: { engine: 'prefilter' },
      [c3]: {},
    });

    const since = await h.mark();
    await h.dispatch('house.rematch', {});
    expect(await queuedCards(x)).toEqual([c1, c2].sort());
    expect(ids(await recorded('article.match', since, [x]))).toEqual([x]);
    await drainRebuild(h);
    expect((await storedAnswers(h, x)).map((a) => [a.cardId, a.engine, a.model])).toEqual([
      [c1, 'typesafe', PRIMARY_MODEL],
      [c2, 'typesafe', PRIMARY_MODEL],
      [c3, 'typesafe', PRIMARY_MODEL],
    ]);
    expect(
      h.router
        .asksFor(x)
        .flatMap((ask) => ask.cards)
        .sort(),
    ).toEqual([c1, c2].sort());
    expect(h.router.asks.every((ask) => ask.priority === 'bulk')).toBe(true);
  });

  it("runs card-scoped after a library topic correction: only that card's markers and incompatible answers", async () => {
    const r = await reader(h);
    const [a, b] = [
      await h.heldCard(r.userId, { topicIds: ['technology'] }),
      await h.heldCard(r.userId, { topicIds: ['science'] }),
    ] as [string, string];
    await h.setSetting('engine.prefilter_enabled', true);
    const marked = await answered(r.feedId, [a, b], {
      [a]: { engine: 'prefilter' },
      [b]: { engine: 'prefilter' },
    });
    const current = await answered(
      r.feedId,
      [a, b],
      { [a]: {}, [b]: { engine: 'prefilter' } },
      2 * HOUR,
      'Two',
    );
    const other = await answered(
      r.feedId,
      [a, b],
      { [a]: { model: OLD_MODEL }, [b]: {} },
      3 * HOUR,
      'Three',
    );
    await h.owner.query(`UPDATE interest_cards SET topic_ids = ARRAY['science'] WHERE id = $1`, [
      a,
    ]);

    const since = await h.mark();
    await h.dispatch('house.rematch', { cardId: a });

    expect(await queuedCards(marked)).toEqual([a]);
    expect(await queuedCards(current)).toEqual([]);
    expect(await queuedCards(other)).toEqual([a]);
    expect(ids(await recorded('article.match', since, [marked, current, other]))).toEqual(
      [marked, other].sort(),
    );
    await drainRebuild(h);
    expect((await storedAnswers(h, marked)).map((x) => [x.cardId, x.engine])).toEqual([
      [a, 'typesafe'],
      [b, 'prefilter'],
    ]);
    expect(h.router.asks.flatMap((ask) => ask.cards)).toEqual(expect.not.arrayContaining([b]));
  });

  it('revives an exhausted invalid_request row when the model, the card text or the question set changed, and only then', async () => {
    const r = await reader(h);
    const [cm, ct, cq, cn] = [
      await h.heldCard(r.userId),
      await h.heldCard(r.userId, {
        interest: 'Cyklistická infraštruktúra v stredne veľkých mestách',
      }),
      await h.heldCard(r.userId),
      await h.heldCard(r.userId),
    ] as [string, string, string, string];
    await translateCard(h, ct, { interestEn: 'Cycling infrastructure in mid-sized cities' });
    const x = await currentArticle(r.feedId);
    // The text of `ct` was asked as written; the mode has changed since.
    await h.answerCard(x, ct, { engine: 'typesafe' });
    await h.setSetting('card_text_mode', 'english');
    await h.answerCard(x, cm, { engine: 'typesafe', model: OLD_MODEL });
    await h.answerCard(x, cq, { engine: 'typesafe' });
    await asEarlierMatchSet(h, x, cq);
    // Nothing changed for this one: its answer is current.
    await h.answerCard(x, cn, { engine: 'typesafe' });
    await h.queue(x, [cm, ct, cq, cn], {
      attempts: MATCH_MAX_ATTEMPTS,
      lastError: 'invalid_request',
      nextAttemptAt: ago(HOUR),
    });

    await h.dispatch('house.rematch', {});

    const rows = new Map((await h.queueRows(x)).map((row) => [row.cardId, row]));
    for (const revived of [cm, ct, cq]) {
      expect(rows.get(revived)).toMatchObject({ attempts: 0, due: true, leased: false });
    }
    expect(rows.get(cn)?.attempts).toBe(MATCH_MAX_ATTEMPTS);

    await drainRebuild(h);
    const sha = await matchSetSha(h);
    const current = new Map((await storedAnswers(h, x)).map((a) => [a.cardId, a]));
    for (const revived of [cm, ct, cq]) {
      expect(current.get(revived)).toMatchObject({ model: PRIMARY_MODEL, questionSetSha: sha });
    }
    expect(current.get(ct)?.cardInputSha).toBe(await cardDigest(h, ct, 'english'));
  });

  it('never opts a user in and leaves articles outside the window without a completed selection alone; a selected one is rematched', async () => {
    const active = await reader(h);
    const training = await reader(h, 'training');
    const trainingTwo = await reader(h, 'training');
    const off = await reader(h, 'off');
    const card = (userId: string) => h.heldCard(userId);
    const cActive = await card(active.userId);
    const cTraining = await card(training.userId);
    const cSelected = await card(trainingTwo.userId);
    const cOff = await card(off.userId);
    const stale = { model: OLD_MODEL };
    const outside = await answered(active.feedId, [cActive], { [cActive]: stale }, 20 * DAY, 'Out');
    const unselected = await answered(
      training.feedId,
      [cTraining],
      { [cTraining]: stale },
      DAY,
      'Un',
    );
    const offRecent = await answered(off.feedId, [cOff], { [cOff]: stale }, DAY, 'Off');
    const selected = await answered(
      trainingTwo.feedId,
      [cSelected],
      { [cSelected]: stale },
      20 * DAY,
      'Sel',
    );
    await selectComplete(h, trainingTwo.userId, trainingTwo.feedId, selected);

    await h.dispatch('house.rematch', {});
    expect(await queueState(h, [outside, unselected, offRecent])).toEqual([]);
    expect(await queuedCards(selected)).toEqual([cSelected]);
    await drainRebuild(h);
    expect((await storedAnswers(h, selected)).map((a) => a.model)).toEqual([PRIMARY_MODEL]);
    expect((await storedAnswers(h, offRecent)).map((a) => a.model)).toEqual([OLD_MODEL]);
  });

  it('running it twice adds no duplicate work', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    const x = await answered(r.feedId, [card], { [card]: { model: OLD_MODEL } });

    await h.dispatch('house.rematch', {});
    const queue = await queueState(h, [x]);
    const pending = await pendingWork(h, ['article.match', 'article.enrich'], [x]);
    expect(queue).toHaveLength(1);
    await h.dispatch('house.rematch', {});
    expect(await queueState(h, [x])).toEqual(queue);
    expect(await pendingWork(h, ['article.match', 'article.enrich'], [x])).toEqual(pending);

    await drainRebuild(h);
    const asked = h.router.asks.length;
    const answers = await storedAnswers(h, x);
    await h.dispatch('house.rematch', {});
    await drainRebuild(h);
    expect(h.router.asks).toHaveLength(asked);
    expect(await storedAnswers(h, x)).toEqual(answers);
    expect(await queuedCards(x)).toEqual([]);
  });

  it('with the primary engine unavailable it queues no pair and asks no provider, so the LLM fallback is never used for the rebuild', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    const x = await answered(r.feedId, [card], { [card]: { model: OLD_MODEL } });
    const closed = { state: 'closed', reopenCount: 0 } as const;
    await h.setSetting('engine.circuit', {
      typesafe: {
        state: 'open',
        openedAt: ago(MINUTE).toISOString(),
        openUntil: new Date(Date.now() + 10 * MINUTE).toISOString(),
        reopenCount: 1,
      },
      llm: closed,
      resetRequested: {},
    });

    await h.dispatch('house.rematch', {});
    await drainRebuild(h);
    expect(await queueState(h, [x])).toEqual([]);
    expect(h.router.asks).toEqual([]);
    expect((await storedAnswers(h, x)).map((a) => a.model)).toEqual([OLD_MODEL]);

    await h.setSetting('engine.circuit', { typesafe: closed, llm: closed, resetRequested: {} });
    await h.dispatch('house.rematch', {});
    await drainRebuild(h);
    expect((await storedAnswers(h, x)).map((a) => [a.engine, a.model])).toEqual([
      ['typesafe', PRIMARY_MODEL],
    ]);
    expect(h.router.asks.every((ask) => ask.priority === 'bulk')).toBe(true);
    expect((await storedAnswers(h, x)).some((a) => a.model === LLM_MODEL)).toBe(false);
  });
});

// ── FNF[m8-reprocess]: outage survival, bulk mode-change chain, progress ────────────────────────

const progressOf = async (job: string) => {
  const result = await h.owner.query<{ value: Record<string, Record<string, unknown>> }>(
    `SELECT value FROM settings WHERE key = 'house.progress'`,
  );
  return result.rows[0]?.value[job];
};

describe('house.reenrich and house.rematch survive an outage, stay bulk, record progress', () => {
  it('a run during an outage is recorded as pending and house.reconcile re-enqueues it once Jev is back', async () => {
    const r = await reader(h);
    const stale = await oldEnriched(r.feedId, DAY, 'Waiting out the outage');
    const open = {
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(Date.now() + 10 * MINUTE).toISOString(),
      reopenCount: 1,
    } as const;
    const closed = { state: 'closed', reopenCount: 0 } as const;
    const setBreaker = (typesafe: Record<string, unknown>) =>
      h.setSetting('engine.circuit', { typesafe, llm: closed, resetRequested: {} });

    await setBreaker(open);
    await h.dispatch('house.reenrich', {});
    await drainRebuild(h);
    // Nothing queued and no self-requeue loop, but the trigger is on record.
    expect(
      await pendingWork(h, ['article.enrich', 'article.match', 'article.translate'], [stale]),
    ).toEqual([]);
    expect(await pendingWork(h, ['house.reenrich', 'house.rematch'], [])).toEqual([]);
    const pending = (await progressOf('house.reenrich'))?.['cursor'] as
      { pending?: Array<{ since?: string }> } | undefined;
    expect(pending?.pending).toHaveLength(1);
    const frozen = pending?.pending?.[0]?.since;
    expect(frozen).toEqual(expect.any(String));
    // Still unavailable: reconcile leaves the pending run alone.
    await h.dispatch('house.reconcile', {});
    expect(await pendingWork(h, ['house.reenrich'], [])).toEqual([]);

    await setBreaker(closed);
    await h.dispatch('house.reconcile', {});
    const requeued = await pendingWork(h, ['house.reenrich'], []);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toContain(frozen ?? 'missing');
    await drainRebuild(h);
    expect(await facetModel(stale)).toBe(PRIMARY_MODEL);
    const done = await progressOf('house.reenrich');
    expect(done?.['completedAt']).toEqual(expect.any(String));
    expect((done?.['cursor'] as { pending?: unknown } | undefined)?.pending).toBeUndefined();
    // Cleared: another reconcile adds nothing.
    await h.dispatch('house.reconcile', {});
    expect(await pendingWork(h, ['house.reenrich'], [])).toEqual([]);
  });

  it('more scoped runs than the pending cap collapse into one unscoped run that covers every card', async () => {
    const open = {
      state: 'open',
      openedAt: ago(MINUTE).toISOString(),
      openUntil: new Date(Date.now() + 10 * MINUTE).toISOString(),
      reopenCount: 1,
    } as const;
    const closed = { state: 'closed', reopenCount: 0 } as const;
    const setBreaker = (typesafe: Record<string, unknown>) =>
      h.setSetting('engine.circuit', { typesafe, llm: closed, resetRequested: {} });
    const cardIds = Array.from({ length: 25 }, (_, i) => String(9000 + i));
    await setBreaker(open);
    for (const cardId of cardIds) await h.dispatch('house.rematch', { cardId });
    const pending = (
      (await progressOf('house.rematch'))?.['cursor'] as
        { pending?: Array<{ cardId?: string }> } | undefined
    )?.pending;
    // Nothing is dropped: either the unscoped run stands for them all, or every card is listed.
    expect(pending?.some((run) => run.cardId === undefined)).toBe(true);
    expect(pending?.length).toBeLessThanOrEqual(20);

    await setBreaker(closed);
    await h.dispatch('house.reconcile', {});
    const queued = (await pendingWork(h, ['house.rematch'], [])).map(
      (row) => JSON.parse(row.slice('house.rematch '.length)) as { cardId?: string },
    );
    const covered = (cardId: string) =>
      queued.some((run) => run.cardId === undefined || run.cardId === cardId);
    expect(cardIds.every(covered)).toBe(true);
    expect((await progressOf('house.rematch'))?.['cursor']).toBeUndefined();
  });

  it('the enrich that follows a mode-change translation is bulk and never answered by the LLM fallback', async () => {
    const r = await reader(h);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(DAY),
    });
    await h.enrichDirect(sk, { state: 'enriched' });
    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    // The fallback is willing to serve anything that is not bulk.
    h.router.respond = (ask) =>
      ask.priority === 'bulk'
        ? undefined
        : { ...h.router.okOutcome(ask), engine: 'llm', model: LLM_MODEL };

    await h.dispatch('house.reenrich', { lang: 'sk' });
    await drainRebuild(h);

    const asks = h.router.asksFor(sk, 'enrich');
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((ask) => ask.priority === 'bulk')).toBe(true);
    expect(await h.facetRow(sk)).toMatchObject({ variant: 'translated', engine: 'typesafe' });
    expect(await h.owner.query("SELECT 1 FROM article_facets WHERE engine = 'llm'")).toMatchObject({
      rowCount: 0,
    });
  });

  it('both jobs record completedAt in house.progress after a finished pass', async () => {
    const r = await reader(h);
    const card = await h.heldCard(r.userId);
    await oldEnriched(r.feedId, DAY, 'Progress');
    const matched = await currentArticle(r.feedId, HOUR, 'Progress too');
    await h.answerCard(matched, card, { engine: 'typesafe', model: OLD_MODEL });
    await h.dispatch('house.reenrich', {});
    await h.dispatch('house.rematch', {});
    await drainRebuild(h);
    for (const job of ['house.reenrich', 'house.rematch']) {
      const entry = await progressOf(job);
      expect(entry?.['updatedAt'], job).toEqual(expect.any(String));
      expect(entry?.['completedAt'], job).toEqual(expect.any(String));
    }
  });
});
