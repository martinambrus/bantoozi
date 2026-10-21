import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyHarness } from './support/classify.js';

/**
 * Reuse stays exact: `article.enrich` on facets of another release of the pinned Jev major asks
 * the router again, and reuses facets of the pinned release (spec 05 §5.5 step 2).
 */

const V113 = 'jev-1.13.0';
const V114 = 'jev-1.14.0';

let h: ClassifyHarness;

beforeAll(async () => {
  h = await ClassifyHarness.start();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  h.router.reset();
  h.router.model = V114;
  await h.clearOutbox();
});

async function scenario() {
  const feedId = await h.feed();
  const userId = await h.user();
  await h.subscribe(userId, feedId, 'active');
  await h.heldCard(userId, { topicIds: ['technology'] });
  return h.article({ feedIds: [feedId] });
}

describe('article.enrich across releases of one Jev major', () => {
  it('asks again for facets written by another release and rewrites them', async () => {
    const articleId = await scenario();
    await h.enrichDirect(articleId, { model: V113, state: 'extracted' });
    await h.dispatchAs(V114, 'article.enrich', { articleId });
    expect(h.router.asksFor(articleId, 'enrich')).toHaveLength(1);
    expect(await h.facetRow(articleId)).toMatchObject({ engine: 'typesafe', model: V114 });
  });

  it('reuses facets of the pinned release without asking', async () => {
    const articleId = await scenario();
    await h.enrichDirect(articleId, { model: V114, state: 'extracted' });
    await h.dispatchAs(V114, 'article.enrich', { articleId });
    expect(h.router.asksFor(articleId, 'enrich')).toHaveLength(0);
  });
});
