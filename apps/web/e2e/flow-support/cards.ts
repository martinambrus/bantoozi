import type { APIRequestContext } from '@playwright/test';

import { callJson } from '../support/api.js';

/**
 * The interest cards of an account and the public library, as the HTTP API shows them (spec 08 §7;
 * packages/shared/src/dto/cards.ts). Only the fields the flows read are typed.
 */

export interface HeldCard {
  id: string;
  title: string;
  interest: string;
  origin: 'library' | 'user' | 'fork';
  isPrivateFork: boolean;
  librarySlug: string | null;
  examplesYes: string[];
  examplesNo: string[];
}

export interface LibraryCard {
  id: string;
  slug: string | null;
  title: string;
  interest: string;
  held: boolean;
}

interface CardMutation {
  card: HeldCard;
  idChange: { from: string; to: string } | null;
}

/** The cards the account holds. */
export function heldCards(user: APIRequestContext): Promise<HeldCard[]> {
  return callJson<HeldCard[]>(user, 'GET', '/api/v1/cards');
}

/** One public library card, found by a search text and its slug. */
export async function libraryCard(
  user: APIRequestContext,
  search: string,
  slug: string,
): Promise<LibraryCard> {
  const page = await callJson<{ items: LibraryCard[] }>(user, 'GET', '/api/v1/library', {
    params: { q: search, limit: 50 },
  });
  const found = page.items.find((card) => card.slug === slug);
  if (found === undefined) throw new Error(`the library has no "${slug}" card for "${search}"`);
  return found;
}

/** Holds a library card as the account's own interest. */
export async function adoptLibraryCard(
  user: APIRequestContext,
  card: LibraryCard,
): Promise<HeldCard> {
  const adopted = await callJson<CardMutation>(user, 'POST', `/api/v1/library/${card.id}/adopt`, {
    data: { strength: 'love' },
  });
  return adopted.card;
}
