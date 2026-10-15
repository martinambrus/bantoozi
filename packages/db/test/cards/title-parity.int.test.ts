import { createArticle } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cardsMadeFromFeedArticles } from '../../src/api/articles.js';
import { createCardFromArticle } from '../../src/cards/index.js';
import { exampleFromArticleTitle } from '../../src/cards/validation.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';
import { asUser, createReader } from './helpers.js';

/**
 * `cardsMadeFromFeedArticles` re-normalizes feed article titles in SQL to find the cards made from
 * them; that must equal `exampleFromArticleTitle` (what the card stored) for every title.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

const long = `${'word '.repeat(39)}ab cd${' tail'.repeat(10)}`; // spaces around character 200
const longTrailingSpace = `${'x'.repeat(199)} yz${' w'.repeat(20)}`; // the cut lands right after a space
const TITLES: Record<string, string> = {
  plain: 'Plain title',
  bel: 'Bell\u0007 ringing',
  unitSeparator: 'Unit\u001fseparator news',
  del: 'Delete\u007fchar story',
  c0Run: 'a\u0001\u0002\u0003b \u000e\u001f c',
  nbsp: 'Non breaking space',
  ogham: 'Ogham space',
  enQuad: 'En quad em thin spaces',
  lineSeparators: 'Line sep para',
  narrowNbsp: 'Narrow nbsp medium　ideographic',
  bom: '﻿Bom leading and﻿ trailing﻿',
  zeroWidth: 'Zero​width‍kept',
  nel: 'Next\u0085line',
  runs: 'tab\t\tand\n\nnewline\u000b\u000cvt ff\r\n done',
  edges: '   \t leading and trailing \n  ',
  controlEdges: '\u0007  padded  \u007f',
  long,
  longTrailingSpace,
  emoji: `${'\u{1F600}'.repeat(150)} \u{1F680}${'e'.repeat(60)}`,
  emojiAtCut: `${'a'.repeat(199)}\u{1F600}\u{1F600}tail`,
};

describe('cardsMadeFromFeedArticles title normalization (FNF-3)', () => {
  for (const [name, title] of Object.entries(TITLES)) {
    it(`finds the card made from a "${name}" title`, async () => {
      const example = exampleFromArticleTitle(title);
      expect(example).not.toBeNull();
      const r = await createReader(ctx);
      const feedId = r.active[0]!;
      const article = await createArticle(ctx.owner, { feedIds: [feedId], title });
      await asUser(ctx, r.id, (tx) =>
        createCardFromArticle(tx, {
          articleId: article.id,
          interest: `Parity ${name}`,
          notFor: null,
          title: `Parity ${name}`,
          strength: 'like',
        }),
      );
      const stored = await ctx.owner.query<{ examples: string[] }>(
        `SELECT ic.body -> 'examples_yes' AS examples
           FROM user_cards uc JOIN interest_cards ic ON ic.id = uc.card_id WHERE uc.user_id = $1`,
        [r.id],
      );
      expect(stored.rows[0]?.examples).toEqual([example]);
      const found = await asUser(ctx, r.id, (tx) => cardsMadeFromFeedArticles(tx, [feedId]));
      expect(found.get(feedId)?.like).toBeInstanceOf(Date);
    });
  }
});
