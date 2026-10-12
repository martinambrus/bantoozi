import { pseudoTranslate } from '@bantoozi/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DAY, HOUR, ago, forArticles } from './support/classify.js';
import {
  MODES_SK_TRANSLATE,
  drainRebuild,
  reader,
  resetWindow,
  startReprocessWorld,
  type ReprocessWorld,
} from './support/reprocess-world.js';

/**
 * M8-F4 (PLAN §14.1, spec 05 §2, spec 11 §6): an enrich-set change together with a language-mode
 * change to `translate` for a language whose articles have no translation yet. `house.reenrich`
 * must translate first and enrich from the translation; today the article has no facets under the
 * new set, so it is sent to `article.enrich` and read natively.
 */

let w: ReprocessWorld;
let h: ReprocessWorld['h'];

beforeAll(async () => {
  w = await startReprocessWorld();
  h = w.h;
}, 240_000);

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

/**
 * An enrich-set change leaves an article with no facets under the active set (facets are keyed by
 * set). The worker verifies the active set against its own code, so a second real set cannot be
 * activated in a test; dropping the article's facets yields the same state for the reenrich page.
 */
async function enrichSetChanged(articleId: string): Promise<void> {
  await h.owner.query('DELETE FROM article_facets WHERE article_id = $1', [articleId]);
}

const ids = (payloads: ReadonlyArray<Record<string, unknown>>): string[] =>
  payloads.map((p) => String(p['articleId'])).sort();

async function recorded(queue: string, since: string, articleIds: readonly string[]) {
  return (await h.payloads(queue, since)).filter((p) =>
    articleIds.includes(String(p['articleId'])),
  );
}

describe('house.reenrich: enrich-set change together with a switch to translate (M8-F4)', () => {
  it('translates a native, never-translated article first and enriches it from the translation, not natively', async () => {
    const r = await reader(h);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(DAY),
    });
    await h.enrichDirect(sk, { state: 'matched' });
    const stored = await h.owner.query(`SELECT 1 FROM article_translations WHERE article_id = $1`, [
      sk,
    ]);
    expect(stored.rowCount).toBe(0);

    await enrichSetChanged(sk);
    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    const since = await h.mark();
    await h.dispatch('house.reenrich', { lang: 'sk' });

    // It goes through the mode-change translation, and no native enrichment is queued for it.
    const translations = await recorded('article.translate', since, [sk]);
    expect(ids(translations)).toEqual([sk]);
    expect(translations.every((p) => p['modeChange'] === true && p['priority'] === 'bulk')).toBe(
      true,
    );
    expect(await recorded('article.enrich', since, [sk])).toEqual([]);

    await h.run('article.translate', forArticles(sk));
    await drainRebuild(h);

    // Every enrichment ask of the article read the translated text.
    const asks = h.router.asksFor(sk, 'enrich');
    expect(asks.length).toBeGreaterThan(0);
    for (const ask of asks) {
      expect(JSON.stringify(ask.request.state)).toContain(pseudoTranslate(SLOVAK.title));
      // The translated state keeps the original title as `original_title` (spec 05 §2), so the
      // Slovak title may appear there; the facet variant below proves the translated text was used.
    }
    const facets = await h.owner.query<{ variant: string }>(
      `SELECT state_variant AS variant FROM article_facets WHERE article_id = $1 AND question_set_id = $2`,
      [sk, h.sets.enrich],
    );
    expect(facets.rows).toEqual([{ variant: 'translated' }]);
  });

  it('control: an article already translated is only enriched under the new set, not translated again', async () => {
    const r = await reader(h);
    await h.setSetting('language_modes', MODES_SK_TRANSLATE);
    const sk = await h.article({
      feedIds: [r.feedId],
      lang: 'sk',
      ...SLOVAK,
      firstSeenAt: ago(HOUR),
    });
    await h.dispatch('article.translate', { articleId: sk });
    await h.run('article.enrich', forArticles(sk));
    await h.clearOutbox();

    await enrichSetChanged(sk);
    const since = await h.mark();
    await h.dispatch('house.reenrich', { lang: 'sk' });

    expect(await recorded('article.translate', since, [sk])).toEqual([]);
    expect(ids(await recorded('article.enrich', since, [sk]))).toEqual([sk]);
  });
});
