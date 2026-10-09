import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';

import { call, callJson } from '../support/api.js';
import { expect } from '../support/test.js';

/**
 * What a reader does with interest cards, labels, library updates and publication requests, as API
 * calls that arrange a scenario or check what the screen only summarizes, and the few UI steps of
 * the label scenario. The wire shapes are spec 08 §7 (packages/shared/src/dto/cards.ts); only the
 * fields the scenarios read are typed.
 */

export type Strength = 'must' | 'love' | 'like' | 'never';

export interface CardView {
  id: string;
  title: string;
  interest: string;
  notFor: string | null;
  strength: Strength;
  origin: 'library' | 'user' | 'fork';
  isPrivateFork: boolean;
  examplesYes: string[];
  examplesNo: string[];
  librarySlug: string | null;
}

interface CardMutation {
  card: CardView;
  idChange: { from: string; to: string } | null;
}

/**
 * Writes an interest card. The first person to write a text creates the card; anyone who writes
 * the same text afterwards holds that same card (a 201 for each: the holding is new).
 */
export async function createCard(
  user: APIRequestContext,
  interest: string,
  strength: Strength,
): Promise<CardView> {
  const made = await callJson<CardMutation>(user, 'POST', '/api/v1/cards', {
    data: { interest, strength },
    expected: 201,
  });
  return made.card;
}

export function cardsOf(user: APIRequestContext): Promise<CardView[]> {
  return callJson<CardView[]>(user, 'GET', '/api/v1/cards');
}

/** The one card a person holds whose text is `interest`. */
export async function heldCard(user: APIRequestContext, interest: string): Promise<CardView> {
  const found = (await cardsOf(user)).filter((card) => card.interest === interest);
  expect(found, `exactly one held card says "${interest}"`).toHaveLength(1);
  return found[0]!;
}

/** Adds an article as an example to a held card: on a card others hold, that makes a private fork. */
export async function addExample(
  user: APIRequestContext,
  cardId: string,
  articleId: string,
  side: 'yes' | 'no',
): Promise<CardView> {
  const edited = await callJson<CardMutation>(user, 'POST', `/api/v1/cards/${cardId}/examples`, {
    data: { articleId, side },
  });
  return edited.card;
}

// ── Publication requests, as the original creator sees them ───────────────────────────────────

export interface PublicationRequestView {
  id: string;
  cardId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'promoted';
  version: string;
  proposed: { slug: string | null; title: string | null; topicIds: string[] };
}

export function publicationRequestsOf(user: APIRequestContext): Promise<PublicationRequestView[]> {
  return callJson<PublicationRequestView[]>(user, 'GET', '/api/v1/cards/publication-requests');
}

/** The answer to a request, whatever its status: only the card's original creator may give one. */
export function respondToRequest(
  user: APIRequestContext,
  request: { id: string; version: string },
  decision: 'approve' | 'decline',
): Promise<APIResponse> {
  return call(user, 'POST', `/api/v1/cards/publication-requests/${request.id}/respond`, {
    data: { decision, expectedVersion: request.version },
  });
}

// ── Library updates ───────────────────────────────────────────────────────────────────────────

export interface UpdateOffer {
  currentCardId: string;
  baseCardId: string;
  newCardId: string;
  librarySlug: string;
  fromVersion: number;
  toVersion: number;
  hasPrivateCustomization: boolean;
}

export function updateOffersOf(user: APIRequestContext): Promise<UpdateOffer[]> {
  return callJson<UpdateOffer[]>(user, 'GET', '/api/v1/library/updates');
}

/** Applies an offered successor to the holding the person has now. */
export function applyUpdate(user: APIRequestContext, offer: UpdateOffer): Promise<APIResponse> {
  return call(
    user,
    'POST',
    `/api/v1/library/${offer.baseCardId}/updates/${offer.newCardId}/apply`,
    {
      data: { expectedCurrentCardId: offer.currentCardId },
    },
  );
}

// ── Labels ────────────────────────────────────────────────────────────────────────────────────

/** Creates a label on the Labels page. */
export async function createLabelInUi(
  page: Page,
  label: { name: string; definition: string },
): Promise<void> {
  await page.goto('/labels');
  await expect(page.getByRole('heading', { level: 1, name: 'Labels' })).toBeVisible();
  await page.getByRole('button', { name: 'New label' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New label' });
  await dialog.getByLabel('Name').fill(label.name);
  await dialog.getByLabel('Definition').fill(label.definition);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('listitem').filter({ hasText: label.name })).toBeVisible();
}

/** The "Labels" button of the open article, which offers each label of the person. */
export function labelsMenuButton(pane: Locator): Locator {
  return pane.getByRole('button', { name: 'Labels', exact: true });
}

export interface LabelView {
  id: string;
  name: string;
}

export function labelsOf(user: APIRequestContext): Promise<LabelView[]> {
  return callJson<LabelView[]>(user, 'GET', '/api/v1/labels');
}

/** What a list says about one article for the person: where it is, how it was rated and labelled. */
export interface ArticleState {
  id: string;
  lane: string;
  rating: 1 | -1 | null;
  tier: number | null;
  pLike: number | null;
  labelIds: string[];
  analysis: { mode: 'off' | 'training' | 'active'; status: string };
}

export async function articleState(user: APIRequestContext, title: string): Promise<ArticleState> {
  const list = await callJson<{ items: Array<ArticleState & { title: string }> }>(
    user,
    'GET',
    '/api/v1/articles',
    { params: { lane: 'all', status: 'all', limit: 100 } },
  );
  const found = list.items.find((item) => item.title === title);
  if (found === undefined) throw new Error(`"${title}" is not in the list`);
  return found;
}
