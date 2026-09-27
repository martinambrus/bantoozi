import { sql } from 'drizzle-orm';

import type { TenantTx } from '../tenant.js';
import {
  withAddedExample,
  defaultCardTitle,
  examplesOf,
  hasExamples,
  withRemovedExample,
  sameCardText,
  type CardExamples,
} from './body.js';
import {
  activeFeedIds,
  applyEffects,
  articleExample,
  carriedExamples,
  checkQuota,
  conflict,
  countCardHoldings,
  coveredFeeds,
  demandFeedIds,
  exampleTarget,
  forkSpec,
  loadCard,
  loadSubscriptions,
  lockCardHolding,
  lockFeeds,
  lockTenant,
  newlyCovered,
  noEffects,
  notFound,
  obtainCard,
  requireCard,
  requireCardHolding,
  requireScope,
  type CardHolding,
  type CardRow,
  type Subscription,
  type Tenant,
} from './store.js';
import type { CardMutation, CardRemoval, HeldCard } from './types.js';
import {
  invalidField,
  validateCardExample,
  validateCardInterest,
  validateCardLang,
  validateCardNotFor,
  validateCardStrength,
  validateCardTitle,
  validateCardTranslation,
  validateExampleSide,
  validateId,
  validateScopeFeedId,
  type CardStrength,
  type CardTranslationPair,
  type ExampleSide,
} from './validation.js';
import { getUserCard } from './views.js';

/**
 * The interest-card lifecycle of spec 05 §5.1 (the API's `/cards`, `/cards/from-article` and
 * `/library/:id/adopt`, spec 08 §7). Card rows are immutable: every text or example change creates,
 * or reuses by `text_hash`, another row and re-points the user's `user_cards` row, keeping its
 * strength, scope and `title_override`. Each function runs in the caller's tenant transaction, takes
 * the locks of the documented order, rechecks ownership, kind, scope and quotas, runs
 * `refresh_feed_cards` and records its job intents (see {@link CardMutation}'s `effects`).
 *
 * Conflicts (`409 CONFLICT`, `details.reason`): `already_held` — create/adopt of a card the user
 * already holds with a different strength, scope or title (identical settings are an idempotent
 * replay); `target_held` — the card an edit leads to is already held with different settings
 * (identical settings coalesce the two holdings); `superseded` — adopting an old library version.
 */

/** Fields of `POST /cards` (spec 08 §7) plus the API's detected language and English pair. */
export interface CreateUserCardInput {
  title?: string | undefined;
  interest: string;
  notFor?: string | null | undefined;
  strength: CardStrength;
  scopeFeedId?: string | null | undefined;
  /** Detected card language (spec 07 §5); `und` when omitted. */
  lang?: string | undefined;
  /** The complete English pair for a non-English card (`card_text_mode = 'english'`). */
  translation?: CardTranslationPair | null | undefined;
}

export interface AdoptLibraryCardInput {
  cardId: string;
  strength: CardStrength;
  scopeFeedId?: string | null | undefined;
}

/** Fields of `POST /cards/from-article`. */
export interface CreateCardFromArticleInput extends CreateUserCardInput {
  articleId: string;
}

/**
 * Fields of `PATCH /cards/:id`. `title` sets the holder's override (`null` clears it);
 * `interest`/`notFor` re-point to another card; `scopeFeedId: null` means all feeds.
 */
export interface UpdateUserCardInput {
  cardId: string;
  title?: string | null | undefined;
  interest?: string | undefined;
  notFor?: string | null | undefined;
  strength?: CardStrength | undefined;
  scopeFeedId?: string | null | undefined;
  lang?: string | undefined;
  translation?: CardTranslationPair | null | undefined;
}

async function requireHeldCard(tx: TenantTx, cardId: string): Promise<HeldCard> {
  const card = await getUserCard(tx, cardId);
  if (card === null) throw notFound('card');
  return card;
}

/** The title the holder sees. */
const displayTitle = (holding: { titleOverride: string | null }, card: CardRow): string =>
  holding.titleOverride ?? card.title;

/**
 * Hold a card that the user may not hold yet (create, adopt, from-article). Re-holding it with the
 * same strength, scope and (when given) display title is an idempotent replay without effects.
 */
async function holdCard(
  tx: TenantTx,
  me: Tenant,
  args: {
    card: CardRow;
    strength: CardStrength;
    scopeFeedId: string | null;
    title: string | null;
    covered: readonly Subscription[];
    unretired: boolean;
  },
): Promise<CardMutation> {
  const { card } = args;
  const existing = await lockCardHolding(tx, me.userId, card.id);
  if (existing !== null) {
    const sameTitle = args.title === null || displayTitle(existing, card) === args.title;
    if (
      existing.strength !== args.strength ||
      existing.scopeFeedId !== args.scopeFeedId ||
      !sameTitle
    ) {
      throw conflict('already_held', { cardId: card.id });
    }
    const effects = args.unretired
      ? await applyEffects(tx, me.userId, {
          refreshFeedIds: activeFeedIds(args.covered),
          backfill: null,
          rankFull: false,
          learn: false,
          labelIdChange: null,
          reason: 'cards',
        })
      : noEffects();
    return { card: await requireHeldCard(tx, card.id), idChange: null, created: false, effects };
  }

  const counts = await countCardHoldings(tx, me.userId);
  checkQuota('maxCards', counts.cards, counts.cards + 1, me.limits.maxCards);
  if (card.visibility === 'private') {
    checkQuota('maxForks', counts.forks, counts.forks + 1, me.limits.maxForks);
  }
  const override = args.title !== null && args.title !== card.title ? args.title : null;
  await tx.execute(sql`
    INSERT INTO user_cards (user_id, card_id, strength, scope_feed_id, title_override)
    VALUES (${me.userId}::uuid, ${card.id}::bigint, ${args.strength},
            ${args.scopeFeedId}::bigint, ${override})`);
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds: activeFeedIds(args.covered),
    backfill: { cardIds: [card.id], feedIds: await demandFeedIds(tx, me.userId, args.covered) },
    rankFull: true,
    learn: true,
    labelIdChange: null,
    reason: 'cards',
  });
  return { card: await requireHeldCard(tx, card.id), idChange: null, created: true, effects };
}

/**
 * Move the user's holding of `current` to `target`, with the given settings (spec 05 §5.1 forks and
 * edits, §8 library updates). The previous card row stays (other holders keep it; an unheld one is
 * left for `house.retire-cards`). When the user already holds `target`: identical strength, scope
 * and display title coalesce the two holdings, anything else is `target_held` with nothing changed.
 */
export async function repointCard(
  tx: TenantTx,
  me: Tenant,
  args: {
    current: CardRow;
    target: CardRow;
    strength: CardStrength;
    scopeFeedId: string | null;
    titleOverride: string | null;
    refreshFeedIds: readonly string[];
    /** The subscriptions the holding covers afterwards (backfill demand). */
    covered: readonly Subscription[];
  },
): Promise<CardMutation> {
  const { current, target } = args;
  const other = await lockCardHolding(tx, me.userId, target.id);
  let coalesced = false;
  if (other !== null) {
    if (
      other.strength !== args.strength ||
      other.scopeFeedId !== args.scopeFeedId ||
      displayTitle(other, target) !== (args.titleOverride ?? target.title)
    ) {
      throw conflict('target_held', { cardId: target.id });
    }
    await tx.execute(sql`
      DELETE FROM user_cards WHERE user_id = ${me.userId}::uuid AND card_id = ${current.id}::bigint`);
    coalesced = true;
  } else {
    const counts = await countCardHoldings(tx, me.userId);
    const forks =
      counts.forks +
      (target.visibility === 'private' ? 1 : 0) -
      (current.visibility === 'private' ? 1 : 0);
    checkQuota('maxForks', counts.forks, forks, me.limits.maxForks);
    await tx.execute(sql`
      UPDATE user_cards
         SET card_id = ${target.id}::bigint, strength = ${args.strength},
             scope_feed_id = ${args.scopeFeedId}::bigint, title_override = ${args.titleOverride},
             updated_at = now()
       WHERE user_id = ${me.userId}::uuid AND card_id = ${current.id}::bigint`);
  }
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds: args.refreshFeedIds,
    // A coalesced holding already had the target at these settings, so its demand was queued.
    backfill: coalesced
      ? null
      : { cardIds: [target.id], feedIds: await demandFeedIds(tx, me.userId, args.covered) },
    rankFull: true,
    learn: true,
    labelIdChange: null,
    reason: 'cards',
  });
  return {
    card: await requireHeldCard(tx, target.id),
    idChange: { from: current.id, to: target.id },
    created: false,
    effects,
  };
}

// ── Create, adopt, from-article ───────────────────────────────────────────────────────────────────

/**
 * **Create** (spec 05 §5.1): reuse the public/shared card with this text's hash (un-retiring it) or
 * insert `origin='user', visibility='shared', creator_user_id=me`; hold it with `title_override` =
 * the given title when it differs from the card's. Quota `maxCards`.
 */
export async function createUserCard(
  tx: TenantTx,
  input: CreateUserCardInput,
): Promise<CardMutation> {
  const title = input.title === undefined ? null : validateCardTitle(input.title);
  const interest = validateCardInterest(input.interest);
  const notFor = validateCardNotFor(input.notFor);
  const strength = validateCardStrength(input.strength);
  const scopeFeedId = validateScopeFeedId(input.scopeFeedId);
  const lang = validateCardLang(input.lang);
  const translation = validateCardTranslation(input.translation, notFor, lang);

  const me = await lockTenant(tx);
  const subscriptions = await loadSubscriptions(tx, me.userId);
  requireScope(subscriptions, scopeFeedId);
  const covered = coveredFeeds(subscriptions, scopeFeedId);
  await lockFeeds(tx, activeFeedIds(covered));
  const { card, unretired } = await obtainCard(tx, me.userId, {
    kind: 'interest',
    title: title ?? defaultCardTitle(interest),
    interest,
    notFor,
    examplesYes: [],
    examplesNo: [],
    private: false,
    parentCardId: null,
    lang,
    topicIds: [],
    i18n: {},
    translation,
  });
  return holdCard(tx, me, { card, strength, scopeFeedId, title, covered, unretired });
}

/**
 * **Adopt** a public library card. Only the current library version can be newly adopted
 * (`superseded` otherwise); shared or another user's cards are `404`.
 */
export async function adoptLibraryCard(
  tx: TenantTx,
  input: AdoptLibraryCardInput,
): Promise<CardMutation> {
  const cardId = validateId(input.cardId, 'cardId');
  const strength = validateCardStrength(input.strength);
  const scopeFeedId = validateScopeFeedId(input.scopeFeedId);

  const me = await lockTenant(tx);
  const subscriptions = await loadSubscriptions(tx, me.userId);
  requireScope(subscriptions, scopeFeedId);
  const covered = coveredFeeds(subscriptions, scopeFeedId);
  await lockFeeds(tx, activeFeedIds(covered));
  const card = await loadCard(tx, cardId);
  if (card === null || card.kind !== 'interest' || card.visibility !== 'public') {
    throw notFound('card');
  }
  const latest = await tx.execute<{ card_id: string }>(sql`
    SELECT n.card_id::text AS card_id
      FROM library_card_versions o
      JOIN library_card_versions n ON n.library_slug = o.library_slug
     WHERE o.card_id = ${cardId}::bigint
     ORDER BY n.version DESC LIMIT 1`);
  const currentVersion = latest.rows[0]?.card_id ?? cardId;
  if (currentVersion !== cardId && (await lockCardHolding(tx, me.userId, cardId)) === null) {
    throw conflict('superseded', { cardId, currentCardId: currentVersion });
  }
  return holdCard(tx, me, { card, strength, scopeFeedId, title: null, covered, unretired: false });
}

/**
 * **Make a card from an article**: create or reuse the shared text-only card, then create or reuse
 * the user's private fork of it with the article title in `examples_yes`; the user holds the fork.
 * Quotas `maxCards` and `maxForks`.
 */
export async function createCardFromArticle(
  tx: TenantTx,
  input: CreateCardFromArticleInput,
): Promise<CardMutation> {
  const articleId = validateId(input.articleId, 'articleId');
  const title = input.title === undefined ? null : validateCardTitle(input.title);
  const interest = validateCardInterest(input.interest);
  const notFor = validateCardNotFor(input.notFor);
  const strength = validateCardStrength(input.strength);
  const scopeFeedId = validateScopeFeedId(input.scopeFeedId);
  const lang = validateCardLang(input.lang);
  const translation = validateCardTranslation(input.translation, notFor, lang);

  const me = await lockTenant(tx);
  const subscriptions = await loadSubscriptions(tx, me.userId);
  requireScope(subscriptions, scopeFeedId);
  const covered = coveredFeeds(subscriptions, scopeFeedId);
  await lockFeeds(tx, activeFeedIds(covered));
  const example = await articleExample(tx, me.userId, articleId);
  const shared = await obtainCard(tx, me.userId, {
    kind: 'interest',
    title: title ?? defaultCardTitle(interest),
    interest,
    notFor,
    examplesYes: [],
    examplesNo: [],
    private: false,
    parentCardId: null,
    lang,
    topicIds: [],
    i18n: {},
    translation,
  });
  const fork = await obtainCard(tx, me.userId, forkSpec(shared.card, { yes: [example], no: [] }));
  return holdCard(tx, me, {
    card: fork.card,
    strength,
    scopeFeedId,
    title,
    covered,
    unretired: shared.unretired || fork.unretired,
  });
}

// ── Examples ──────────────────────────────────────────────────────────────────────────────────────

/**
 * **Add or remove an example**: build the new body (newest five per side), create or reuse the
 * user's private fork with it (or the shared text-only card when no example remains) and re-point
 * the holding, keeping strength, scope and the displayed title. Quota `maxForks`.
 */
async function changeExamples(
  tx: TenantTx,
  cardId: string,
  edit: (userId: string, examples: CardExamples) => Promise<CardExamples | null>,
): Promise<CardMutation> {
  const me = await lockTenant(tx);
  const holding = await requireCardHolding(tx, me.userId, cardId);
  const current = await requireCard(tx, cardId, 'interest');
  const subscriptions = await loadSubscriptions(tx, me.userId);
  const covered = coveredFeeds(subscriptions, holding.scopeFeedId);
  const refreshFeedIds = activeFeedIds(covered);
  await lockFeeds(tx, refreshFeedIds);
  const examples = await edit(me.userId, examplesOf(current.body));
  if (examples === null) {
    // The example is already there: nothing changes.
    return {
      card: await requireHeldCard(tx, cardId),
      idChange: null,
      created: false,
      effects: noEffects(),
    };
  }
  const target = await exampleTarget(tx, me.userId, current, examples);
  return repointCard(tx, me, {
    current,
    target,
    strength: holding.strength,
    scopeFeedId: holding.scopeFeedId,
    titleOverride: keptOverride(holding, current, target),
    refreshFeedIds,
    covered,
  });
}

/** Keep the holder's override; without one, keep showing the previous card's title. */
function keptOverride(holding: CardHolding, current: CardRow, target: CardRow): string | null {
  if (holding.titleOverride !== null) return holding.titleOverride;
  return target.title === current.title ? null : current.title;
}

/** `POST /cards/:id/examples {articleId, side}`: the article's title as the newest example. */
export async function addCardExample(
  tx: TenantTx,
  input: { cardId: string; articleId: string; side: ExampleSide },
): Promise<CardMutation> {
  const cardId = validateId(input.cardId, 'cardId');
  const articleId = validateId(input.articleId, 'articleId');
  const side = validateExampleSide(input.side);
  return changeExamples(tx, cardId, async (userId, examples) =>
    withAddedExample(examples, side, await articleExample(tx, userId, articleId)),
  );
}

/** `POST /cards/:id/examples/remove {side, text}`; an unknown example is `404`. */
export async function removeCardExample(
  tx: TenantTx,
  input: { cardId: string; side: ExampleSide; text: string },
): Promise<CardMutation> {
  const cardId = validateId(input.cardId, 'cardId');
  const side = validateExampleSide(input.side);
  const text = validateCardExample(input.text);
  return changeExamples(tx, cardId, async (_userId, examples) => {
    const next = withRemovedExample(examples, side, text);
    if (next === null) throw notFound('example');
    return next;
  });
}

// ── Edit, rename, strength, scope ─────────────────────────────────────────────────────────────────

/**
 * `PATCH /cards/:id`: any combination of **edit text** (as Create for the new text; a user with
 * examples gets a fork of the new text carrying the same examples; the holding is re-pointed and the
 * old card keeps its answers for other holders), **rename** (`title_override` only: no card change,
 * no effects), **change strength** (rank full and learn, no model calls) and **change scope**
 * (validated subscription; refresh the union of old and new feeds; backfill only admitted demand on
 * newly included feeds). Without an explicit title the holder's own name is kept.
 */
export async function updateUserCard(
  tx: TenantTx,
  input: UpdateUserCardInput,
): Promise<CardMutation> {
  const cardId = validateId(input.cardId, 'cardId');
  const title =
    input.title === undefined || input.title === null
      ? input.title
      : validateCardTitle(input.title);
  const interest = input.interest === undefined ? undefined : validateCardInterest(input.interest);
  const notFor = input.notFor === undefined ? undefined : validateCardNotFor(input.notFor);
  const strength = input.strength === undefined ? undefined : validateCardStrength(input.strength);
  const scopeFeedId =
    input.scopeFeedId === undefined ? undefined : validateScopeFeedId(input.scopeFeedId);
  if (
    title === undefined &&
    interest === undefined &&
    notFor === undefined &&
    strength === undefined &&
    scopeFeedId === undefined
  ) {
    throw invalidField('body', 'empty');
  }

  const me = await lockTenant(tx);
  const holding = await requireCardHolding(tx, me.userId, cardId);
  const current = await requireCard(tx, cardId, 'interest');
  const subscriptions = await loadSubscriptions(tx, me.userId);
  const nextScope = scopeFeedId === undefined ? holding.scopeFeedId : scopeFeedId;
  requireScope(subscriptions, nextScope);
  const nextStrength = strength ?? holding.strength;
  const nextText = {
    interest: interest ?? current.body.interest,
    notFor: notFor === undefined ? current.body.notFor : notFor,
  };
  const textChanged = !sameCardText(nextText, current.body);
  const scopeChanged = nextScope !== holding.scopeFeedId;
  const strengthChanged = nextStrength !== holding.strength;
  const oldCovered = coveredFeeds(subscriptions, holding.scopeFeedId);
  const newCovered = coveredFeeds(subscriptions, nextScope);
  const refreshFeedIds = textChanged || scopeChanged ? activeFeedIds(oldCovered, newCovered) : [];
  await lockFeeds(tx, refreshFeedIds);

  if (textChanged) {
    const lang = validateCardLang(input.lang);
    const translation = validateCardTranslation(input.translation, nextText.notFor, lang);
    // The holder's explicit name survives an edit; otherwise the new card's own title shows.
    const wanted = title === undefined ? holding.titleOverride : title;
    const shared = await obtainCard(tx, me.userId, {
      kind: 'interest',
      title: wanted ?? defaultCardTitle(nextText.interest),
      interest: nextText.interest,
      notFor: nextText.notFor,
      examplesYes: [],
      examplesNo: [],
      private: false,
      parentCardId: null,
      lang,
      topicIds: [],
      i18n: {},
      translation,
    });
    const examples = carriedExamples(current);
    const target = hasExamples(examples)
      ? (await obtainCard(tx, me.userId, forkSpec(shared.card, examples))).card
      : shared.card;
    return repointCard(tx, me, {
      current,
      target,
      strength: nextStrength,
      scopeFeedId: nextScope,
      titleOverride: wanted === null || wanted === target.title ? null : wanted,
      refreshFeedIds,
      covered: newCovered,
    });
  }

  const override =
    title === undefined
      ? holding.titleOverride
      : title === null || title === current.title
        ? null
        : title;
  if (!scopeChanged && !strengthChanged && override === holding.titleOverride) {
    return {
      card: await requireHeldCard(tx, cardId),
      idChange: null,
      created: false,
      effects: noEffects(),
    };
  }
  await tx.execute(sql`
    UPDATE user_cards
       SET strength = ${nextStrength}, scope_feed_id = ${nextScope}::bigint,
           title_override = ${override}, updated_at = now()
     WHERE user_id = ${me.userId}::uuid AND card_id = ${cardId}::bigint`);
  const settingsChanged = scopeChanged || strengthChanged;
  const effects = settingsChanged
    ? await applyEffects(tx, me.userId, {
        refreshFeedIds,
        backfill: scopeChanged
          ? {
              cardIds: [cardId],
              feedIds: await demandFeedIds(tx, me.userId, newlyCovered(oldCovered, newCovered)),
            }
          : null,
        rankFull: true,
        learn: true,
        labelIdChange: null,
        reason: 'cards',
      })
    : noEffects(); // a rename only: no card change, no model calls
  return { card: await requireHeldCard(tx, cardId), idChange: null, created: false, effects };
}

/** **Edit text** (`PATCH /cards/:id {interest, notFor}`). */
export function editCardText(
  tx: TenantTx,
  input: {
    cardId: string;
    interest?: string | undefined;
    notFor?: string | null | undefined;
    lang?: string | undefined;
    translation?: CardTranslationPair | null | undefined;
  },
): Promise<CardMutation> {
  return updateUserCard(tx, input);
}

/** **Rename** (`PATCH /cards/:id {title}`): the holder's `title_override`; `null` clears it. */
export function renameCard(
  tx: TenantTx,
  input: { cardId: string; title: string | null },
): Promise<CardMutation> {
  return updateUserCard(tx, input);
}

/** **Change strength**: rank full and learn, no refresh and no model calls. */
export function setCardStrength(
  tx: TenantTx,
  input: { cardId: string; strength: CardStrength },
): Promise<CardMutation> {
  return updateUserCard(tx, input);
}

/** **Change scope** to one subscribed feed, or `null` for all feeds. */
export function setCardScope(
  tx: TenantTx,
  input: { cardId: string; scopeFeedId: string | null },
): Promise<CardMutation> {
  return updateUserCard(tx, input);
}

// ── Delete ────────────────────────────────────────────────────────────────────────────────────────

/**
 * **Delete**: remove the `user_cards` row only (card rows are never deleted by the API;
 * `house.retire-cards` retires unheld ones). Effects: refresh, rank full, learn.
 */
export async function deleteUserCard(
  tx: TenantTx,
  input: { cardId: string },
): Promise<CardRemoval> {
  const cardId = validateId(input.cardId, 'cardId');
  const me = await lockTenant(tx);
  const holding = await requireCardHolding(tx, me.userId, cardId);
  const subscriptions = await loadSubscriptions(tx, me.userId);
  const refreshFeedIds = activeFeedIds(coveredFeeds(subscriptions, holding.scopeFeedId));
  await lockFeeds(tx, refreshFeedIds);
  await tx.execute(sql`
    DELETE FROM user_cards WHERE user_id = ${me.userId}::uuid AND card_id = ${cardId}::bigint`);
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds,
    backfill: null,
    rankFull: true,
    learn: true,
    labelIdChange: null,
    reason: 'cards',
  });
  return { effects };
}
