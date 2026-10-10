import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DAY, HOUR, ago, forArticles } from './support/classify.js';
import {
  CZECH_INTEREST,
  answeredArticle,
  cardDigest,
  holder,
  pairRematched,
  resetTranslateWorld,
  skippedArticle,
  slovakArticle,
  startTranslateWorld,
  storedCard,
  translationRows,
  untranslatedCard,
  type SkipReason,
  type TranslateWorld,
} from './support/translate-world.js';

/**
 * M8-T2 `house.translate-cards` and `house.retranslate-skipped` (PLAN §14 "Done when", spec 07 §3
 * and §5, spec 11 §6, spec 05 §5.1) through the real handlers, the real article stages and the
 * outbox run loop. The fake LibreTranslate and Ollama servers and the scripted router stand in for
 * every provider.
 *
 * The API half of the chain (activating a feed records `house.translate-cards {userId}`) is tested
 * in `apps/api/test/subscriptions-translate.int.test.ts`; the worker package cannot import the API,
 * so the chain test below dispatches the payload that test pins.
 */

let w: TranslateWorld;
let h: TranslateWorld['h'];

beforeAll(async () => {
  w = await startTranslateWorld();
  h = w.h;
});

afterAll(async () => {
  await w?.close();
});

beforeEach(async () => {
  await resetTranslateWorld(w);
});

const ENGLISH = 'english' as const;

// ── house.translate-cards ───────────────────────────────────────────────────────────────────────

describe('house.translate-cards (spec 07 §5)', () => {
  it('gives a held card of a user with demand a complete pair, requeues its pairs for matching and records the holder rank', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { userId, feedId, cardId } = await holder(h, 'active');
    const articleId = await answeredArticle(h, feedId, cardId);
    const before = await cardDigest(h, cardId, ENGLISH);
    const original = await storedCard(h, cardId);
    expect(original.interestEn).toBeNull();
    await h.clearOutbox();

    const since = await h.mark();
    await h.dispatch('house.translate-cards', {});

    const card = await storedCard(h, cardId);
    // One validated pair: both fields, the English text differs from the source.
    expect(card.interestEn).toEqual(expect.any(String));
    expect(card.interestEn).not.toBe('');
    expect(card.interestEn).not.toBe(card.interest);
    expect(card.notForEn).toEqual(expect.any(String));
    expect(card.notForEn).not.toBe('');
    // The original text and its hash are untouched (spec 07 §5).
    expect(card.interest).toBe(original.interest);
    expect(card.notFor).toBe(original.notFor);
    expect(card.textHash).toBe(original.textHash);
    expect(card.lang).toBe('sk');
    expect(w.ltCalls()).toBe(1);
    expect(w.lt.requests.find((r) => r.path === '/translate')?.body).toMatchObject({
      source: 'sk',
      target: 'en',
    });
    // The card's digest changed with its effective text, so its earlier answer is not current.
    expect(await cardDigest(h, cardId, ENGLISH)).not.toBe(before);

    // Holder rank recorded, in the same step as the pair.
    const ranks = await h.payloads('user.rank', since);
    expect(ranks).toContainEqual(expect.objectContaining({ userId, full: true }));
    // Rematched: the pair is queued for matching (directly or through `house.rematch {cardId}`).
    expect(await pairRematched(h, articleId, cardId)).toBe(true);
  });

  it('translates a label card too', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { cardId } = await holder(h, 'active', { kind: 'label' });
    await h.dispatch('house.translate-cards', {});
    expect((await storedCard(h, cardId)).interestEn).toEqual(expect.any(String));
  });

  it('translates a card with no not_for as a pair of one', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { cardId } = await holder(h, 'active', { notFor: null });
    await h.dispatch('house.translate-cards', {});
    const card = await storedCard(h, cardId);
    expect(card.interestEn).toEqual(expect.any(String));
    expect(card.notForEn).toBeNull();
  });

  it('skips a card whose holders have no demand: off, training without a selection, scoped to an off feed', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const demanded = await holder(h, 'active');
    const off = await holder(h, 'off');
    const training = await holder(h, 'training');
    // Active on one feed, but the card is scoped to another feed that is off.
    const scoped = await holder(h, 'active', { interest: CZECH_INTEREST, lang: 'cs' });
    const otherFeed = await h.feed();
    await h.subscribe(scoped.userId, otherFeed, 'off');
    const scopedCard = await untranslatedCard(h, scoped.userId, { scopeFeedId: otherFeed });
    await h.clearOutbox();

    const since = await h.mark();
    await h.dispatch('house.translate-cards', {});

    expect((await storedCard(h, demanded.cardId)).interestEn).toEqual(expect.any(String));
    expect((await storedCard(h, scoped.cardId)).interestEn).toEqual(expect.any(String));
    for (const cardId of [off.cardId, training.cardId, scopedCard]) {
      expect((await storedCard(h, cardId)).interestEn).toBeNull();
    }
    // Only the two demanded cards were sent; nothing for the others, and no rematch for them.
    expect(w.ltCalls()).toBe(2);
    const rematched = (await h.payloads('house.rematch', since)).map((p) => String(p['cardId']));
    for (const cardId of [off.cardId, training.cardId, scopedCard]) {
      expect(rematched).not.toContain(cardId);
    }
  });

  it('translates the card of a training user once a selected request of the user is live', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { userId, feedId, cardId } = await holder(h, 'training');
    const articleId = await h.article({ feedIds: [feedId], lang: 'en', firstSeenAt: ago(HOUR) });
    await h.select(userId, feedId, articleId);
    await h.dispatch('house.translate-cards', {});
    expect((await storedCard(h, cardId)).interestEn).toEqual(expect.any(String));
  });

  it('skips a retired card', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { cardId } = await holder(h, 'active');
    await h.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [cardId]);
    await h.dispatch('house.translate-cards', {});
    expect((await storedCard(h, cardId)).interestEn).toBeNull();
    expect(w.ltCalls()).toBe(0);
  });

  it('sends no request for an English, undetermined or unsupported card language', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const cards = [
      await holder(h, 'active', { lang: 'en', interest: 'Hiking routes in the Tatra mountains' }),
      await holder(h, 'active', { lang: 'und', interest: 'Tatry' }),
      // Not installed in the fake server's tier-1 model set.
      await holder(h, 'active', { lang: 'de', interest: 'Wanderwege in der Hohen Tatra' }),
    ];
    const since = await h.mark();
    await h.dispatch('house.translate-cards', {});
    expect(w.ltCalls()).toBe(0);
    for (const { cardId } of cards) {
      expect(await storedCard(h, cardId)).toMatchObject({ interestEn: null, notForEn: null });
    }
    expect(await h.payloads('house.rematch', since)).toEqual([]);
  });

  it('keeps the original text when the translation is weak, and sends no second request on its own', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const { cardId } = await holder(h, 'active');
    w.lt.setOptions({ mode: 'weak' });
    const since = await h.mark();
    await h.dispatch('house.translate-cards', {});
    expect(w.ltCalls()).toBe(1);
    expect(await storedCard(h, cardId)).toMatchObject({ interestEn: null, notForEn: null });
    // Not published, so nothing to rematch.
    expect(await h.payloads('house.rematch', since)).toEqual([]);
  });

  it('with {userId} translates only that user cards; a second run translates nothing twice', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    const first = await holder(h, 'active');
    const second = await holder(h, 'active');

    await h.dispatch('house.translate-cards', { userId: first.userId });
    expect((await storedCard(h, first.cardId)).interestEn).toEqual(expect.any(String));
    expect((await storedCard(h, second.cardId)).interestEn).toBeNull();
    expect(w.ltCalls()).toBe(1);

    // Running the same restriction again: the pair exists, so no request and no new work.
    await h.clearOutbox();
    const since = await h.mark();
    await h.dispatch('house.translate-cards', { userId: first.userId });
    expect(w.ltCalls()).toBe(1);
    expect(await h.payloads('house.rematch', since)).toEqual([]);
    expect(await h.payloads('user.rank', since)).toEqual([]);

    // The unrestricted run fills the other user's card and leaves the first one alone.
    const pair = await storedCard(h, first.cardId);
    await h.dispatch('house.translate-cards', {});
    expect(w.ltCalls()).toBe(2);
    expect((await storedCard(h, second.cardId)).interestEn).toEqual(expect.any(String));
    expect(await storedCard(h, first.cardId)).toMatchObject({
      interestEn: pair.interestEn,
      notForEn: pair.notForEn,
    });
  });

  it('does nothing while card text is as written', async () => {
    await h.setSetting('card_text_mode', 'as_written');
    const { userId, cardId } = await holder(h, 'active');
    const since = await h.mark();
    await h.dispatch('house.translate-cards', {});
    await h.dispatch('house.translate-cards', { userId });
    expect(w.ltCalls()).toBe(0);
    expect(await storedCard(h, cardId)).toMatchObject({ interestEn: null, notForEn: null });
    expect(await h.payloads('house.rematch', since)).toEqual([]);
    expect(await h.payloads('user.rank', since)).toEqual([]);
  });

  it('Done-when: a card skipped for lack of demand is translated and rematched after its holder activates a feed', async () => {
    await h.setSetting('card_text_mode', ENGLISH);
    // The holder subscribed to a feed but runs no inference on it.
    const { userId, feedId, cardId } = await holder(h, 'off');

    // 1. The switch to english enqueues `{}`: the card has no demand, so it is skipped.
    await h.dispatch('house.translate-cards', {});
    expect(w.ltCalls()).toBe(0);
    expect(await storedCard(h, cardId)).toMatchObject({ interestEn: null, notForEn: null });

    // 2. The holder activates the feed. (The API records `house.translate-cards {userId}` for this
    //    event; see apps/api/test/subscriptions-translate.int.test.ts.)
    await h.setMode(userId, feedId, 'active');
    await new Promise((resolve) => setTimeout(resolve, 25));
    // An article that arrived after the activation, already answered for the card's old text.
    const articleId = await answeredArticle(h, feedId, cardId, { firstSeenAt: new Date() });
    await h.clearOutbox();

    // 3. The user-scoped run translates the card and rematches its pair.
    const since = await h.mark();
    await h.dispatch('house.translate-cards', { userId });
    expect(w.ltCalls()).toBe(1);
    expect((await storedCard(h, cardId)).interestEn).toEqual(expect.any(String));
    expect((await storedCard(h, cardId)).notForEn).toEqual(expect.any(String));
    expect(await h.payloads('user.rank', since)).toContainEqual(
      expect.objectContaining({ userId, full: true }),
    );
    expect(await pairRematched(h, articleId, cardId)).toBe(true);
  });
});

// ── house.retranslate-skipped ───────────────────────────────────────────────────────────────────

const REASONS: readonly SkipReason[] = ['no_key', 'cap', 'budget'];

/** A Slovak article of an active reader, tier 2 skipped for `reason`, enriched from native text. */
async function skipped(
  reason: SkipReason,
  options: { firstSeenAt?: Date; feedId?: string } = {},
): Promise<{ articleId: string; userId: string; feedId: string }> {
  const userId = await h.user();
  const feedId = options.feedId ?? (await h.feed());
  await h.subscribe(userId, feedId, 'active', ago(40 * DAY));
  const articleId = await slovakArticle(h, feedId, options.firstSeenAt);
  await skippedArticle(w, articleId, reason);
  return { articleId, userId, feedId };
}

const ollamaRow = async (articleId: string) =>
  (await translationRows(h, articleId)).find((row) => row.engine === 'ollama');

describe('house.retranslate-skipped (spec 07 §3)', () => {
  describe.each(REASONS)('a tier-2 row skipped for %s', (reason) => {
    it('is not retried by redelivery or a budget reset', async () => {
      const { articleId } = await skipped(reason);
      expect((await ollamaRow(articleId))?.detail).toMatchObject({ skipped: reason });
      expect(w.ollamaCalls()).toBe(0);

      // The key, the cap and the budget are all fine again, and the job is delivered again.
      h.router.reset();
      await h.dispatch('article.translate', { articleId });
      await h.dispatch('article.translate', { articleId });
      await h.dispatch('article.translate', { articleId, forceTier2: true });
      expect(w.ollamaCalls()).toBe(0);
      expect(h.router.reservations).toEqual([]);
      expect((await ollamaRow(articleId))?.detail).toMatchObject({ skipped: reason });
    });

    it('is replaced for a still-demanded window article, which is re-enriched from the new translation', async () => {
      const { articleId } = await skipped(reason);
      expect(await h.articleRow(articleId)).toMatchObject({ state: 'enriched', revision: '1' });
      expect((await h.facetRow(articleId))?.variant).toBe('native');

      const since = await h.mark();
      await h.dispatch('house.retranslate-skipped', {});
      const sent = (await h.payloads('article.translate', since)).filter(forArticles(articleId));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ articleId, forceTier2: true, replaceSkipped: true });
      // Nothing is sent to a provider by the house job itself.
      expect(w.ollamaCalls()).toBe(0);

      await h.run('article.translate', forArticles(articleId));
      expect(w.ollamaCalls()).toBe(1);
      expect((await ollamaRow(articleId)) ?? null).toMatchObject({ quality: 'ok' });
      expect((await ollamaRow(articleId))?.detail['skipped']).toBeUndefined();
      // The best translation changed the effective input: the article was reset and re-enriched.
      expect((await h.articleRow(articleId)).revision).toBe('2');
      expect(await h.payloads('article.enrich', since)).toContainEqual({
        articleId,
        priority: 'bulk',
      });
      await h.run('article.enrich', forArticles(articleId));
      expect((await h.facetRow(articleId))?.variant).toBe('translated');
    });
  });

  it('sends the replacements newest first', async () => {
    const feedId = await h.feed();
    const oldest = (await skipped('cap', { feedId, firstSeenAt: ago(3 * HOUR) })).articleId;
    const newest = (await skipped('no_key', { feedId, firstSeenAt: ago(HOUR) })).articleId;
    const middle = (await skipped('budget', { feedId, firstSeenAt: ago(2 * HOUR) })).articleId;

    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    const sent = (await h.payloads('article.translate', since)).map((p) => String(p['articleId']));
    expect(sent).toEqual([newest, middle, oldest]);
  });

  it('respects a reasons filter', async () => {
    const feedId = await h.feed();
    const noKey = (await skipped('no_key', { feedId })).articleId;
    const cap = (await skipped('cap', { feedId })).articleId;
    const budget = (await skipped('budget', { feedId })).articleId;

    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', { reasons: ['cap', 'budget'] });
    const sent = (await h.payloads('article.translate', since)).map((p) => String(p['articleId']));
    expect(sent.sort()).toEqual([cap, budget].sort());
    expect(sent).not.toContain(noKey);
  });

  it('leaves alone an article outside the window and one whose demand is gone', async () => {
    const outside = await skipped('no_key', { firstSeenAt: ago(15 * DAY) });
    const inside = await skipped('no_key');
    const lost = await skipped('no_key');
    await h.setMode(lost.userId, lost.feedId, 'off');

    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    const sent = (await h.payloads('article.translate', since)).map((p) => String(p['articleId']));
    expect(sent).toEqual([inside.articleId]);
    expect(sent).not.toContain(outside.articleId);
    expect(sent).not.toContain(lost.articleId);
  });

  it('leaves alone an article of a language that is no longer translated', async () => {
    await skipped('no_key');
    await h.setSetting('language_modes', { en: 'native', sk: 'native', cs: 'native' });
    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    expect(await h.payloads('article.translate', since)).toEqual([]);
  });

  it('never opts a user in: an article whose readers only train or are off is not sent', async () => {
    const reader = await skipped('no_key');
    await h.setMode(reader.userId, reader.feedId, 'training');
    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    expect(await h.payloads('article.translate', since)).toEqual([]);
  });

  it('sends nothing while the budget is spent', async () => {
    await skipped('budget');
    h.router.spendable = false;
    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    expect(await h.payloads('article.translate', since)).toEqual([]);
  });

  it('respects the tier-2 cap: with a cap of 1 at most one replacement is sent, the newest', async () => {
    const feedId = await h.feed();
    await skipped('no_key', { feedId, firstSeenAt: ago(3 * HOUR) });
    await skipped('no_key', { feedId, firstSeenAt: ago(2 * HOUR) });
    const newest = (await skipped('no_key', { feedId, firstSeenAt: ago(HOUR) })).articleId;
    await h.setSetting('translate.tier2_daily_cap', 1);

    const since = await h.mark();
    await h.dispatch('house.retranslate-skipped', {});
    const sent = await h.payloads('article.translate', since);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ articleId: newest, forceTier2: true, replaceSkipped: true });
  });
});
