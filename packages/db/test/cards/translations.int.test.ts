import { cardTextHash } from '@bantoozi/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createUserCard,
  editCardText,
  fillCardTranslation,
  getUserCard,
  type CardTranslationFillInput,
} from '../../src/cards/index.js';
import { asTenant, setupDbTest, sqlStateOf, type DbTestContext } from '../support/test-db.js';
import { asUser, createReader, insertCard, numeric, storedCard, takeOutbox } from './helpers.js';

/**
 * Card text translation (spec 07 §5, spec 05 §5.1): the API's English pair stored with the detected
 * language when a card row is created, the hash of the original text only, and the worker's one-time
 * fill of an absent pair — the only change a stored card body ever gets outside the audited
 * retranslation flow.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let sequence = 0;
function uniqueText(label: string): string {
  sequence += 1;
  return `${label} ${sequence}`;
}

const fill = (input: CardTranslationFillInput) =>
  ctx.worker.transaction((tx) => fillCardTranslation(tx, input));

describe('caller-supplied English pair', () => {
  it('stores the pair and the detected language with a new card; the hash covers the original only', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Slovenská domáca politika a vláda číslo');
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, {
        title: 'Slovenská politika',
        interest,
        notFor: 'Zahraničná politika',
        strength: 'like',
        lang: 'sk',
        translation: { interestEn: ' Slovak domestic politics ', notForEn: 'Foreign politics' },
      }),
    );
    expect(created.card).toMatchObject({
      lang: 'sk',
      interest,
      notFor: 'Zahraničná politika',
      interestEn: 'Slovak domestic politics',
      notForEn: 'Foreign politics',
    });
    expect(await storedCard(ctx, created.card.id)).toMatchObject({
      lang: 'sk',
      text_hash: cardTextHash({
        kind: 'interest',
        title: 'Slovenská politika',
        interest,
        not_for: 'Zahraničná politika',
        visibility: 'shared',
      }),
      body: {
        interest,
        not_for: 'Zahraničná politika',
        interest_en: 'Slovak domestic politics',
        not_for_en: 'Foreign politics',
      },
    });

    // An edit creates another card row, again with the caller's pair.
    const edited = await asUser(ctx, r.id, (tx) =>
      editCardText(tx, {
        cardId: created.card.id,
        interest: uniqueText('Slovenská vláda a parlament číslo'),
        notFor: null,
        lang: 'sk',
        translation: { interestEn: 'Slovak government and parliament', notForEn: null },
      }),
    );
    expect(edited.card).toMatchObject({
      lang: 'sk',
      notFor: null,
      interestEn: 'Slovak government and parliament',
      notForEn: null,
    });
    expect(edited.card.id).not.toBe(created.card.id);
    // Without a detected language the card is `und` and has no pair.
    const plain = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Plain interest'), strength: 'like' }),
    );
    expect(plain.card).toMatchObject({ lang: 'und', interestEn: null, notForEn: null });
  });

  it('never writes a pair onto an existing card from the API; English mode queues the worker fill', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const interest = uniqueText('Česká technologická scéna číslo');
    const first = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like', lang: 'cs' }),
    );
    await ctx.owner.query(
      `INSERT INTO settings (key, value) VALUES ('card_text_mode', '"english"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const reused = await asUser(ctx, b.id, (tx) =>
        createUserCard(tx, {
          interest,
          strength: 'like',
          lang: 'cs',
          translation: { interestEn: 'Czech tech scene', notForEn: null },
        }),
      );
      expect(reused.card).toMatchObject({ id: first.card.id, interestEn: null });
      expect((await storedCard(ctx, first.card.id)).body).toMatchObject({ interest_en: null });
      const feedIds = numeric(b.active);
      expect(await takeOutbox(ctx, b.id)).toEqual([
        { queue: 'card.backfill', payload: { userId: b.id, cardIds: [first.card.id], feedIds } },
        { queue: 'house.translate-cards', payload: { userId: b.id } },
        { queue: 'user.rank', payload: { userId: b.id, reason: 'cards', full: true } },
        { queue: 'user.learn', payload: { userId: b.id } },
      ]);
    } finally {
      await ctx.owner.query("DELETE FROM settings WHERE key = 'card_text_mode'");
    }
    // As written (the default), no translation job is queued.
    await asUser(ctx, b.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Another card'), strength: 'like' }),
    );
    expect((await takeOutbox(ctx, b.id)).map((i) => i.queue)).toEqual([
      'card.backfill',
      'user.rank',
      'user.learn',
    ]);
  });
});

describe('worker one-time fill', () => {
  it('fills an absent pair once and never overwrites it', async () => {
    const r = await createReader(ctx);
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, {
        interest: uniqueText('Slovenský futbal a Niké liga číslo'),
        notFor: 'Futbal v zahraničí',
        strength: 'like',
        lang: 'sk',
      }),
    );
    const id = created.card.id;
    const before = await storedCard(ctx, id);
    expect(
      await fill({
        cardId: id,
        interestEn: ' Slovak football league ',
        notForEn: 'Football abroad',
      }),
    ).toBe('filled');
    const after = await storedCard(ctx, id);
    expect(after).toEqual({
      ...before,
      body: {
        ...before.body,
        interest_en: 'Slovak football league',
        not_for_en: 'Football abroad',
      },
    });
    const held = await asUser(ctx, r.id, (tx) => getUserCard(tx, id));
    expect(held).toMatchObject({
      interestEn: 'Slovak football league',
      notForEn: 'Football abroad',
    });

    expect(await fill({ cardId: id, interestEn: 'Something else', notForEn: 'Other' })).toBe(
      'unchanged',
    );
    expect(await fill({ cardId: '999999999', interestEn: 'Nothing', notForEn: null })).toBe(
      'missing',
    );
    expect(await storedCard(ctx, id)).toEqual(after);
  });

  it('refuses incomplete or oversized pairs without writing', async () => {
    const withNotFor = await insertCard(ctx, {
      visibility: 'shared',
      interest: uniqueText('Card with a not_for'),
      notFor: 'Something else',
    });
    const withoutNotFor = await insertCard(ctx, {
      visibility: 'shared',
      interest: uniqueText('Card without a not_for'),
    });
    const bad: CardTranslationFillInput[] = [
      { cardId: withNotFor, interestEn: 'English', notForEn: null },
      { cardId: withNotFor, interestEn: 'English', notForEn: '  ' },
      { cardId: withNotFor, interestEn: ' ', notForEn: 'English' },
      { cardId: withoutNotFor, interestEn: 'English', notForEn: 'Unexpected' },
      { cardId: withoutNotFor, interestEn: 'x'.repeat(601), notForEn: null },
    ];
    for (const input of bad) {
      await expect(fill(input), JSON.stringify(input).slice(0, 80)).rejects.toThrow(RangeError);
    }
    for (const id of [withNotFor, withoutNotFor]) {
      expect((await storedCard(ctx, id)).body).toMatchObject({
        interest_en: null,
        not_for_en: null,
      });
    }
    expect(await fill({ cardId: withoutNotFor, interestEn: 'x'.repeat(600), notForEn: null })).toBe(
      'filled',
    );
  });

  it('is the only body change the database allows: overwrites and partial pairs are rejected', async () => {
    const id = await insertCard(ctx, {
      visibility: 'shared',
      interest: uniqueText('Guarded card'),
      notFor: 'Unrelated things',
    });
    const set = (pair: Record<string, string | null>) =>
      ctx.workerPool.query('UPDATE interest_cards SET body = body || $2::jsonb WHERE id = $1', [
        id,
        JSON.stringify(pair),
      ]);
    // A partial pair (not_for without its translation) is invalid.
    expect(await sqlStateOf(set({ interest_en: 'Guarded card' }))).toBe('23514');
    expect(await fill({ cardId: id, interestEn: 'Guarded card', notForEn: 'Unrelated' })).toBe(
      'filled',
    );
    // A silent overwrite of a stored pair, or of the original text, is rejected.
    expect(await sqlStateOf(set({ interest_en: 'Overwritten', not_for_en: 'Other' }))).toBe(
      '23514',
    );
    expect(await sqlStateOf(set({ interest: 'Rewritten interest' }))).toBe('23514');
    // The API role cannot write a card body at all.
    const r = await createReader(ctx);
    expect(
      await sqlStateOf(
        asTenant(ctx.appPool, r.id, (client) =>
          client.query(
            `UPDATE interest_cards SET body = body || '{"interest_en": null}'::jsonb WHERE id = $1`,
            [id],
          ),
        ),
      ),
    ).toBe('42501');
    expect((await storedCard(ctx, id)).body).toMatchObject({
      interest_en: 'Guarded card',
      not_for_en: 'Unrelated',
    });
  });
});
