import { createArticle } from '@bantoozi/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCardExample,
  applyLibraryUpdate,
  createUserCard,
  listLibraryUpdates,
  type ApplyLibraryUpdateInput,
} from '../../src/cards/index.js';
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
  takeOutbox,
} from './helpers.js';

/**
 * Opt-in library updates (spec 05 §8 "User-controlled updates"): offers with exact old/new ids and
 * semantic differences, an explicit apply that switches only this holder (strength, scope and name
 * preserved), idempotent coalescing, conflicts that change nothing, private customizations that are
 * advisory only, and declining as doing nothing.
 */

let ctx: DbTestContext;

beforeAll(async () => {
  ctx = await setupDbTest();
});

afterAll(async () => {
  await ctx.close();
});

let sequence = 0;

interface Version {
  title: string;
  interest: string;
  notFor?: string | null;
  examplesYes?: string[];
  examplesNo?: string[];
}

interface Entry {
  slug: string;
  ids: string[];
}

/** Append a library version (a new public card) to `entry`; the slug moves to the newest card. */
async function publishVersion(entry: Entry, version: Version): Promise<string> {
  const previous = entry.ids.at(-1) ?? null;
  if (previous !== null) {
    await ctx.owner.query('UPDATE interest_cards SET slug = NULL WHERE id = $1', [previous]);
  }
  const id = await insertCard(ctx, { visibility: 'public', slug: entry.slug, ...version });
  await ctx.owner.query(
    `INSERT INTO library_card_versions (library_slug, version, card_id, previous_card_id)
     VALUES ($1, $2, $3, $4)`,
    [entry.slug, entry.ids.length + 1, id, previous],
  );
  entry.ids.push(id);
  return id;
}

async function libraryEntry(...versions: Version[]): Promise<Entry> {
  sequence += 1;
  const entry: Entry = { slug: `entry-${sequence}`, ids: [] };
  for (const version of versions) await publishVersion(entry, version);
  return entry;
}

function rustVersions(): [Version, Version] {
  sequence += 1;
  return [
    {
      title: 'Rust',
      interest: `The Rust programming language and its releases (${sequence})`,
      notFor: 'Rust the video game',
    },
    {
      title: 'Rust programming',
      interest: `The Rust programming language: releases, libraries and tooling (${sequence})`,
      notFor: 'rust the  VIDEO game',
      examplesYes: ['Rust 1.80 released'],
      examplesNo: ['Rust (game) patch notes'],
    },
  ];
}

/** Hold `cardId` directly (a holding made while it was the current version). */
async function hold(
  userId: string,
  cardId: string,
  settings: { strength?: string; scopeFeedId?: string | null; titleOverride?: string | null } = {},
): Promise<void> {
  await ctx.owner.query(
    `INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id, title_override)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      cardId,
      settings.strength ?? 'like',
      settings.scopeFeedId ?? null,
      settings.titleOverride ?? null,
    ],
  );
}

function apply(userId: string, input: ApplyLibraryUpdateInput) {
  return asUser(ctx, userId, (tx) => applyLibraryUpdate(tx, input));
}

describe('library update offers', () => {
  it('lists held old versions and private forks with exact ids and semantic differences', async () => {
    const [v1Text, v2Text] = rustVersions();
    const entry = await libraryEntry(v1Text, v2Text);
    const [v1, v2] = entry.ids as [string, string];
    const current = await libraryEntry({ title: 'Current', interest: `Current entry ${sequence}` });
    const a = await createReader(ctx);
    const b = await createReader(ctx);
    await hold(a.id, v1, { strength: 'love' });
    await hold(a.id, current.ids[0] ?? 'missing');
    await asUser(ctx, a.id, (tx) =>
      createUserCard(tx, { interest: `Not from the library ${sequence}`, strength: 'like' }),
    );
    await hold(b.id, v1);
    const article = await createArticle(ctx.owner, {
      feedIds: [b.active[0]],
      title: 'Why we rewrote it in Rust',
    });
    const fork = await asUser(ctx, b.id, (tx) =>
      addCardExample(tx, { cardId: v1, articleId: article.id, side: 'yes' }),
    );

    const diff = {
      title: { from: 'Rust', to: 'Rust programming' },
      interest: { from: v1Text.interest, to: v2Text.interest },
      // A change of case or spacing is not semantic.
      notFor: null,
      examplesYes: { added: ['Rust 1.80 released'], removed: [] },
      examplesNo: { added: ['Rust (game) patch notes'], removed: [] },
    };
    const offer = {
      baseCardId: v1,
      newCardId: v2,
      librarySlug: entry.slug,
      fromVersion: 1,
      toVersion: 2,
      diff,
    };
    expect(await asUser(ctx, a.id, (tx) => listLibraryUpdates(tx))).toEqual([
      { ...offer, currentCardId: v1, hasPrivateCustomization: false },
    ]);
    // The fork's offer is advisory: the diff of its parent version, never applied to the fork.
    expect(await asUser(ctx, b.id, (tx) => listLibraryUpdates(tx))).toEqual([
      { ...offer, currentCardId: fork.card.id, hasPrivateCustomization: true },
    ]);

    // Silence is not acceptance: a later version is a new offer from the held version.
    const v3Text = { title: 'Rust', interest: `Rust language news ${sequence}` };
    const v3 = await publishVersion(entry, v3Text);
    const [later] = await asUser(ctx, a.id, (tx) => listLibraryUpdates(tx));
    expect(later).toMatchObject({ currentCardId: v1, baseCardId: v1, newCardId: v3, toVersion: 3 });
    expect(later?.diff).toMatchObject({
      title: null,
      interest: { from: v1Text.interest, to: v3Text.interest },
      notFor: { from: 'Rust the video game', to: null },
    });
    expect(await holdings(ctx, a.id)).toContain(`${v1}:love:*:-`);
  });
});

describe('apply a library update', () => {
  it('switches only this holder to the new version, keeping strength, scope and name', async () => {
    const entry = await libraryEntry(...rustVersions());
    const [v1, v2] = entry.ids as [string, string];
    const a = await createReader(ctx);
    const c = await createReader(ctx);
    const selected = await createArticle(ctx.owner, { feedIds: [c.training] });
    await selectArticle(ctx, { userId: c.id, feedId: c.training, articleId: selected.id });
    await hold(a.id, v1, { strength: 'love', scopeFeedId: a.active[1], titleOverride: 'My Rust' });
    await hold(c.id, v1);
    await ctx.owner.query('SELECT refresh_feed_cards($1::bigint[])', [[...a.active, ...c.active]]);
    const revision = BigInt(await rankRevision(ctx, a.id));

    const applied = await apply(a.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 });
    expect(applied).toMatchObject({
      created: false,
      idChange: { from: v1, to: v2 },
      card: {
        id: v2,
        strength: 'love',
        scopeFeedId: a.active[1],
        title: 'My Rust',
        titleOverride: 'My Rust',
        cardTitle: 'Rust programming',
        origin: 'library',
        visibility: 'public',
        librarySlug: entry.slug,
        examplesYes: ['Rust 1.80 released'],
      },
    });
    expect(applied.effects).toEqual({
      refreshFeedIds: [a.active[1]],
      backfill: { cardIds: [v2], feedIds: [a.active[1]] },
      rankFull: true,
      learn: true,
    });
    expect(await takeOutbox(ctx, a.id)).toEqual(
      cardIntents(a.id, { backfill: { cardIds: [v2], feedIds: [a.active[1]] } }),
    );
    expect(BigInt(await rankRevision(ctx, a.id))).toBe(revision + 1n);
    expect(await holdings(ctx, a.id)).toEqual([`${v2}:love:${a.active[1]}:My Rust`]);
    expect(await feedCards(ctx, a.active)).toEqual([`${a.active[1]}:${v2}:1`]);
    expect(await asUser(ctx, a.id, (tx) => listLibraryUpdates(tx))).toEqual([]);

    // Declining is doing nothing: the other holder keeps the old version and its offer.
    expect(await holdings(ctx, c.id)).toEqual([`${v1}:like:*:-`]);
    expect(await feedCards(ctx, c.active)).toEqual(numeric(c.active).map((f) => `${f}:${v1}:1`));
    expect(await takeOutbox(ctx, c.id)).toEqual([]);
    const offers = await asUser(ctx, c.id, (tx) => listLibraryUpdates(tx));
    expect(offers.map((o) => [o.currentCardId, o.newCardId])).toEqual([[v1, v2]]);

    // Their own apply backfills their admitted demand: active feeds and the selected training one.
    const unscoped = await apply(c.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 });
    expect(unscoped.effects).toEqual({
      refreshFeedIds: numeric(c.active),
      backfill: { cardIds: [v2], feedIds: numeric([...c.active, c.training]) },
      rankFull: true,
      learn: true,
    });
    // A replay of the applied request finds no holding of the old version.
    expect(
      await appErrorOf(apply(c.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 })),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
  });

  it('coalesces with an identical holding of the new version; other settings conflict and change nothing', async () => {
    const entry = await libraryEntry(...rustVersions());
    const [v1, v2] = entry.ids as [string, string];
    const same = await createReader(ctx);
    await hold(same.id, v1, { strength: 'must' });
    await hold(same.id, v2, { strength: 'must' });
    const merged = await apply(same.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 });
    expect(merged).toMatchObject({ idChange: { from: v1, to: v2 }, card: { id: v2 } });
    // The kept holding was already materialized and backfilled: no backfill intent.
    expect(merged.effects).toEqual({
      refreshFeedIds: numeric(same.active),
      rankFull: true,
      learn: true,
    });
    expect(await takeOutbox(ctx, same.id)).toEqual(cardIntents(same.id, {}));
    expect(await holdings(ctx, same.id)).toEqual([`${v2}:must:*:-`]);

    const differing: Array<[string, Parameters<typeof hold>[2], Parameters<typeof hold>[2]]> = [
      ['strength', { strength: 'like' }, { strength: 'love' }],
      ['scope', { scopeFeedId: 'first' }, {}],
      ['name', { titleOverride: 'Old name' }, {}],
    ];
    for (const [what, old, held] of differing) {
      const r = await createReader(ctx);
      const resolve = (s: Parameters<typeof hold>[2]) =>
        s?.scopeFeedId === 'first' ? { ...s, scopeFeedId: r.active[0] } : s;
      await hold(r.id, v1, resolve(old));
      await hold(r.id, v2, resolve(held));
      const before = await holdings(ctx, r.id);
      const revision = await rankRevision(ctx, r.id);
      expect(
        await appErrorOf(apply(r.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 })),
        what,
      ).toEqual({ code: 'CONFLICT', details: { reason: 'target_held', cardId: v2 } });
      expect(await holdings(ctx, r.id), what).toEqual(before);
      expect(await takeOutbox(ctx, r.id), what).toEqual([]);
      expect(await rankRevision(ctx, r.id), what).toBe(revision);
    }
  });

  it('never applies to a private customization; the fork stays unchanged', async () => {
    const entry = await libraryEntry(...rustVersions());
    const [v1, v2] = entry.ids as [string, string];
    const r = await createReader(ctx);
    await hold(r.id, v1, { strength: 'love' });
    const article = await createArticle(ctx.owner, {
      feedIds: [r.active[0]],
      title: 'Async Rust in practice',
    });
    const fork = await asUser(ctx, r.id, (tx) =>
      addCardExample(tx, { cardId: v1, articleId: article.id, side: 'yes' }),
    );
    const identities = await cardIdentities(ctx);
    const before = await holdings(ctx, r.id);
    await takeOutbox(ctx, r.id);

    expect(
      await appErrorOf(
        apply(r.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: fork.card.id }),
      ),
    ).toEqual({ code: 'CONFLICT', details: { reason: 'private_holding', cardId: fork.card.id } });
    // The fork is not a holding of the old version itself.
    expect(
      await appErrorOf(apply(r.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 })),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
    expect(await holdings(ctx, r.id)).toEqual(before);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
    await expectCardsUnchanged(ctx, identities);
    const [offer] = await asUser(ctx, r.id, (tx) => listLibraryUpdates(tx));
    expect(offer).toMatchObject({
      currentCardId: fork.card.id,
      newCardId: v2,
      hasPrivateCustomization: true,
    });
  });

  it('verifies the advertised lineage and the expected current holding', async () => {
    const entry = await libraryEntry(...rustVersions());
    const other = await libraryEntry(...rustVersions());
    const [v1, v2] = entry.ids as [string, string];
    const [, w2] = other.ids as [string, string];
    const r = await createReader(ctx);
    await hold(r.id, v1);
    await hold(r.id, v2);
    const card = await asUser(ctx, r.id, (tx) =>
      createUserCard(tx, { interest: `An unrelated card ${sequence}`, strength: 'like' }),
    );
    await takeOutbox(ctx, r.id);
    const before = await holdings(ctx, r.id);

    const lineage: ApplyLibraryUpdateInput[] = [
      { cardId: v2, newCardId: v1, expectedCurrentCardId: v2 }, // a downgrade
      { cardId: v1, newCardId: v1, expectedCurrentCardId: v1 },
      { cardId: v1, newCardId: w2, expectedCurrentCardId: v1 }, // another entry
      { cardId: card.card.id, newCardId: v2, expectedCurrentCardId: card.card.id },
      { cardId: v1, newCardId: '999999999', expectedCurrentCardId: v1 },
    ];
    for (const input of lineage) {
      expect(await appErrorOf(apply(r.id, input)), JSON.stringify(input)).toEqual({
        code: 'NOT_FOUND',
        details: { resource: 'library update' },
      });
    }
    expect(
      await appErrorOf(
        apply(r.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: card.card.id }),
      ),
    ).toEqual({ code: 'CONFLICT', details: { reason: 'holding_mismatch', cardId: card.card.id } });
    const stranger = await createReader(ctx);
    expect(
      await appErrorOf(
        apply(stranger.id, { cardId: v1, newCardId: v2, expectedCurrentCardId: v1 }),
      ),
    ).toEqual({ code: 'NOT_FOUND', details: { resource: 'card' } });
    expect(
      await appErrorOf(apply(r.id, { cardId: 'v1', newCardId: v2, expectedCurrentCardId: v1 })),
    ).toEqual({ code: 'VALIDATION_FAILED', details: { field: 'cardId', reason: 'id' } });
    expect(await holdings(ctx, r.id)).toEqual(before);
    expect(await takeOutbox(ctx, r.id)).toEqual([]);
  });
});
