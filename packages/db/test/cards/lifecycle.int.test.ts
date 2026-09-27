import { cardTextHash } from '@bantoozi/shared/server';
import { createArticle, createFeed, createSubscription, createUser } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCardExample,
  adoptLibraryCard,
  createCardFromArticle,
  createUserCard,
  deleteUserCard,
  editCardText,
  getUserCard,
  listUserCards,
  removeCardExample,
  renameCard,
  setCardScope,
  setCardStrength,
  updateUserCard,
  type CreateUserCardInput,
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
  holdings,
  insertCard,
  numeric,
  rankRevision,
  selectArticle,
  storedCard,
  takeOutbox,
} from './helpers.js';

/**
 * The interest-card rows of the spec 05 §5.1 lifecycle table, through the repository the API calls
 * (`bantoozi_app` in `withTenant`, RLS enforced): create, adopt, from-article, examples, edit, rename,
 * strength, scope and delete, with their effects, outbox intents, `feed_cards` refresh, quotas,
 * idempotent replays and conflicts, fork privacy, immutability and un-retirement. Labels, library
 * updates, transactions/concurrency and publication have their own files.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let sequence = 0;
/** A unique interest per call, so tests never share card rows by accident. */
function uniqueText(label: string): string {
  sequence += 1;
  return `${label} topic number ${sequence}`;
}

const NO_EFFECTS = { refreshFeedIds: [], rankFull: false, learn: false };

// ── Create ────────────────────────────────────────────────────────────────────────────────────────

describe('create (spec 05 §5.1)', () => {
  it('inserts a shared user card and holds it: refresh, admitted-demand backfill, rank full, learn', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Rust programming language releases');
    const revision = BigInt(await rankRevision(ctx, r.id));
    const result = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { title: 'Rust', interest, notFor: ' Rust the game ', strength: 'love' }),
    );
    const id = result.card.id;
    expect(result.created).toBe(true);
    expect(result.idChange).toBeNull();
    expect(result.card).toMatchObject({
      kind: 'interest',
      title: 'Rust',
      titleOverride: null,
      cardTitle: 'Rust',
      interest,
      notFor: 'Rust the game',
      interestEn: null,
      notForEn: null,
      strength: 'love',
      scopeFeedId: null,
      origin: 'user',
      visibility: 'shared',
      isPrivateFork: false,
      parentCardId: null,
      examplesYes: [],
      examplesNo: [],
      topicIds: [],
      lang: 'und',
      librarySlug: null,
    });
    expect(await storedCard(ctx, id)).toMatchObject({
      kind: 'interest',
      title: 'Rust',
      origin: 'user',
      visibility: 'shared',
      owner_user_id: null,
      creator_user_id: r.id,
      parent_card_id: null,
      retired_at: null,
      text_hash: cardTextHash({
        kind: 'interest',
        title: 'Rust',
        interest,
        not_for: 'Rust the game',
        visibility: 'shared',
      }),
      body: {
        interest,
        not_for: 'Rust the game',
        interest_en: null,
        not_for_en: null,
        examples_yes: [],
        examples_no: [],
      },
    });

    const active = numeric(r.active);
    expect(result.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [id], feedIds: active },
      rankFull: true,
      learn: true,
    });
    // Only active subscriptions are materialized; training/off feeds get nothing.
    expect(await feedCards(ctx, [...r.active, r.training, r.off])).toEqual(
      active.map((feedId) => `${feedId}:${id}:1`),
    );
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { backfill: { cardIds: [id], feedIds: active } }),
    );
    expect(BigInt(await rankRevision(ctx, r.id))).toBe(revision + 1n);
    expect(await holdings(ctx, r.id)).toEqual([`${id}:love:*:-`]);
  });

  it('reuses a public or shared card by normalized text hash and never transfers authorship', async () => {
    const [a, b, c] = [await createReader(ctx), await createReader(ctx), await createReader(ctx)];
    const interest = uniqueText('Hiking routes in the High Tatras');
    const first = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { title: 'Tatras', interest, strength: 'like' }),
    );
    const shouted = `  ${interest.toUpperCase().replaceAll(' ', '  \t ')} `;
    const second = await asUser(ctx, b.id, (tx) =>
      createUserCard(tx, { title: 'Hiking', interest: shouted, notFor: '  ', strength: 'must' }),
    );
    expect(second.card.id).toBe(first.card.id);
    expect(second.created).toBe(true);
    // The holder's own title is an override; the shared row keeps the creator's text and title.
    expect(second.card).toMatchObject({
      title: 'Hiking',
      titleOverride: 'Hiking',
      cardTitle: 'Tatras',
      interest,
      strength: 'must',
    });
    const third = await asUser(ctx, c.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like' }),
    );
    expect(third.card).toMatchObject({ id: first.card.id, title: 'Tatras', titleOverride: null });
    expect(await storedCard(ctx, first.card.id)).toMatchObject({
      creator_user_id: a.id,
      title: 'Tatras',
      body: { interest },
    });
    const { rows } = await ctx.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM interest_cards WHERE lower(body->>'interest') = lower($1)`,
      [interest],
    );
    expect(rows[0]?.n).toBe(1);

    // A public library card with the same text is reused as it is.
    const libraryText = uniqueText('Rocket launches and spacecraft missions');
    const library = await insertCard(ctx, {
      visibility: 'public',
      title: 'Space launches',
      interest: libraryText,
    });
    const reused = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest: libraryText.toLowerCase(), strength: 'like' }),
    );
    expect(reused.card).toMatchObject({
      id: library,
      origin: 'library',
      visibility: 'public',
      title: 'Space launches',
    });
    expect((await storedCard(ctx, library)).creator_user_id).toBeNull();
  });

  it('backfills admitted demand only: a selected training feed, never an off or unselected feed', async () => {
    const r = await createReader(ctx);
    const selected = await createArticle(ctx.owner, { feedIds: [r.training] });
    await selectArticle(ctx, { userId: r.id, feedId: r.training, articleId: selected.id });
    const all = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Home automation'), strength: 'like' }),
    );
    expect(all.effects).toEqual({
      refreshFeedIds: numeric(r.active),
      backfill: { cardIds: [all.card.id], feedIds: numeric([...r.active, r.training]) },
      rankFull: true,
      learn: true,
    });
    await takeOutbox(ctx, r.id);

    const off = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, {
        interest: uniqueText('Quiet feed topic'),
        strength: 'like',
        scopeFeedId: r.off,
      }),
    );
    expect(off.effects).toEqual({ refreshFeedIds: [], rankFull: true, learn: true });
    expect(await takeOutbox(ctx, r.id)).toEqual(cardIntents(r.id, {}));
    expect(await feedCards(ctx, [r.off, r.training])).toEqual([]);
  });

  it('replays an identical holding idempotently and rejects different settings as a conflict', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Slovak domestic politics');
    const input: CreateUserCardInput = {
      title: 'SK politics',
      interest,
      strength: 'like',
      scopeFeedId: r.active[0],
    };
    const first = await asUser(ctx, r.id, (tx) => createUserCard(tx, input));
    await takeOutbox(ctx, r.id);
    const revision = await rankRevision(ctx, r.id);

    const replay = await asUser(ctx, r.id, (tx) => createUserCard(tx, input));
    expect(replay).toEqual({
      card: first.card,
      idChange: null,
      created: false,
      effects: NO_EFFECTS,
    });
    // Without a title the holder's name is not compared.
    const untitled = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like', scopeFeedId: r.active[0] }),
    );
    expect(untitled.created).toBe(false);

    const changes: Array<Partial<CreateUserCardInput>> = [
      { strength: 'love' },
      { scopeFeedId: r.active[1] },
      { scopeFeedId: null },
      { title: 'Politics' },
    ];
    for (const change of changes) {
      expect(
        await appErrorOf(asUser(ctx, r.id, (tx) => createUserCard(tx, { ...input, ...change }))),
        JSON.stringify(change),
      ).toEqual({ code: 'CONFLICT', details: { reason: 'already_held', cardId: first.card.id } });
    }
    expect(await holdings(ctx, r.id)).toEqual([`${first.card.id}:like:${r.active[0]}:-`]);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
    expect(await rankRevision(ctx, r.id)).toBe(revision);
  });

  it('validates text, strength, scope and translation before writing anything', async () => {
    const r = await createReader(ctx);
    const elsewhere = await createFeed(ctx.owner);
    const base = { interest: uniqueText('Valid interest'), strength: 'like' };
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ interest: 'ab' }, 'interest', 'too_short'],
      [{ interest: '   ' }, 'interest', 'required'],
      [{ interest: 'x'.repeat(301) }, 'interest', 'too_long'],
      [{ interest: 'broken \u0000 text' }, 'interest', 'characters'],
      [{ title: '' }, 'title', 'required'],
      [{ title: 'x'.repeat(61) }, 'title', 'too_long'],
      [{ notFor: 'x'.repeat(301) }, 'notFor', 'too_long'],
      [{ strength: 'meh' }, 'strength', 'enum'],
      [{ scopeFeedId: elsewhere.id }, 'scopeFeedId', 'not_subscribed'],
      [{ scopeFeedId: '0' }, 'scopeFeedId', 'id'],
      [{ lang: 'english' }, 'lang', 'language'],
      [{ translation: { interestEn: 'Valid', notForEn: null } }, 'translation', 'language'],
      [
        { lang: 'sk', notFor: 'nie', translation: { interestEn: 'Valid', notForEn: null } },
        'translation.notForEn',
        'type',
      ],
      [
        { lang: 'sk', translation: { interestEn: 'Valid', notForEn: 'extra' } },
        'translation.notForEn',
        'unexpected',
      ],
      [
        { lang: 'sk', translation: { interestEn: ' ', notForEn: null } },
        'translation.interestEn',
        'required',
      ],
    ];
    for (const [override, field, reason] of cases) {
      const input = { ...base, ...override } as unknown as CreateUserCardInput;
      expect(
        await appErrorOf(asUser(ctx, r.id, (tx) => createUserCard(tx, input))),
        JSON.stringify(override).slice(0, 60),
      ).toEqual({ code: 'VALIDATION_FAILED', details: { field, reason } });
    }
    // Sixty emoji are sixty characters: lengths count code points.
    const emoji = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { ...base, strength: 'like', title: '🚀'.repeat(60) }),
    );
    expect(emoji.card.title).toBe('🚀'.repeat(60));
    expect(await holdings(ctx, r.id)).toEqual([`${emoji.card.id}:like:*:-`]);
  });
});

// ── Adopt ─────────────────────────────────────────────────────────────────────────────────────────

describe('adopt a library card', () => {
  it('holds a public library card with the create effects; other ids are 404', async () => {
    const r = await createReader(ctx);
    const library = await insertCard(ctx, {
      visibility: 'public',
      title: 'LLM research',
      interest: uniqueText('Large language model research'),
    });
    const adopted = await asUser(ctx, r.id, (tx) =>
      adoptLibraryCard(tx, { cardId: library, strength: 'must' }),
    );
    expect(adopted).toMatchObject({
      created: true,
      idChange: null,
      card: {
        id: library,
        origin: 'library',
        visibility: 'public',
        strength: 'must',
        title: 'LLM research',
        titleOverride: null,
      },
    });
    const active = numeric(r.active);
    expect(adopted.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [library], feedIds: active },
      rankFull: true,
      learn: true,
    });
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { backfill: { cardIds: [library], feedIds: active } }),
    );
    const replay = await asUser(ctx, r.id, (tx) =>
      adoptLibraryCard(tx, { cardId: library, strength: 'must' }),
    );
    expect(replay).toMatchObject({ created: false, effects: NO_EFFECTS });
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => adoptLibraryCard(tx, { cardId: library, strength: 'like' })),
      ),
    ).toEqual({ code: 'CONFLICT', details: { reason: 'already_held', cardId: library } });

    const other = await createUser(ctx.owner);
    const refused = [
      await insertCard(ctx, {
        visibility: 'shared',
        interest: uniqueText('Shared text'),
        creatorUserId: other.id,
      }),
      await insertCard(ctx, {
        visibility: 'private',
        interest: uniqueText('Private text'),
        ownerUserId: other.id,
        examplesYes: ['An example'],
      }),
      await insertCard(ctx, {
        kind: 'label',
        visibility: 'public',
        title: 'Longreads',
        interest: uniqueText('Long reads'),
      }),
      '999999999',
    ];
    for (const cardId of refused) {
      expect(
        await appErrorOf(
          asUser(ctx, r.id, (tx) => adoptLibraryCard(tx, { cardId, strength: 'like' })),
        ),
        cardId,
      ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
    }
    expect(await holdings(ctx, r.id)).toEqual([`${library}:must:*:-`]);
  });

  it('adopts only the current version of a library entry', async () => {
    const r = await createReader(ctx);
    const slug = `adopt-entry-${sequence}`;
    const v1 = await insertCard(ctx, { visibility: 'public', interest: uniqueText('Version one') });
    const v2 = await insertCard(ctx, {
      visibility: 'public',
      interest: uniqueText('Version two'),
      slug,
    });
    await ctx.owner.query(
      `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
       VALUES ($1, 1, $2, NULL)`,
      [slug, v1],
    );
    await ctx.owner.query(
      `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
       VALUES ($1, 2, $2, $3)`,
      [slug, v2, v1],
    );
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => adoptLibraryCard(tx, { cardId: v1, strength: 'like' })),
      ),
    ).toEqual({
      code: 'CONFLICT',
      details: { reason: 'superseded', cardId: v1, currentCardId: v2 },
    });
    const current = await asUser(ctx, r.id, (tx) =>
      adoptLibraryCard(tx, { cardId: v2, strength: 'like' }),
    );
    expect(current.card).toMatchObject({ id: v2, librarySlug: slug });
  });
});

// ── From an article ───────────────────────────────────────────────────────────────────────────────

describe('make a card from an article', () => {
  it('creates the shared text-only card and holds a private fork with the article title', async () => {
    const r = await createReader(ctx);
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: "  Toyota's   solid-state pilot line\nhits 1,000 cycles ",
    });
    const example = "Toyota's solid-state pilot line hits 1,000 cycles";
    const interest = uniqueText('Solid-state EV batteries');
    const result = await asUser(ctx, r.id, (tx) =>
      createCardFromArticle(tx, {
        articleId: article.id,
        interest,
        notFor: 'Stock moves',
        title: 'EV batteries',
        strength: 'love',
      }),
    );
    const sharedHash = cardTextHash({
      kind: 'interest',
      title: 'EV batteries',
      interest,
      not_for: 'Stock moves',
      visibility: 'shared',
    });
    const { rows } = await ctx.owner.query<{ id: string }>(
      'SELECT id::text AS id FROM interest_cards WHERE text_hash = $1',
      [sharedHash],
    );
    const sharedId = rows[0]?.id ?? 'missing';
    expect(await storedCard(ctx, sharedId)).toMatchObject({
      origin: 'user',
      visibility: 'shared',
      owner_user_id: null,
      creator_user_id: r.id,
      title: 'EV batteries',
      body: { interest, not_for: 'Stock moves', examples_yes: [], examples_no: [] },
    });
    expect(await storedCard(ctx, result.card.id)).toMatchObject({
      origin: 'fork',
      visibility: 'private',
      owner_user_id: r.id,
      creator_user_id: r.id,
      parent_card_id: sharedId,
      title: 'EV batteries',
      text_hash: cardTextHash({
        kind: 'interest',
        title: 'EV batteries',
        interest,
        not_for: 'Stock moves',
        examples_yes: [example],
        visibility: 'private',
        owner_user_id: r.id,
      }),
      body: {
        interest,
        not_for: 'Stock moves',
        interest_en: null,
        not_for_en: null,
        examples_yes: [example],
        examples_no: [],
      },
    });
    expect(result).toMatchObject({
      created: true,
      idChange: null,
      card: {
        isPrivateFork: true,
        origin: 'fork',
        parentCardId: sharedId,
        examplesYes: [example],
        title: 'EV batteries',
        titleOverride: null,
        strength: 'love',
      },
    });
    // The user holds the fork only.
    expect(await holdings(ctx, r.id)).toEqual([`${result.card.id}:love:*:-`]);
    const active = numeric(r.active);
    expect(result.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [result.card.id], feedIds: active },
      rankFull: true,
      learn: true,
    });
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { backfill: { cardIds: [result.card.id], feedIds: active } }),
    );
  });

  it("uses only articles the reader can see: a subscribed carrier or the reader's own list", async () => {
    const r = await createReader(ctx);
    const elsewhere = await createFeed(ctx.owner);
    const hidden = await createArticle(ctx.owner, {
      feedIds: [elsewhere.id],
      title: 'Hidden headline',
    });
    for (const articleId of [hidden.id, '999999999']) {
      expect(
        await appErrorOf(
          asUser(ctx, r.id, (tx) =>
            createCardFromArticle(tx, { articleId, interest: uniqueText('Any'), strength: 'like' }),
          ),
        ),
      ).toEqual({ code: 'NOT_FOUND', details: { resource: 'article' } });
    }
    expect(await holdings(ctx, r.id)).toEqual([]);
    await ctx.owner.query('INSERT INTO user_article (user_id, article_id) VALUES ($1, $2)', [
      r.id,
      hidden.id,
    ]);
    const listed = await asUser(ctx, r.id, (tx) =>
      createCardFromArticle(tx, {
        articleId: hidden.id,
        interest: uniqueText('Reading list'),
        strength: 'like',
      }),
    );
    expect(listed.card.examplesYes).toEqual(['Hidden headline']);
  });
});

// ── Examples ──────────────────────────────────────────────────────────────────────────────────────

describe('add or remove an example', () => {
  it('forks privately and re-points the holding, keeping strength, scope and title override', async () => {
    const a = await createReader(ctx);
    const b = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.active[0], mode: 'active' });
    const interest = uniqueText('Space launches');
    const shared = await asUser(ctx, b.id, (tx) =>
      createUserCard(tx, { title: 'Space', interest, strength: 'like' }),
    );
    const sharedId = shared.card.id;
    await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { title: 'Mine', interest, strength: 'love', scopeFeedId: a.active[0] }),
    );
    const article = await createArticle(ctx.owner, {
      feedIds: [a.active[0]],
      title: 'Falcon 9 lands for the 300th time',
    });
    await takeOutbox(ctx, a.id);

    const result = await asUser(ctx, a.id, (tx) =>
      addCardExample(tx, { cardId: sharedId, articleId: article.id, side: 'yes' }),
    );
    const forkId = result.card.id;
    expect(forkId).not.toBe(sharedId);
    expect(result.idChange).toEqual({ from: sharedId, to: forkId });
    expect(result.card).toMatchObject({
      isPrivateFork: true,
      parentCardId: sharedId,
      examplesYes: ['Falcon 9 lands for the 300th time'],
      examplesNo: [],
      strength: 'love',
      scopeFeedId: a.active[0],
      title: 'Mine',
      titleOverride: 'Mine',
      cardTitle: 'Space',
    });
    expect(await holdings(ctx, a.id)).toEqual([`${forkId}:love:${a.active[0]}:Mine`]);
    // The other holder and the shared row are untouched.
    expect(await holdings(ctx, b.id)).toEqual([`${sharedId}:like:*:-`]);
    expect((await storedCard(ctx, sharedId)).body['examples_yes']).toEqual([]);
    expect(result.effects).toEqual({
      refreshFeedIds: [a.active[0]],
      backfill: { cardIds: [forkId], feedIds: [a.active[0]] },
      rankFull: true,
      learn: true,
    });
    expect(await feedCards(ctx, [a.active[0]])).toEqual([
      `${a.active[0]}:${sharedId}:1`,
      `${a.active[0]}:${forkId}:1`,
    ]);
    expect(await takeOutbox(ctx, a.id)).toEqual(
      cardIntents(a.id, { backfill: { cardIds: [forkId], feedIds: [a.active[0]] } }),
    );
  });

  it('keeps the newest five examples per side, moves one across sides and ignores a repeat', async () => {
    const r = await createReader(ctx);
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Formula one'), strength: 'like' }),
    );
    const titles = ['one', 'two', 'three', 'four', 'five', 'six'].map((n) => `Race report ${n}`);
    const articles = [];
    for (const title of titles) {
      articles.push(await createArticle(ctx.owner, { feedIds: [r.active[1]], title }));
    }
    let cardId = created.card.id;
    for (const article of articles) {
      const added = await asUser(ctx, r.id, (tx) =>
        addCardExample(tx, { cardId, articleId: article.id, side: 'yes' }),
      );
      cardId = added.card.id;
    }
    const card = await asUser(ctx, r.id, (tx) => getUserCard(tx, cardId));
    expect(card?.examplesYes).toEqual(titles.slice(1));

    const last = articles[5]?.id ?? 'missing';
    const moved = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId, articleId: last, side: 'no' }),
    );
    expect(moved.card.examplesYes).toEqual(titles.slice(1, 5));
    expect(moved.card.examplesNo).toEqual([titles[5]]);
    await takeOutbox(ctx, r.id);

    const repeat = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: moved.card.id, articleId: last, side: 'no' }),
    );
    expect(repeat).toMatchObject({
      card: { id: moved.card.id },
      idChange: null,
      effects: NO_EFFECTS,
    });
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
    expect(await holdings(ctx, r.id)).toEqual([`${moved.card.id}:like:*:-`]);
  });

  it('removes examples into another fork and returns to the text-only card after the last one', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Czech startups');
    const s = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { title: 'CZ', interest, strength: 'must', scopeFeedId: r.active[1] }),
    );
    const a1 = await createArticle(ctx.owner, {
      feedIds: [r.active[1]],
      title: 'Prague fintech raises seed round',
    });
    const a2 = await createArticle(ctx.owner, {
      feedIds: [r.active[1]],
      title: 'Brno robotics startup expands',
    });
    const f1 = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: s.card.id, articleId: a1.id, side: 'yes' }),
    );
    const f2 = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: f1.card.id, articleId: a2.id, side: 'no' }),
    );
    expect(f2.card.parentCardId).toBe(s.card.id); // a fork of a fork keeps the original parent

    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          removeCardExample(tx, { cardId: f2.card.id, side: 'yes', text: 'Not an example' }),
        ),
      ),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'example' } });

    // Matched by norm (case and spacing).
    const f3 = await asUser(ctx, r.id, (tx) =>
      removeCardExample(tx, {
        cardId: f2.card.id,
        side: 'yes',
        text: 'prague  FINTECH raises seed round',
      }),
    );
    expect(f3.card).toMatchObject({
      isPrivateFork: true,
      parentCardId: s.card.id,
      examplesYes: [],
      examplesNo: ['Brno robotics startup expands'],
    });
    expect(f3.idChange).toEqual({ from: f2.card.id, to: f3.card.id });

    const back = await asUser(ctx, r.id, (tx) =>
      removeCardExample(tx, {
        cardId: f3.card.id,
        side: 'no',
        text: 'Brno robotics startup expands',
      }),
    );
    expect(back.card).toMatchObject({
      id: s.card.id,
      isPrivateFork: false,
      strength: 'must',
      scopeFeedId: r.active[1],
      title: 'CZ',
    });
    expect(back.idChange).toEqual({ from: f3.card.id, to: s.card.id });
    expect(back.effects).toEqual({
      refreshFeedIds: [r.active[1]],
      backfill: { cardIds: [s.card.id], feedIds: [r.active[1]] },
      rankFull: true,
      learn: true,
    });

    // The same body again reuses the same fork row.
    const again = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: s.card.id, articleId: a1.id, side: 'yes' }),
    );
    expect(again.card.id).toBe(f1.card.id);
    // An old id the user no longer holds is 404 and never creates a holding.
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          removeCardExample(tx, {
            cardId: f2.card.id,
            side: 'no',
            text: 'Brno robotics startup expands',
          }),
        ),
      ),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
    expect(await holdings(ctx, r.id)).toEqual([`${f1.card.id}:must:${r.active[1]}:-`]);
  });

  it("forks a library card's own examples privately and keeps its library lineage", async () => {
    const r = await createReader(ctx);
    const library = await insertCard(ctx, {
      visibility: 'public',
      title: 'Rust',
      interest: uniqueText('The Rust language'),
      examplesYes: ['Rust 1.80 released'],
      examplesNo: ['Rust the game gets an update'],
    });
    await asUser(ctx, r.id, (tx) => adoptLibraryCard(tx, { cardId: library, strength: 'like' }));
    const removed = await asUser(ctx, r.id, (tx) =>
      removeCardExample(tx, {
        cardId: library,
        side: 'no',
        text: 'Rust the game gets an update',
      }),
    );
    expect(removed.card).toMatchObject({
      isPrivateFork: true,
      parentCardId: library,
      examplesYes: ['Rust 1.80 released'],
      examplesNo: [],
    });
    const emptied = await asUser(ctx, r.id, (tx) =>
      removeCardExample(tx, { cardId: removed.card.id, side: 'yes', text: 'Rust 1.80 released' }),
    );
    // The original has examples of its own, so the user keeps an (empty) private fork of it.
    expect(emptied.card).toMatchObject({
      isPrivateFork: true,
      parentCardId: library,
      examplesYes: [],
      examplesNo: [],
    });
  });
});

// ── Edit text ─────────────────────────────────────────────────────────────────────────────────────

describe('edit text', () => {
  let matchSha = '';

  beforeAll(async () => {
    matchSha = 'c'.repeat(64);
    await ctx.owner.query(
      `INSERT INTO question_sets (kind, version, sha256, definition)
       VALUES ('match', 'match-cards-test', $1, '{}')`,
      [matchSha],
    );
  });

  const answerCount = async (cardId: string) =>
    (
      await ctx.owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM card_answers WHERE card_id = $1',
        [cardId],
      )
    ).rows[0]?.n;

  it('re-points to the card of the new text; the old card keeps its other holders and answers', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const interest = uniqueText('Personal finance in the EU');
    const s = await asUser(ctx, a.id, (tx) => createUserCard(tx, { interest, strength: 'like' }));
    await asUser(ctx, b.id, (tx) => createUserCard(tx, { interest, strength: 'love' }));
    const article = await createArticle(ctx.owner, { feedIds: [a.active[0]] });
    await ctx.owner.query(
      `INSERT INTO card_answers (article_id, card_id, p, engine, question_set_sha, article_revision,
                                 state_sha256, card_input_sha256, state_variant)
       VALUES ($1, $2, 0.9, 'typesafe', $3, 1, 's', 'c', 'native')`,
      [article.id, s.card.id, matchSha],
    );
    await takeOutbox(ctx, a.id);

    const newInterest = uniqueText('Saving and investing');
    const edited = await asUser(ctx, a.id, (tx) =>
      editCardText(tx, { cardId: s.card.id, interest: newInterest, notFor: 'Corporate earnings' }),
    );
    expect(edited.idChange).toEqual({ from: s.card.id, to: edited.card.id });
    expect(edited.card).toMatchObject({
      interest: newInterest,
      notFor: 'Corporate earnings',
      strength: 'like',
      scopeFeedId: null,
      origin: 'user',
      visibility: 'shared',
      title: newInterest,
      titleOverride: null,
    });
    expect(await storedCard(ctx, edited.card.id)).toMatchObject({
      creator_user_id: a.id,
      title: newInterest,
    });
    expect(await holdings(ctx, a.id)).toEqual([`${edited.card.id}:like:*:-`]);
    expect(await holdings(ctx, b.id)).toEqual([`${s.card.id}:love:*:-`]);
    expect((await storedCard(ctx, s.card.id)).body['interest']).toBe(interest);
    expect(await answerCount(s.card.id)).toBe(1);
    const active = numeric(a.active);
    expect(edited.effects).toEqual({
      refreshFeedIds: active,
      backfill: { cardIds: [edited.card.id], feedIds: active },
      rankFull: true,
      learn: true,
    });
    expect(await takeOutbox(ctx, a.id)).toEqual(
      cardIntents(a.id, { backfill: { cardIds: [edited.card.id], feedIds: active } }),
    );
  });

  it("keeps the holder's own name and carries the user's examples into a fork of the new text", async () => {
    const r = await createReader(ctx);
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Slovan wins the derby',
    });
    const fork = await asUser(ctx, r.id, (tx) =>
      createCardFromArticle(tx, {
        articleId: article.id,
        interest: uniqueText('Slovak football league'),
        strength: 'like',
      }),
    );
    await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId: fork.card.id, title: 'Football' }));
    const edited = await asUser(ctx, r.id, (tx) =>
      updateUserCard(tx, { cardId: fork.card.id, notFor: 'Transfer rumours', strength: 'love' }),
    );
    expect(edited.idChange).toEqual({ from: fork.card.id, to: edited.card.id });
    expect(edited.card).toMatchObject({
      isPrivateFork: true,
      examplesYes: ['Slovan wins the derby'],
      notFor: 'Transfer rumours',
      title: 'Football',
      strength: 'love',
    });
    const parent = await storedCard(ctx, edited.card.parentCardId ?? 'missing');
    expect(parent).toMatchObject({
      visibility: 'shared',
      creator_user_id: r.id,
      title: 'Football',
      body: { not_for: 'Transfer rumours', examples_yes: [] },
    });
  });

  it('coalesces with an identical holding of the resulting card and conflicts on different settings', async () => {
    const r = await createReader(ctx);
    const one = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Topic one'), strength: 'like' }),
    );
    const twoText = uniqueText('Topic two');
    const two = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: twoText, strength: 'like' }),
    );
    await takeOutbox(ctx, r.id);
    const merged = await asUser(ctx, r.id, (tx) =>
      editCardText(tx, { cardId: one.card.id, interest: twoText.toUpperCase() }),
    );
    expect(merged.card.id).toBe(two.card.id);
    expect(merged.idChange).toEqual({ from: one.card.id, to: two.card.id });
    // Already held with these settings: nothing new to backfill.
    expect(merged.effects).toEqual({
      refreshFeedIds: numeric(r.active),
      rankFull: true,
      learn: true,
    });
    expect(await holdings(ctx, r.id)).toEqual([`${two.card.id}:like:*:-`]);
    await takeOutbox(ctx, r.id);

    const three = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Topic three'), strength: 'love' }),
    );
    await takeOutbox(ctx, r.id);
    const before = await holdings(ctx, r.id);
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => editCardText(tx, { cardId: three.card.id, interest: twoText })),
      ),
    ).toEqual({ code: 'CONFLICT', details: { reason: 'target_held', cardId: two.card.id } });
    expect(await holdings(ctx, r.id)).toEqual(before);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
  });

  it('treats a change of case or spacing as no text change', async () => {
    const r = await createReader(ctx);
    const interest = uniqueText('Home Assistant automations');
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like' }),
    );
    const same = await asUser(ctx, r.id, (tx) =>
      editCardText(tx, { cardId: created.card.id, interest: `  ${interest.toUpperCase()} ` }),
    );
    expect(same).toMatchObject({
      idChange: null,
      card: { id: created.card.id, interest },
      effects: NO_EFFECTS,
    });
    expect(
      await appErrorOf(asUser(ctx, r.id, (tx) => updateUserCard(tx, { cardId: created.card.id }))),
    ).toEqual({ code: 'VALIDATION_FAILED', details: { field: 'body', reason: 'empty' } });
  });
});

// ── Rename, strength, scope, delete ───────────────────────────────────────────────────────────────

describe('rename', () => {
  it('sets only title_override: no card change, no refresh, no rank and no model calls', async () => {
    const r = await createReader(ctx);
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, {
        title: 'Original',
        interest: uniqueText('Rename me'),
        strength: 'like',
      }),
    );
    const cardId = created.card.id;
    await takeOutbox(ctx, r.id);
    const revision = await rankRevision(ctx, r.id);
    const cachedFeeds = await feedCards(ctx, r.active);
    const identities = await cardIdentities(ctx);

    const renamed = await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId, title: '  Mine  ' }));
    expect(renamed.idChange).toBeNull();
    expect(renamed.effects).toEqual(NO_EFFECTS);
    expect(renamed.card).toMatchObject({
      id: cardId,
      title: 'Mine',
      titleOverride: 'Mine',
      cardTitle: 'Original',
    });
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
    expect(await rankRevision(ctx, r.id)).toBe(revision);
    expect(await feedCards(ctx, r.active)).toEqual(cachedFeeds);
    await expectCardsUnchanged(ctx, identities);
    expect((await storedCard(ctx, cardId)).title).toBe('Original');

    // The card's own title, or null, clears the override.
    const own = await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId, title: 'Original' }));
    expect(own.card).toMatchObject({ title: 'Original', titleOverride: null });
    await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId, title: 'Again' }));
    const cleared = await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId, title: null }));
    expect(cleared.card).toMatchObject({ title: 'Original', titleOverride: null });
  });
});

describe('change strength', () => {
  it('ranks fully and relearns without refresh, backfill or model calls', async () => {
    const r = await createReader(ctx);
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Crypto scams'), strength: 'like' }),
    );
    await takeOutbox(ctx, r.id);
    const revision = BigInt(await rankRevision(ctx, r.id));
    const cachedFeeds = await feedCards(ctx, r.active);
    const never = await asUser(ctx, r.id, (tx) =>
      setCardStrength(tx, { cardId: created.card.id, strength: 'never' }),
    );
    expect(never).toMatchObject({
      idChange: null,
      card: { id: created.card.id, strength: 'never' },
    });
    expect(never.effects).toEqual({ refreshFeedIds: [], rankFull: true, learn: true });
    expect(await takeOutbox(ctx, r.id)).toEqual(cardIntents(r.id, {}));
    expect(BigInt(await rankRevision(ctx, r.id))).toBe(revision + 1n);
    expect(await feedCards(ctx, r.active)).toEqual(cachedFeeds);

    const unchanged = await asUser(ctx, r.id, (tx) =>
      setCardStrength(tx, { cardId: created.card.id, strength: 'never' }),
    );
    expect(unchanged.effects).toEqual(NO_EFFECTS);
  });
});

describe('change scope', () => {
  it('validates the subscription, refreshes old and new feeds and backfills only newly included admitted feeds', async () => {
    const r = await createReader(ctx);
    const selected = await createArticle(ctx.owner, { feedIds: [r.training] });
    await selectArticle(ctx, { userId: r.id, feedId: r.training, articleId: selected.id });
    const [f1, f2] = numeric(r.active) as [string, string];
    const created = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Scoped topic'), strength: 'like' }),
    );
    const id = created.card.id;
    await takeOutbox(ctx, r.id);

    // All feeds → f1: nothing newly included.
    const narrowed = await asUser(ctx, r.id, (tx) =>
      setCardScope(tx, { cardId: id, scopeFeedId: f1 }),
    );
    expect(narrowed.card.scopeFeedId).toBe(f1);
    expect(narrowed.effects).toEqual({ refreshFeedIds: [f1, f2], rankFull: true, learn: true });
    expect(await feedCards(ctx, [f1, f2])).toEqual([`${f1}:${id}:1`]);
    expect(await takeOutbox(ctx, r.id)).toEqual(cardIntents(r.id, {}));

    // Feed A → feed B: backfill B only.
    const moved = await asUser(ctx, r.id, (tx) =>
      setCardScope(tx, { cardId: id, scopeFeedId: f2 }),
    );
    expect(moved.effects).toEqual({
      refreshFeedIds: [f1, f2],
      backfill: { cardIds: [id], feedIds: [f2] },
      rankFull: true,
      learn: true,
    });
    expect(await feedCards(ctx, [f1, f2])).toEqual([`${f2}:${id}:1`]);
    expect(await takeOutbox(ctx, r.id)).toEqual(
      cardIntents(r.id, { backfill: { cardIds: [id], feedIds: [f2] } }),
    );

    // A training feed with a current selection is admitted demand (not materialized).
    const training = await asUser(ctx, r.id, (tx) =>
      setCardScope(tx, { cardId: id, scopeFeedId: r.training }),
    );
    expect(training.effects).toEqual({
      refreshFeedIds: [f2],
      backfill: { cardIds: [id], feedIds: [r.training] },
      rankFull: true,
      learn: true,
    });

    // Back to all feeds: f1 and f2 are newly included and admitted; the off feed never is.
    const widened = await asUser(ctx, r.id, (tx) =>
      setCardScope(tx, { cardId: id, scopeFeedId: null }),
    );
    expect(widened.effects).toEqual({
      refreshFeedIds: [f1, f2],
      backfill: { cardIds: [id], feedIds: [f1, f2] },
      rankFull: true,
      learn: true,
    });

    const elsewhere = await createFeed(ctx.owner);
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => setCardScope(tx, { cardId: id, scopeFeedId: elsewhere.id })),
      ),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      details: { field: 'scopeFeedId', reason: 'not_subscribed' },
    });
    expect(await holdings(ctx, r.id)).toEqual([`${id}:like:*:-`]);
  });
});

describe('delete', () => {
  it('deletes only the holding: refresh, rank full and learn; the card row stays', async () => {
    const a = await createReader(ctx);
    const b = await createUser(ctx.owner);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.active[0], mode: 'active' });
    const interest = uniqueText('Deleted card');
    const created = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like' }),
    );
    await asUser(ctx, b.id, (tx) => createUserCard(tx, { interest, strength: 'love' }));
    const id = created.card.id;
    await takeOutbox(ctx, a.id);

    const removed = await asUser(ctx, a.id, (tx) => deleteUserCard(tx, { cardId: id }));
    expect(removed).toEqual({
      effects: { refreshFeedIds: numeric(a.active), rankFull: true, learn: true },
    });
    expect(await holdings(ctx, a.id)).toEqual([]);
    expect(await holdings(ctx, b.id)).toEqual([`${id}:love:*:-`]);
    expect((await storedCard(ctx, id)).retired_at).toBeNull();
    expect(await feedCards(ctx, a.active)).toEqual([`${a.active[0]}:${id}:1`]);
    expect(await takeOutbox(ctx, a.id)).toEqual(cardIntents(a.id, {}));
    expect(await appErrorOf(asUser(ctx, a.id, (tx) => deleteUserCard(tx, { cardId: id })))).toEqual(
      { code: 'NOT_FOUND', details: { resource: 'card' } },
    );
  });
});

// ── Privacy, quotas, immutability, retirement ─────────────────────────────────────────────────────

describe('fork privacy and tenancy', () => {
  it('never gives or shows a fork to another user; cross-tenant ids are 404', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    await createSubscription(ctx.owner, { userId: b.id, feedId: a.active[0], mode: 'active' });
    const article = await createArticle(ctx.owner, {
      feedIds: [a.active[0]],
      title: 'Shared headline',
    });
    const interest = uniqueText('Private examples');
    const forkA = await asUser(ctx, a.id, (tx) =>
      createCardFromArticle(tx, { articleId: article.id, interest, strength: 'like' }),
    );
    const forkB = await asUser(ctx, b.id, (tx) =>
      createCardFromArticle(tx, { articleId: article.id, interest, strength: 'like' }),
    );
    // Same text and example, but the owner is part of a fork's hash: each user has their own.
    expect(forkB.card.id).not.toBe(forkA.card.id);
    expect(forkB.card.parentCardId).toBe(forkA.card.parentCardId);
    expect((await storedCard(ctx, forkB.card.id)).owner_user_id).toBe(b.id);

    const id = forkA.card.id;
    await asUser(ctx, b.id, async (tx) => {
      expect(await getUserCard(tx, id)).toBeNull();
      expect((await listUserCards(tx)).map((card) => card.id)).toEqual([forkB.card.id]);
    });
    const attempts: Array<(tx: TenantTx) => Promise<unknown>> = [
      (tx) => updateUserCard(tx, { cardId: id, strength: 'love' }),
      (tx) => renameCard(tx, { cardId: id, title: 'Stolen' }),
      (tx) => deleteUserCard(tx, { cardId: id }),
      (tx) => addCardExample(tx, { cardId: id, articleId: article.id, side: 'no' }),
      (tx) => removeCardExample(tx, { cardId: id, side: 'yes', text: 'Shared headline' }),
      (tx) => adoptLibraryCard(tx, { cardId: id, strength: 'like' }),
    ];
    for (const attempt of attempts) {
      expect((await appErrorOf(asUser(ctx, b.id, attempt))).code).toBe('NOT_FOUND');
    }
    expect(await holdings(ctx, a.id)).toEqual([`${id}:like:*:-`]);
    expect(await holdings(ctx, b.id)).toEqual([`${forkB.card.id}:like:*:-`]);
  });
});

describe('quotas (spec 08 §6)', () => {
  async function holdFillers(userId: string, count: number, forks: boolean): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = await insertCard(
        ctx,
        forks
          ? {
              visibility: 'private',
              ownerUserId: userId,
              interest: uniqueText('Fork filler'),
              examplesYes: ['A filler example'],
            }
          : { visibility: 'shared', interest: uniqueText('Card filler') },
      );
      await ctx.owner.query(
        "INSERT INTO user_cards (user_id, card_id, strength) VALUES ($1, $2, 'like')",
        [userId, id],
      );
      ids.push(id);
    }
    return ids;
  }

  it('maxCards counts holdings (never cards too) and blocks create, adopt and from-article', async () => {
    const r = await createReader(ctx);
    await holdFillers(r.id, 49, false);
    const lastText = uniqueText('The fiftieth card');
    const last = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: lastText, strength: 'never' }),
    );
    expect(last.created).toBe(true);

    const library = await insertCard(ctx, {
      visibility: 'public',
      interest: uniqueText('Library'),
    });
    const article = await createArticle(ctx.owner, { feedIds: [r.active[0]] });
    const quota = { code: 'QUOTA_EXCEEDED', details: { limit: 'maxCards', used: 50, max: 50 } };
    const tooMany = uniqueText('One too many');
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => createUserCard(tx, { interest: tooMany, strength: 'like' })),
      ),
    ).toEqual(quota);
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) => adoptLibraryCard(tx, { cardId: library, strength: 'like' })),
      ),
    ).toEqual(quota);
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          createCardFromArticle(tx, { articleId: article.id, interest: tooMany, strength: 'like' }),
        ),
      ),
    ).toEqual(quota);
    // The refused transactions left no card rows behind.
    const { rows } = await ctx.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM interest_cards WHERE body->>'interest' = $1",
      [tooMany],
    );
    expect(rows[0]?.n).toBe(0);

    // A replay and a re-point are not additions.
    const replay = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: lastText, strength: 'never' }),
    );
    expect(replay.created).toBe(false);
    const edited = await asUser(ctx, r.id, (tx) =>
      editCardText(tx, { cardId: last.card.id, interest: uniqueText('Edited at quota') }),
    );
    expect(edited.idChange).not.toBeNull();

    await ctx.owner.query("UPDATE users SET plan = 'admin' WHERE id = $1", [r.id]);
    const admin = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: tooMany, strength: 'like' }),
    );
    expect(admin.created).toBe(true);
  });

  it('maxForks counts held private forks; fork → fork and fork → shared stay allowed over quota', async () => {
    const r = await createReader(ctx);
    const forks = await holdFillers(r.id, 20, true);
    const shared = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Not yet forked'), strength: 'like' }),
    );
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'An example headline',
    });
    const quota = (used: number) => ({
      code: 'QUOTA_EXCEEDED',
      details: { limit: 'maxForks', used, max: 20 },
    });
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          addCardExample(tx, { cardId: shared.card.id, articleId: article.id, side: 'yes' }),
        ),
      ),
    ).toEqual(quota(20));
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          createCardFromArticle(tx, {
            articleId: article.id,
            interest: uniqueText('Forked from an article'),
            strength: 'like',
          }),
        ),
      ),
    ).toEqual(quota(20));

    // Fork → fork keeps the count.
    const firstFork = forks[0] ?? 'missing';
    const forked = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: firstFork, articleId: article.id, side: 'no' }),
    );
    expect(forked.card.isPrivateFork).toBe(true);

    // After a plan reduction the 21 forks stay usable, but no new fork can be made.
    await ctx.owner.query("UPDATE users SET plan = 'admin' WHERE id = $1", [r.id]);
    const extra = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: shared.card.id, articleId: article.id, side: 'yes' }),
    );
    await ctx.owner.query("UPDATE users SET plan = 'beta' WHERE id = $1", [r.id]);
    const another = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: uniqueText('Another shared card'), strength: 'like' }),
    );
    expect(
      await appErrorOf(
        asUser(ctx, r.id, (tx) =>
          addCardExample(tx, { cardId: another.card.id, articleId: article.id, side: 'yes' }),
        ),
      ),
    ).toEqual(quota(21));
    const moreExamples = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: forked.card.id, articleId: article.id, side: 'yes' }),
    );
    expect(moreExamples.card.isPrivateFork).toBe(true);
    // Removing the last example leaves the fork quota.
    const back = await asUser(ctx, r.id, (tx) =>
      removeCardExample(tx, { cardId: extra.card.id, side: 'yes', text: 'An example headline' }),
    );
    expect(back.card).toMatchObject({ id: shared.card.id, isPrivateFork: false });
  });
});

describe('immutability (spec 05 §5.1)', () => {
  it('never updates a stored card: every lifecycle action inserts or reuses another row', async () => {
    const r = await createReader(ctx);
    const b = await createReader(ctx);
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Immutable headline',
    });
    const second = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Another immutable headline',
    });
    const library = await insertCard(ctx, {
      visibility: 'public',
      interest: uniqueText('Library'),
    });
    const interest = uniqueText('Immutable text');
    let cardId = '';
    const track = (card: { id: string }) => {
      cardId = card.id;
    };
    const steps: Array<() => Promise<void>> = [
      async () =>
        track(
          (await asUser(ctx, r.id, (tx) => createUserCard(tx, { interest, strength: 'like' })))
            .card,
        ),
      async () => {
        await asUser(ctx, b.id, (tx) => createUserCard(tx, { interest, strength: 'love' }));
      },
      async () =>
        track(
          (
            await asUser(ctx, r.id, (tx) =>
              addCardExample(tx, { cardId, articleId: article.id, side: 'yes' }),
            )
          ).card,
        ),
      async () =>
        track(
          (
            await asUser(ctx, r.id, (tx) =>
              addCardExample(tx, { cardId, articleId: second.id, side: 'no' }),
            )
          ).card,
        ),
      async () =>
        track(
          (
            await asUser(ctx, r.id, (tx) =>
              removeCardExample(tx, { cardId, side: 'yes', text: 'Immutable headline' }),
            )
          ).card,
        ),
      async () =>
        track(
          (
            await asUser(ctx, r.id, (tx) =>
              editCardText(tx, { cardId, interest: uniqueText('Edited immutable text') }),
            )
          ).card,
        ),
      async () => {
        await asUser(ctx, r.id, (tx) => renameCard(tx, { cardId, title: 'Renamed' }));
      },
      async () => {
        await asUser(ctx, r.id, (tx) => setCardStrength(tx, { cardId, strength: 'must' }));
      },
      async () => {
        await asUser(ctx, r.id, (tx) => setCardScope(tx, { cardId, scopeFeedId: r.active[0] }));
      },
      async () => {
        await asUser(ctx, r.id, (tx) =>
          adoptLibraryCard(tx, { cardId: library, strength: 'like' }),
        );
      },
      async () => {
        await asUser(ctx, r.id, (tx) =>
          createCardFromArticle(tx, { articleId: article.id, interest, strength: 'like' }),
        );
      },
      async () => {
        await asUser(ctx, r.id, (tx) => deleteUserCard(tx, { cardId }));
      },
    ];
    let before = await cardIdentities(ctx);
    for (const [index, step] of steps.entries()) {
      await step();
      const after = await cardIdentities(ctx);
      for (const [id, identity] of before)
        expect(after.get(id), `step ${index}, card ${id}`).toBe(identity);
      before = after;
    }
  });
});

describe('un-retire on reuse', () => {
  it('reuses a retired card by hash and un-retires it, for shared cards and forks', async () => {
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    const interest = uniqueText('Retired topic');
    const created = await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like' }),
    );
    const id = created.card.id;
    await asUser(ctx, a.id, (tx) => deleteUserCard(tx, { cardId: id }));
    // house.retire-cards retires the unheld card.
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [id]);

    const reused = await asUser(ctx, b.id, (tx) =>
      createUserCard(tx, { interest, strength: 'like' }),
    );
    expect(reused.card.id).toBe(id);
    expect((await storedCard(ctx, id)).retired_at).toBeNull();
    // The refresh in the same transaction already sees the live card.
    expect(await feedCards(ctx, b.active)).toEqual(numeric(b.active).map((f) => `${f}:${id}:1`));

    // A retired private fork is reused by its owner the same way.
    const article = await createArticle(ctx.owner, {
      feedIds: [b.active[0]],
      title: 'Fork example',
    });
    const fork = await asUser(ctx, b.id, (tx) =>
      addCardExample(tx, { cardId: id, articleId: article.id, side: 'yes' }),
    );
    await asUser(ctx, b.id, (tx) =>
      removeCardExample(tx, { cardId: fork.card.id, side: 'yes', text: 'Fork example' }),
    );
    await ctx.owner.query('UPDATE interest_cards SET retired_at = now() WHERE id = $1', [
      fork.card.id,
    ]);
    const again = await asUser(ctx, b.id, (tx) =>
      addCardExample(tx, { cardId: id, articleId: article.id, side: 'yes' }),
    );
    expect(again.card.id).toBe(fork.card.id);
    expect((await storedCard(ctx, fork.card.id)).retired_at).toBeNull();
  });
});
