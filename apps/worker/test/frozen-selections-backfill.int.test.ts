import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness, DAY, ago } from './support/classify.js';

/**
 * D-254 frozen selections: a card created after an explicit selection never queues work on a
 * selected article that was never enriched (`extracted`/`translated`); the selection is answered
 * for the cards it froze. Enriched selections and admitted active arrivals keep their backfill.
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

async function queued(articleIds: readonly string[]): Promise<string[]> {
  const result = await h.owner.query<{ article_id: string }>(
    `SELECT DISTINCT article_id::text AS article_id FROM match_queue
      WHERE article_id = ANY($1::bigint[]) ORDER BY 1`,
    [articleIds],
  );
  return result.rows.map((row) => row.article_id);
}

describe('card.backfill on frozen selections (D-254)', () => {
  it('queues nothing for a selected extracted/translated article, keeps active arrivals and enriched selections', async () => {
    const userId = await h.user();
    await h.heldCard(userId);
    const training = await h.feed();
    const active = await h.feed();
    await h.subscribe(userId, training, 'training');
    await h.subscribe(userId, active, 'active', ago(30 * DAY));

    const extracted = await h.article({ feedIds: [training] });
    await h.enrichDirect(extracted, { state: 'extracted' });
    const translated = await h.article({ feedIds: [training] });
    await h.enrichDirect(translated, { state: 'translated' });
    const enriched = await h.article({ feedIds: [training] });
    await h.enrichDirect(enriched);
    const arrival = await h.article({ feedIds: [active] });
    for (const id of [extracted, translated, enriched]) await h.select(userId, training, id);

    const newCard = await h.heldCard(userId);
    const since = await h.mark();
    await h.dispatch('card.backfill', { userId, cardIds: [newCard] });

    expect(await queued([extracted, translated])).toEqual([]);
    expect(await queued([enriched, arrival])).toEqual([enriched, arrival].sort());
    const asked = (await h.payloads('article.enrich', since)).concat(
      await h.payloads('article.match', since),
    );
    expect(asked.map((payload) => payload['articleId'])).toEqual([enriched]);
    expect(h.router.asks).toEqual([]);
  });
});
