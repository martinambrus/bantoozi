import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';

import { call, callJson } from '../support/api.js';
import { expect } from '../support/test.js';

import type { AuthorizationKind } from './hooks.js';

/**
 * The administrator's side of the public library: promotion candidates, publication requests and
 * the published cards, as API calls that arrange or check a scenario and as the steps of the
 * `/admin/library` screen (spec 09 §8). The wire shapes are spec 08 §9 (packages/shared/src/dto).
 */

export interface Eligibility {
  status: 'eligible' | 'held' | 'promoted';
  basis: AuthorizationKind | null;
  reason: string | null;
}

export interface PromotionRequestView {
  id: string;
  cardId: string;
  status: string;
  /** Decimal string; the compare-and-swap token of the promotion. */
  version: string;
  requestedAt: string;
  payload: {
    slug: string | null;
    title: string | null;
    titleSk: string | null;
    topicIds: string[];
  };
  holders: number;
  vetoed: boolean;
  promotionEligibility: Eligibility;
  authorizationKind: AuthorizationKind | null;
}

export interface CandidateView {
  cardId: string;
  title: string;
  holders: number;
  vetoed: boolean;
  request: PromotionRequestView | null;
  promotionEligibility: Eligibility;
}

export interface Listing {
  title: string;
  titleSk?: string;
  topicIds: string[];
}

export async function candidatesOf(admin: APIRequestContext): Promise<CandidateView[]> {
  const list = await callJson<{ items: CandidateView[] }>(
    admin,
    'GET',
    '/api/v1/admin/library/candidates',
  );
  return list.items;
}

/** A shared card with enough holders, or a failure that says the card is not a candidate. */
export async function candidateOf(
  admin: APIRequestContext,
  cardId: string,
): Promise<CandidateView> {
  const found = (await candidatesOf(admin)).find((candidate) => candidate.cardId === cardId);
  if (found === undefined) throw new Error(`card ${cardId} is not a promotion candidate`);
  return found;
}

/** Asks for a publication request; answers whatever the status is. */
export function requestPublication(
  admin: APIRequestContext,
  cardId: string,
  listing: Listing,
): Promise<APIResponse> {
  return call(admin, 'POST', '/api/v1/admin/library/promotion-requests', {
    data: { cardId, ...listing },
  });
}

/** A publication request the administrator made and the server accepted. */
export async function proposeListing(
  admin: APIRequestContext,
  cardId: string,
  listing: Listing,
): Promise<PromotionRequestView> {
  const response = await requestPublication(admin, cardId, listing);
  expect(response.status(), `the request for card ${cardId} is accepted`).toBe(201);
  return ((await response.json()) as { request: PromotionRequestView }).request;
}

/** The administrator's attempt to publish the request at the version they know. */
export function promoteRequest(
  admin: APIRequestContext,
  request: { id: string; version: string },
): Promise<APIResponse> {
  return call(admin, 'POST', '/api/v1/admin/library/promote', {
    data: { requestId: request.id, expectedVersion: request.version },
  });
}

/** The attempt is refused as a conflict: the card stays as it is. */
export async function expectRefused(response: APIResponse, why: string): Promise<void> {
  expect(response.status(), `publishing is refused: ${why}`).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe('CONFLICT');
}

// ── The /admin/library screen ─────────────────────────────────────────────────────────────────

export async function openLibrary(page: Page, search?: string): Promise<void> {
  await page.goto(search === undefined ? '/admin/library' : `/admin/library?q=${search}`);
  await expect(page.getByRole('heading', { level: 3, name: 'Promotion candidates' })).toBeVisible();
}

/** A card of the "Promotion candidates" list, found by the title the readers gave it. */
export function candidateEntry(page: Page, title: string): Locator {
  return page
    .getByRole('region', { name: 'Promotion candidates' })
    .getByRole('article', { name: title, exact: true });
}

/** A card of the "Library cards" list. */
export function libraryEntry(page: Page, title: string): Locator {
  return page
    .getByRole('region', { name: 'Library cards' })
    .getByRole('article', { name: title, exact: true });
}

/** Proposes a public listing for a candidate in its dialog. */
export async function proposeInUi(
  page: Page,
  candidate: Locator,
  listing: Required<Listing>,
): Promise<void> {
  await candidate.getByRole('button', { name: /^Create promotion request for / }).click();
  const dialog = page.getByRole('dialog', { name: 'Create promotion request' });
  await dialog.getByLabel('Public title').fill(listing.title);
  await dialog.getByLabel('Slovak title').fill(listing.titleSk);
  await dialog.getByLabel('Topic ids (comma separated)').fill(listing.topicIds.join(', '));
  await dialog.getByRole('button', { name: 'Create request' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Request created. The original creator can now answer it.' }),
  ).toBeVisible();
}

/** The badge that names where a candidate stands, e.g. "Awaiting approval". */
export function eligibilityBadge(candidate: Locator, label: string): Locator {
  return candidate.getByText(label, { exact: true });
}

export function promoteButton(candidate: Locator): Locator {
  return candidate.getByRole('button', { name: /^Promote / });
}
