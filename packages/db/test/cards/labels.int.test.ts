import { cardTextHash } from '@bantoozi/shared/server';
import { createArticle, createSubscription } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCardExample,
  addLabelExample,
  createUserCard,
  createUserLabel,
  deleteUserLabel,
  getUserLabel,
  listUserLabels,
  removeLabelExample,
  renameCard,
  setLabelColor,
  updateUserLabel,
  type CreateUserLabelInput,
} from '../../src/cards/index.js';
import type { TenantTx } from '../../src/tenant.js';
import { setupDbTest, type DbTestContext } from '../support/test-db.js';
import {
  appErrorOf,
  asUser,
  cardIdentities,
  cardIntents,
  createReader,
  expectCardsUnchanged,
  feedCards,
  insertCard,
  numeric,
  selectArticle,
  storedCard,
  takeOutbox,
} from './helpers.js';

/**
 * The label rows of the spec 05 §5.1 lifecycle table: create (a `label` card whose hash includes the
 * name), examples in private label forks, rename/redefine to another label card, colour in place and
 * delete — every re-point migrating the user's `label_ids`/`label_suggestions` with `array_replace`
 * in the same transaction, labels ranking fully but never training the interest model.
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
  return `${label} kind of article number ${sequence}`;
}

const NO_EFFECTS = { refreshFeedIds: [], rankFull: false, learn: false };

/** The user's labels as `card:name:color`. */
async function labelHoldings(userId: string): Promise<string[]> {
  const { rows } = await ctx.owner.query<{ row: string }>(
    `SELECT card_id || ':' || name || ':' || color AS row FROM user_labels
      WHERE user_id = $1 ORDER BY card_id`,
    [userId],
  );
  return rows.map((r) => r.row);
}

/** Assign `labelIds` and suggest `suggestions` on the user's row of an article (committed). */
async function labelArticle(
  userId: string,
  articleId: string,
  labelIds: string[],
  suggestions: string[] = [],
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO user_article (user_id, article_id, label_ids, label_suggestions)
     VALUES ($1, $2, $3::bigint[], $4::bigint[])
     ON CONFLICT (user_id, article_id)
     DO UPDATE SET label_ids = EXCLUDED.label_ids, label_suggestions = EXCLUDED.label_suggestions`,
    [userId, articleId, labelIds, suggestions],
  );
}

interface ArticleLabels {
  ids: string[];
  suggestions: string[];
  version: string;
}

/** The user's article label state, by article id. */
async function articleLabels(userId: string): Promise<Record<string, ArticleLabels>> {
  const { rows } = await ctx.owner.query<ArticleLabels & { article_id: string }>(
    `SELECT article_id::text AS article_id, label_ids::text[] AS ids,
            label_suggestions::text[] AS suggestions, state_version::text AS version
       FROM user_article WHERE user_id = $1`,
    [userId],
  );
  return Object.fromEntries(
    rows.map(({ article_id, ...labels }) => [article_id, labels] as [string, ArticleLabels]),
  );
}

async function newLabel(userId: string, input: Partial<CreateUserLabelInput> = {}) {
  return asUser(ctx, userId, (tx) =>
    createUserLabel(tx, {
      name: input.name ?? `Label ${sequence + 1}`,
      definition: input.definition ?? uniqueText('Articles of a'),
      ...input,
    }),
  );
}

// ── Create ────────────────────────────────────────────────────────────────────────────────────────

describe('create a label', () => {
  it('stores a shared label card whose hash includes the name; labels rank fully and never learn', async () => {
    const r = await createReader(ctx);
    const selected = await createArticle(ctx.owner, { feedIds: [r.training] });
    await selectArticle(ctx, { userId: r.id, feedId: r.training, articleId: selected.id });
    const definition = uniqueText('In-depth pieces that take long to read');
    const created = await asUser(ctx, r.id, (tx) =>
      createUserLabel(tx, { name: 'Longread', definition, notFor: 'Listicles' }),
    );
    const id = created.label.id;
    expect(created).toMatchObject({ created: true, idChange: null });
    expect(created.label).toMatchObject({
      name: 'Longread',
      color: '#64748b',
      cardTitle: 'Longread',
      definition,
      notFor: 'Listicles',
      examplesYes: [],
      examplesNo: [],
      origin: 'user',
      visibility: 'shared',
      isPrivateFork: false,
      lang: 'und',
      count: 0,
    });
    expect(await storedCard(ctx, id)).toMatchObject({
      kind: 'label',
      title: 'Longread',
      origin: 'user',
      visibility: 'shared',
      owner_user_id: null,
      creator_user_id: r.id,
      text_hash: cardTextHash({
        kind: 'label',
        title: 'Longread',
        interest: definition,
        not_for: 'Listicles',
        visibility: 'shared',
      }),
    });

    // Labels are unscoped: every active feed materializes them; the selected training article is
    // admitted demand for the backfill. No `user.learn`: labels never train the interest model.
    const active = numeric(r.active);
    const feedIds = numeric([...r.active, r.training]);
    expect(created.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [id], feedIds },
      rankFull: true,
      learn: false,
    });
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { backfill: { cardIds: [id], feedIds }, learn: false, reason: 'labels' }),
    );
    expect(await feedCards(ctx, [...r.active, r.training, r.off])).toEqual(
      active.map((feedId) => `${feedId}:${id}:1`),
    );
    expect(await labelHoldings(r.id)).toEqual([`${id}:Longread:#64748b`]);

    // The same definition under another name, or as an interest, is another card; another user
    // creating the same label (by norm) shares the row but keeps their own name.
    const renamed = await newLabel(r.id, { name: 'Deep reads', definition, notFor: 'Listicles' });
    expect(renamed.label.id).not.toBe(id);
    const interest = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: definition, notFor: 'Listicles', strength: 'like' }),
    );
    expect(interest.card.id).not.toBe(id);
    const other = await createReader(ctx);
    const shared = await asUser(ctx, other.id, (tx) =>
      createUserLabel(tx, {
        name: 'LONGREAD ',
        definition: definition.toUpperCase(),
        notFor: 'listicles',
        color: '#AA3300',
      }),
    );
    expect(shared.label).toMatchObject({
      id,
      name: 'LONGREAD',
      color: '#aa3300',
      cardTitle: 'Longread',
    });
    expect((await storedCard(ctx, id)).creator_user_id).toBe(r.id);
  });

  it('replays the same name idempotently; another name or colour of a held label conflicts', async () => {
    const r = await createReader(ctx);
    const definition = uniqueText('Explainers of complex topics');
    const first = await newLabel(r.id, { name: 'Deep dive', definition, color: '#112233' });
    await takeOutbox(ctx, r.id);

    for (const replay of [{ color: '#112233' }, {}, { color: '#112233', name: 'Deep dive' }]) {
      const again = await newLabel(r.id, { name: 'Deep dive', definition, ...replay });
      expect(again, JSON.stringify(replay)).toEqual({
        label: first.label,
        idChange: null,
        created: false,
        effects: NO_EFFECTS,
      });
    }
    for (const change of [{ color: '#445566' }, { name: 'deep  DIVE' }]) {
      expect(
        await appErrorOf(newLabel(r.id, { name: 'Deep dive', definition, ...change })),
        JSON.stringify(change),
      ).toEqual({ code: 'CONFLICT', details: { reason: 'already_held', labelId: first.label.id } });
    }
    expect(await labelHoldings(r.id)).toEqual([`${first.label.id}:Deep dive:#112233`]);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
  });

  it('validates name, definition, colour and translation before writing anything', async () => {
    const r = await createReader(ctx);
    const base = { name: 'Valid', definition: uniqueText('Valid definition') };
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ name: '' }, 'name', 'required'],
      [{ name: 'x'.repeat(61) }, 'name', 'too_long'],
      [{ definition: 'ab' }, 'definition', 'too_short'],
      [{ definition: 'x'.repeat(301) }, 'definition', 'too_long'],
      [{ notFor: 'x'.repeat(301) }, 'notFor', 'too_long'],
      [{ color: 'red' }, 'color', 'color'],
      [{ color: '#12345' }, 'color', 'color'],
      [
        { lang: 'en', translation: { interestEn: 'x y z', notForEn: null } },
        'translation',
        'language',
      ],
    ];
    for (const [override, field, reason] of cases) {
      const input = { ...base, ...override } as unknown as CreateUserLabelInput;
      expect(
        await appErrorOf(asUser(ctx, r.id, (tx) => createUserLabel(tx, input))),
        JSON.stringify(override).slice(0, 60),
      ).toEqual({ code: 'VALIDATION_FAILED', details: { field, reason } });
    }
    expect(await labelHoldings(r.id)).toEqual([]);
  });
});

// ── Examples ──────────────────────────────────────────────────────────────────────────────────────

describe('label examples', () => {
  it('forks the label privately and migrates only this user’s label_ids and suggestions', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.active[0], mode: 'active' });
    const definition = uniqueText('Hands-on tutorials');
    const label = await newLabel(a.id, { name: 'Tutorial', definition, color: '#00aa00' });
    const other = await newLabel(a.id, { name: 'Other', definition: uniqueText('Other') });
    const L = label.label.id;
    const M = other.label.id;
    const shared = await newLabel(b.id, { name: 'TUTORIAL', definition: definition.toLowerCase() });
    expect(shared.label.id).toBe(L);

    const [x, y, z] = [
      await createArticle(ctx.owner, { feedIds: [a.active[0]], title: 'Build a  bot in Rust' }),
      await createArticle(ctx.owner, { feedIds: [a.active[0]] }),
      await createArticle(ctx.owner, { feedIds: [a.active[0]] }),
    ];
    await labelArticle(a.id, x.id, [M, L]);
    await labelArticle(a.id, y.id, [M], [L]);
    await labelArticle(a.id, z.id, [M]);
    await labelArticle(b.id, x.id, [L]);
    const [beforeA, beforeB] = [await articleLabels(a.id), await articleLabels(b.id)];
    await takeOutbox(ctx, a.id);

    const forked = await asUser(ctx, a.id, (tx) =>
      addLabelExample(tx, { labelId: L, articleId: x.id, side: 'yes' }),
    );
    const F = forked.label.id;
    expect(F).not.toBe(L);
    expect(forked).toMatchObject({ created: false, idChange: { from: L, to: F } });
    expect(forked.label).toMatchObject({
      name: 'Tutorial',
      color: '#00aa00',
      cardTitle: 'Tutorial',
      definition,
      examplesYes: ['Build a bot in Rust'],
      examplesNo: [],
      origin: 'fork',
      visibility: 'private',
      isPrivateFork: true,
      count: 1,
    });
    expect(await storedCard(ctx, F)).toMatchObject({
      kind: 'label',
      title: 'Tutorial',
      visibility: 'private',
      owner_user_id: a.id,
      creator_user_id: a.id,
      parent_card_id: L,
      text_hash: cardTextHash({
        kind: 'label',
        title: 'Tutorial',
        interest: definition,
        examples_yes: ['Build a bot in Rust'],
        visibility: 'private',
        owner_user_id: a.id,
      }),
    });
    const active = numeric(a.active);
    expect(forked.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [F], feedIds: active },
      rankFull: true,
      learn: false,
      labelIdChange: { from: L, to: F },
    });
    expect(await takeOutbox(ctx, a.id)).toEqual(
      cardIntents(a.id, {
        backfill: { cardIds: [F], feedIds: active },
        learn: false,
        reason: 'labels',
      }),
    );

    // array_replace kept each position; a changed assignment bumps state_version, a suggestion
    // alone does not.
    expect(await articleLabels(a.id)).toEqual({
      [x.id]: { ids: [M, F], suggestions: [], version: bump(beforeA[x.id]) },
      [y.id]: { ids: [M], suggestions: [F], version: beforeA[y.id]?.version },
      [z.id]: beforeA[z.id],
    });
    // The other holder keeps the shared label and its assignments, and never sees the fork.
    expect(await articleLabels(b.id)).toEqual(beforeB);
    expect(await labelHoldings(a.id)).toEqual([`${M}:Other:#64748b`, `${F}:Tutorial:#00aa00`]);
    expect(await labelHoldings(b.id)).toEqual([`${L}:TUTORIAL:#64748b`]);
    await asUser(ctx, b.id, async (tx) => {
      expect(await getUserLabel(tx, F)).toBeNull();
      expect((await listUserLabels(tx)).map((l) => l.id)).toEqual([L]);
    });
    // a.active[0] is also b's active feed: b still holds the shared label there.
    expect(await feedCards(ctx, [a.active[0]])).toEqual(
      numeric([F, L, M]).map((card) => `${a.active[0]}:${card}:1`),
    );
  });

  it('removes examples into another fork and back to the shared label; unknown examples are 404', async () => {
    const r = await createReader(ctx);
    const label = await newLabel(r.id, { name: 'Opinion' });
    const L = label.label.id;
    const [first, second] = [
      await createArticle(ctx.owner, { feedIds: [r.active[0]], title: 'Why I left the city' }),
      await createArticle(ctx.owner, { feedIds: [r.active[1]], title: 'Quarterly results' }),
    ];
    await labelArticle(r.id, first.id, [L]);
    const one = await asUser(ctx, r.id, (tx) =>
      addLabelExample(tx, { labelId: L, articleId: first.id, side: 'yes' }),
    );
    const two = await asUser(ctx, r.id, (tx) =>
      addLabelExample(tx, { labelId: one.label.id, articleId: second.id, side: 'no' }),
    );
    expect(two.label).toMatchObject({
      examplesYes: ['Why I left the city'],
      examplesNo: ['Quarterly results'],
      isPrivateFork: true,
    });
    expect((await storedCard(ctx, two.label.id)).parent_card_id).toBe(L);

    // A repeat is a no-op; an example the side lacks is 404 with nothing changed.
    const repeat = await asUser(ctx, r.id, (tx) =>
      addLabelExample(tx, { labelId: two.label.id, articleId: second.id, side: 'no' }),
    );
    expect(repeat).toMatchObject({ idChange: null, effects: NO_EFFECTS });
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          removeLabelExample(tx, { labelId: two.label.id, side: 'yes', text: 'Quarterly results' }),
        ),
      ),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'example' } });
    await takeOutbox(ctx, r.id);

    const back = await asUser(ctx, r.id, (tx) =>
      removeLabelExample(tx, { labelId: two.label.id, side: 'no', text: 'quarterly RESULTS' }),
    );
    // The same examples as before give the same fork back (same hash).
    expect(back.label.id).toBe(one.label.id);
    const shared = await asUser(ctx, r.id, (tx) =>
      removeLabelExample(tx, { labelId: back.label.id, side: 'yes', text: 'Why I left the city' }),
    );
    expect(shared).toMatchObject({
      idChange: { from: one.label.id, to: L },
      label: { id: L, isPrivateFork: false, examplesYes: [], examplesNo: [], name: 'Opinion' },
    });
    expect(shared.effects).toMatchObject({ rankFull: true, learn: false });
    expect((await articleLabels(r.id))[first.id]?.ids).toEqual([L]);
    expect(await labelHoldings(r.id)).toEqual([`${L}:Opinion:#64748b`]);
  });

  it('keeps the newest five examples per side', async () => {
    const r = await createReader(ctx);
    let labelId = (await newLabel(r.id, { name: 'Five' })).label.id;
    const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((t) => `Headline ${t}`);
    for (const title of titles) {
      const article = await createArticle(ctx.owner, { feedIds: [r.active[0]], title });
      labelId = (
        await asUser(ctx, r.id, (tx) =>
          addLabelExample(tx, { labelId, articleId: article.id, side: 'yes' }),
        )
      ).label.id;
    }
    const held = await asUser(ctx, r.id, (tx) => getUserLabel(tx, labelId));
    expect(held?.examplesYes).toEqual(titles.slice(1));
  });
});

// ── Rename, redefine, colour ──────────────────────────────────────────────────────────────────────

describe('rename or redefine a label', () => {
  it('re-points a new name or definition to another label card, carrying the private examples', async () => {
    const r = await createReader(ctx);
    const definition = uniqueText('Step-by-step guides');
    const created = await newLabel(r.id, { name: 'Tutorials', definition, color: '#123456' });
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Set up a home server',
    });
    await labelArticle(r.id, article.id, [created.label.id]);
    const fork = await asUser(ctx, r.id, (tx) =>
      addLabelExample(tx, { labelId: created.label.id, articleId: article.id, side: 'yes' }),
    );
    const F1 = fork.label.id;
    const identities = await cardIdentities(ctx);
    await takeOutbox(ctx, r.id);

    const renamed = await asUser(ctx, r.id, (tx) =>
      updateUserLabel(tx, { labelId: F1, name: 'How-to guides' }),
    );
    const F2 = renamed.label.id;
    expect(F2).not.toBe(F1);
    expect(renamed).toMatchObject({
      idChange: { from: F1, to: F2 },
      label: {
        name: 'How-to guides',
        cardTitle: 'How-to guides',
        color: '#123456',
        definition,
        examplesYes: ['Set up a home server'],
        isPrivateFork: true,
      },
    });
    const S2 = (await storedCard(ctx, F2)).parent_card_id ?? 'missing';
    expect(await storedCard(ctx, S2)).toMatchObject({
      kind: 'label',
      title: 'How-to guides',
      visibility: 'shared',
      creator_user_id: r.id,
      body: { interest: definition, examples_yes: [] },
    });
    const active = numeric(r.active);
    expect(renamed.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [F2], feedIds: active },
      rankFull: true,
      learn: false,
      labelIdChange: { from: F1, to: F2 },
    });
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, {
        backfill: { cardIds: [F2], feedIds: active },
        learn: false,
        reason: 'labels',
      }),
    );
    expect((await articleLabels(r.id))[article.id]?.ids).toEqual([F2]);

    const redefinition = uniqueText('Practical walkthroughs');
    const redefined = await asUser(ctx, r.id, (tx) =>
      updateUserLabel(tx, { labelId: F2, definition: redefinition, notFor: 'Opinion pieces' }),
    );
    const F3 = redefined.label.id;
    expect(redefined.label).toMatchObject({
      name: 'How-to guides',
      definition: redefinition,
      notFor: 'Opinion pieces',
      examplesYes: ['Set up a home server'],
    });
    expect((await articleLabels(r.id))[article.id]?.ids).toEqual([F3]);
    await takeOutbox(ctx, r.id);

    // A name differing only in case or spacing, and a colour, change user_labels in place.
    const recased = await asUser(ctx, r.id, (tx) =>
      updateUserLabel(tx, { labelId: F3, name: ' how-to  GUIDES ' }),
    );
    expect(recased).toMatchObject({
      idChange: null,
      effects: NO_EFFECTS,
      label: { id: F3, name: 'how-to  GUIDES', cardTitle: 'How-to guides' },
    });
    const recolored = await asUser(ctx, r.id, (tx) =>
      setLabelColor(tx, { labelId: F3, color: '#A0B1C2' }),
    );
    expect(recolored).toMatchObject({ idChange: null, effects: NO_EFFECTS });
    expect(await labelHoldings(r.id)).toEqual([`${F3}:how-to  GUIDES:#a0b1c2`]);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
    expect(
      await appErrorOf(asUser(ctx, r.id, (tx) => updateUserLabel(tx, { labelId: F3 }))),
    ).toEqual({ code: 'VALIDATION_FAILED', details: { field: 'body', reason: 'empty' } });

    // No label card was ever rewritten, only new rows inserted.
    await expectCardsUnchanged(ctx, identities);
  });

  it('coalesces two labels that become the same and deduplicates the migrated ids', async () => {
    const r = await createReader(ctx);
    const newsDefinition = uniqueText('Breaking news');
    const news = await newLabel(r.id, {
      name: 'News',
      definition: newsDefinition,
      color: '#000000',
    });
    const heads = await newLabel(r.id, { name: 'Headlines', color: '#000000' });
    const sports = await newLabel(r.id, { name: 'Sports', color: '#111111' });
    const [L1, L2, L3] = [news.label.id, heads.label.id, sports.label.id];
    const [x, y, z, w] = [
      await createArticle(ctx.owner, { feedIds: [r.active[0]] }),
      await createArticle(ctx.owner, { feedIds: [r.active[0]] }),
      await createArticle(ctx.owner, { feedIds: [r.active[0]] }),
      await createArticle(ctx.owner, { feedIds: [r.active[0]] }),
    ];
    await labelArticle(r.id, x.id, [L1, L2]);
    await labelArticle(r.id, y.id, [L2], [L1]);
    await labelArticle(r.id, z.id, [], [L2, L1]);
    await labelArticle(r.id, w.id, [L3]);
    const before = await articleLabels(r.id);

    // Sports → News with another colour: the target is held differently; nothing changes.
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          updateUserLabel(tx, { labelId: L3, name: 'News', definition: newsDefinition }),
        ),
      ),
    ).toEqual({ code: 'CONFLICT', details: { reason: 'target_held', labelId: L1 } });
    expect(await articleLabels(r.id)).toEqual(before);
    await takeOutbox(ctx, r.id);

    const merged = await asUser(ctx, r.id, (tx) =>
      updateUserLabel(tx, { labelId: L2, name: 'News', definition: newsDefinition }),
    );
    expect(merged).toMatchObject({
      idChange: { from: L2, to: L1 },
      label: { id: L1, name: 'News' },
    });
    // Already materialized and backfilled for the kept label: no backfill.
    expect(merged.effects).toEqual({
      refreshFeedIds: numeric(r.active),
      rankFull: true,
      learn: false,
      labelIdChange: { from: L2, to: L1 },
    });
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { learn: false, reason: 'labels' }),
    );
    expect(await articleLabels(r.id)).toEqual({
      [x.id]: { ids: [L1], suggestions: [], version: bump(before[x.id]) },
      [y.id]: { ids: [L1], suggestions: [], version: bump(before[y.id]) },
      [z.id]: { ids: [], suggestions: [L1], version: before[z.id]?.version },
      [w.id]: before[w.id],
    });
    expect(await labelHoldings(r.id)).toEqual([`${L1}:News:#000000`, `${L3}:Sports:#111111`]);
  });
});

// ── Delete ────────────────────────────────────────────────────────────────────────────────────────

describe('delete a label', () => {
  it('removes the label from the user’s articles and deletes only the holding', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const definition = uniqueText('Satire');
    const L = (await newLabel(a.id, { name: 'Satire', definition })).label.id;
    const M = (await newLabel(a.id, { name: 'Kept' })).label.id;
    expect((await newLabel(b.id, { name: 'Satire', definition })).label.id).toBe(L);
    const [x, y] = [
      await createArticle(ctx.owner, { feedIds: [a.active[0]] }),
      await createArticle(ctx.owner, { feedIds: [a.active[0]] }),
    ];
    await labelArticle(a.id, x.id, [L, M]);
    await labelArticle(a.id, y.id, [M], [L]);
    await labelArticle(b.id, x.id, [L]);
    const [beforeA, beforeB] = [await articleLabels(a.id), await articleLabels(b.id)];
    await takeOutbox(ctx, a.id);

    const removed = await asUser(ctx, a.id, (tx) => deleteUserLabel(tx, { labelId: L }));
    expect(removed.effects).toEqual({
      refreshFeedIds: numeric(a.active),
      rankFull: true,
      learn: false,
    });
    expect(await takeOutbox(ctx, a.id)).toEqual(
      cardIntents(a.id, { learn: false, reason: 'labels' }),
    );
    expect(await articleLabels(a.id)).toEqual({
      [x.id]: { ids: [M], suggestions: [], version: bump(beforeA[x.id]) },
      [y.id]: { ids: [M], suggestions: [], version: beforeA[y.id]?.version },
    });
    expect(await articleLabels(b.id)).toEqual(beforeB);
    expect(await labelHoldings(a.id)).toEqual([`${M}:Kept:#64748b`]);
    expect(await storedCard(ctx, L)).toMatchObject({ kind: 'label', retired_at: null });
    expect(await feedCards(ctx, a.active)).toEqual(
      numeric(a.active).map((feedId) => `${feedId}:${M}:1`),
    );
    expect(
      await appErrorOf(asUser(ctx, a.id, (tx) => deleteUserLabel(tx, { labelId: L }))),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'label' } });
  });
});

// ── Quotas, privacy, un-retire ────────────────────────────────────────────────────────────────────

describe('label quotas, privacy and reuse', () => {
  it('maxLabels counts every held label; label forks never count toward maxForks', async () => {
    const r = await createReader(ctx);
    for (let i = 0; i < 19; i += 1) {
      const id = await insertCard(ctx, {
        kind: 'label',
        visibility: 'shared',
        title: `Filler ${i}`,
        interest: uniqueText('Filler label'),
      });
      await ctx.owner.query(
        'INSERT INTO user_labels (user_id, card_id, name) VALUES ($1, $2, $3)',
        [r.id, id, `Filler ${i}`],
      );
    }
    // Twenty interest forks: the fork quota is full.
    for (let i = 0; i < 20; i += 1) {
      const id = await insertCard(ctx, {
        visibility: 'private',
        ownerUserId: r.id,
        interest: uniqueText('Fork filler'),
        examplesYes: ['A filler example'],
      });
      await ctx.owner.query(
        "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
        [r.id, id],
      );
    }
    const twentieth = await newLabel(r.id, { name: 'Twentieth' });
    expect(twentieth.created).toBe(true);
    const quota = { code: 'QUOTA_EXCEEDED', details: { limit: 'maxLabels', used: 20, max: 20 } };
    expect(await appErrorOf(newLabel(r.id, { name: 'One too many' }))).toEqual(quota);

    // A label fork re-points the same holding and is outside maxForks.
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Label example',
    });
    const fork = await asUser(ctx, r.id, (tx) =>
      addLabelExample(tx, { labelId: twentieth.label.id, articleId: article.id, side: 'yes' }),
    );
    expect(fork.label.isPrivateFork).toBe(true);
    const renamed = await asUser(ctx, r.id, (tx) =>
      updateUserLabel(tx, { labelId: fork.label.id, name: 'Renamed at quota' }),
    );
    expect(renamed.label.isPrivateFork).toBe(true);
    const interestCard = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Interest at fork quota'), strength: 'like' }),
    );
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          addCardExample(tx, { cardId: interestCard.card.id, articleId: article.id, side: 'yes' }),
        ),
      ),
    ).toEqual({ code: 'QUOTA_EXCEEDED', details: { limit: 'maxForks', used: 20, max: 20 } });

    await ctx.owner.query("UPDATE users SET plan = 'admin' WHERE id = $1", [r.id]);
    expect((await newLabel(r.id, { name: 'One too many' })).created).toBe(true);
  });

  it('never shows a label fork to another user; cross-tenant and wrong-kind ids are 404', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.active[0], mode: 'active' });
    const definition = uniqueText('Investigations');
    const article = await createArticle(ctx.owner, {
      feedIds: [a.active[0]],
      title: 'Leaked files',
    });
    const labelA = await newLabel(a.id, { name: 'Investigation', definition });
    const forkA = await asUser(ctx, a.id, (tx) =>
      addLabelExample(tx, { labelId: labelA.label.id, articleId: article.id, side: 'yes' }),
    );
    const labelB = await newLabel(b.id, { name: 'Investigation', definition });
    const forkB = await asUser(ctx, b.id, (tx) =>
      addLabelExample(tx, { labelId: labelB.label.id, articleId: article.id, side: 'yes' }),
    );
    // Same label and example: the owner is part of a fork's hash, so each user has their own.
    expect(labelB.label.id).toBe(labelA.label.id);
    expect(forkB.label.id).not.toBe(forkA.label.id);

    const id = forkA.label.id;
    const attempts: Array<(tx: TenantTx) => Promise<unknown>> = [
      (tx) => updateUserLabel(tx, { labelId: id, name: 'Stolen' }),
      (tx) => setLabelColor(tx, { labelId: id, color: '#ffffff' }),
      (tx) => deleteUserLabel(tx, { labelId: id }),
      (tx) => addLabelExample(tx, { labelId: id, articleId: article.id, side: 'no' }),
      (tx) => removeLabelExample(tx, { labelId: id, side: 'yes', text: 'Leaked files' }),
    ];
    for (const attempt of attempts) {
      expect(await appErrorOf(asUser(ctx, b.id, attempt))).toEqual({
        code: 'NOT_FOUND',
        details: { resource: 'label' },
      });
    }
    await asUser(ctx, b.id, async (tx) => {
      expect(await getUserLabel(tx, id)).toBeNull();
      expect((await listUserLabels(tx)).map((l) => l.id)).toEqual([forkB.label.id]);
    });

    // Interest-card ids are not labels, and label ids are not interest cards.
    const card = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('An interest'), strength: 'like' }),
    );
    expect(
      await appErrorOf(
        asUser(ctx, a.id, (tx) => updateUserLabel(tx, { labelId: card.card.id, name: 'x y z' })),
      ),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'label' } });
    expect(
      await appErrorOf(asUser(ctx, a.id, (tx) => renameCard(tx, { cardId: id, title: 'x' }))),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
    expect(await labelHoldings(a.id)).toEqual([`${id}:Investigation:#64748b`]);
  });

  it('un-retires a retired label card when it is created again', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const definition = uniqueText('Retired label');
    const created = await newLabel(a.id, { name: 'Old label', definition });
    await asUser(ctx, a.id, (tx) => deleteUserLabel(tx, { labelId: created.label.id }));
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [
      created.label.id,
    ]);
    const again = await newLabel(b.id, { name: 'old LABEL', definition });
    expect(again.label.id).toBe(created.label.id);
    expect((await storedCard(ctx, created.label.id)).retired_at).toBeNull();
    expect(await feedCards(ctx, b.active)).toEqual(
      numeric(b.active).map((feedId) => `${feedId}:${created.label.id}:1`),
    );
  });
});

function bump(labels: ArticleLabels | undefined): string {
  return String(BigInt(labels?.version ?? '-1') + 1n);
}
