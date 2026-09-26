import { sql } from 'drizzle-orm';

import { tenantUserId, type TenantTx } from '../tenant.js';
import { libraryCardDiff, type LibraryCardDiff } from './body.js';
import { repointCard } from './interest-cards.js';
import {
  activeFeedIds,
  conflict,
  coveredFeeds,
  loadCard,
  loadSubscriptions,
  lockCardHolding,
  lockFeeds,
  lockTenant,
  notFound,
} from './store.js';
import type { CardMutation } from './types.js';
import { validateId } from './validation.js';

/**
 * Opt-in library updates (spec 05 §8 "User-controlled updates", spec 08 §7). A semantic library
 * change is a new immutable public card appended to `library_card_versions`; holders keep their
 * version until they explicitly apply the offered successor. Ignoring an offer keeps the old card
 * indefinitely: declining is doing nothing, so there is no decline state.
 */

/** One offer of `GET /library/updates`. */
export interface LibraryUpdateOffer {
  /** The card the user holds: the old library version, or a private fork of it. */
  currentCardId: string;
  /** The held library version (the fork's parent for a customization). */
  baseCardId: string;
  /** The latest version of the same library entry. */
  newCardId: string;
  librarySlug: string;
  fromVersion: number;
  toVersion: number;
  /** Semantic text/example differences between the base and the new version. */
  diff: LibraryCardDiff;
  /**
   * The user holds a private fork: an advisory notice only. It cannot be applied; the user reviews
   * the diff in the card editor, whose normal edit/fork rules apply (spec 05 §8).
   */
  hasPrivateCustomization: boolean;
}

/**
 * Offers for the user's holdings of superseded library versions and of private forks made from
 * one, each towards the latest version of that library entry, with exact ids and differences.
 */
export async function listLibraryUpdates(tx: TenantTx): Promise<LibraryUpdateOffer[]> {
  const result = await tx.execute<{
    current_card_id: string;
    base_card_id: string;
    customized: boolean;
    library_slug: string;
    from_version: number;
    new_card_id: string;
    to_version: number;
  }>(sql`
    SELECT h.current_card_id::text AS current_card_id, h.base_card_id::text AS base_card_id,
           h.customized, v.library_slug, v.version AS from_version,
           latest.card_id::text AS new_card_id, latest.version AS to_version
      FROM (SELECT uc.card_id AS current_card_id,
                   CASE WHEN c.visibility = 'private' THEN c.parent_card_id ELSE c.id END AS base_card_id,
                   c.visibility = 'private' AS customized
              FROM user_cards uc JOIN interest_cards c ON c.id = uc.card_id
             WHERE uc.user_id = ${tenantUserId(tx)}::uuid) h
      JOIN library_card_versions v ON v.card_id = h.base_card_id
      JOIN LATERAL (SELECT n.card_id, n.version FROM library_card_versions n
                     WHERE n.library_slug = v.library_slug
                     ORDER BY n.version DESC LIMIT 1) latest ON latest.version > v.version
     ORDER BY v.library_slug, h.customized, h.current_card_id`);
  const offers: LibraryUpdateOffer[] = [];
  for (const row of result.rows) {
    const base = await loadCard(tx, row.base_card_id);
    const next = await loadCard(tx, row.new_card_id);
    if (base === null || next === null) continue;
    offers.push({
      currentCardId: row.current_card_id,
      baseCardId: row.base_card_id,
      newCardId: row.new_card_id,
      librarySlug: row.library_slug,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      diff: libraryCardDiff(base, next),
      hasPrivateCustomization: row.customized,
    });
  }
  return offers;
}

export interface ApplyLibraryUpdateInput {
  /** The held old library version (`:id`). */
  cardId: string;
  /** The advertised successor (`:newId`). */
  newCardId: string;
  /** The card the client believes the user currently holds for this entry. */
  expectedCurrentCardId: string;
}

/**
 * `POST /library/:id/updates/:newId/apply` (spec 05 §8): in one transaction verify the advertised
 * lineage (`newCardId` is a later version of `cardId`'s library entry, else `404`) and the current
 * unforked holding of `cardId` (a stale `expectedCurrentCardId` the user no longer holds is `404`),
 * then switch only this holder, preserving strength, scope and `title_override`. Already holding the
 * target with identical settings coalesces; different settings are `target_held` with every choice
 * preserved. A private customization (`expectedCurrentCardId` is the user's fork of `cardId`) is
 * `private_holding`, any other mismatch `holding_mismatch`. Effects: refresh, admitted-demand
 * backfill, rank full, learn. Other holders are untouched.
 */
export async function applyLibraryUpdate(
  tx: TenantTx,
  input: ApplyLibraryUpdateInput,
): Promise<CardMutation> {
  const cardId = validateId(input.cardId, 'cardId');
  const newCardId = validateId(input.newCardId, 'newCardId');
  const expectedCurrentCardId = validateId(input.expectedCurrentCardId, 'expectedCurrentCardId');

  const me = await lockTenant(tx);
  const lineage = await tx.execute<{ ok: boolean }>(sql`
    SELECT n.version > o.version AS ok
      FROM library_card_versions o
      JOIN library_card_versions n ON n.library_slug = o.library_slug
     WHERE o.card_id = ${cardId}::bigint AND n.card_id = ${newCardId}::bigint`);
  if (lineage.rows[0]?.ok !== true) throw notFound('library update');

  const expected = await lockCardHolding(tx, me.userId, expectedCurrentCardId);
  if (expected === null) throw notFound('card');
  if (expectedCurrentCardId !== cardId) {
    const held = await loadCard(tx, expectedCurrentCardId);
    throw conflict(
      held !== null && held.visibility === 'private' && held.parentCardId === cardId
        ? 'private_holding'
        : 'holding_mismatch',
      { cardId: expectedCurrentCardId },
    );
  }
  const current = await loadCard(tx, cardId);
  const target = await loadCard(tx, newCardId);
  if (current === null || current.kind !== 'interest' || current.visibility !== 'public') {
    throw notFound('card');
  }
  if (target === null || target.kind !== 'interest' || target.visibility !== 'public') {
    throw notFound('library update');
  }

  const subscriptions = await loadSubscriptions(tx, me.userId);
  const covered = coveredFeeds(subscriptions, expected.scopeFeedId);
  const refreshFeedIds = activeFeedIds(covered);
  await lockFeeds(tx, refreshFeedIds);
  return repointCard(tx, me, {
    current,
    target,
    strength: expected.strength,
    scopeFeedId: expected.scopeFeedId,
    titleOverride: expected.titleOverride,
    refreshFeedIds,
    covered,
  });
}
