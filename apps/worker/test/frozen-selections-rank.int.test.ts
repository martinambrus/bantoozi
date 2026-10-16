import { createUserRankHandler } from '../src/handlers/user-rank.js';
import { parseJobPayload } from '@bantoozi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';

/**
 * D-254 ranker: a card created after a selection froze its cards, with no row on a selection-only
 * `extracted` article, is not applicable there: no `pending_cards` demotion, and the request's own
 * card keeps its answer. The same card stays pending on an enriched selected article.
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

async function rankRow(userId: string, articleId: string) {
  await createUserRankHandler(h.deps)(
    parseJobPayload('user.rank', { userId, reason: 'test', full: true }),
    { queue: 'user.rank', jobId: 'test' },
  );
  const result = await h.owner.query<{ lane: string; rules_fired: string[]; p_like: number }>(
    `SELECT lane, rules_fired, p_like FROM user_article WHERE user_id = $1 AND article_id = $2`,
    [userId, articleId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('not ranked');
  return row;
}

describe('ranker coverage on frozen selections (D-254)', () => {
  it('does not treat a later card as pending on a selected extracted article', async () => {
    const userId = await h.user();
    const first = await h.heldCard(userId);
    const feedId = await h.feed();
    await h.subscribe(userId, feedId, 'training');
    const frozen = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(frozen, { state: 'extracted' });
    await h.answerCard(frozen, first, { engine: 'typesafe', p: 0.05 });
    await h.select(userId, feedId, frozen);
    const enriched = await h.article({ feedIds: [feedId] });
    await h.enrichDirect(enriched);
    await h.answerCard(enriched, first, { engine: 'typesafe', p: 0.05 });
    await h.select(userId, feedId, enriched);
    await h.heldCard(userId);

    const onFrozen = await rankRow(userId, frozen);
    const onEnriched = await rankRow(userId, enriched);

    expect(onEnriched.rules_fired).toContain('pending_cards');
    expect(onFrozen.rules_fired).not.toContain('pending_cards');
    expect(onFrozen.p_like).toBeCloseTo(onEnriched.p_like, 6);
    expect(h.router.asks).toEqual([]);
  });
});
