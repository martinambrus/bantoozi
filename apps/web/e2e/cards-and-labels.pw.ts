import type { APIRequestContext, Page } from '@playwright/test';

import {
  addExample,
  applyUpdate,
  articleState,
  createCard,
  createLabelInUi,
  heldCard,
  labelsOf,
  labelsMenuButton,
  publicationRequestsOf,
  respondToRequest,
  updateOffersOf,
} from './admin-support/cards.js';
import {
  createOldPublicationRequest,
  feedbackEvents,
  publicationAudit,
  reviseProposalTitle,
  setLastActive,
} from './admin-support/hooks.js';
import {
  candidateEntry,
  candidateOf,
  eligibilityBadge,
  expectRefused,
  libraryEntry,
  openLibrary,
  promoteButton,
  promoteRequest,
  proposeInUi,
  proposeListing,
  requestPublication,
  type PromotionRequestView,
} from './admin-support/library.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import {
  articleByTitle,
  subscribe,
  subscriptionsOf,
  waitForExtraction,
} from './reader-support/api.js';
import { analysisRequests } from './reader-support/hooks.js';
import { openArticle, refreshUntil } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { EMAILS } from './support/env.js';
import { expect, test } from './support/test.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The kinds of `feedback_events` that rate an article or answer a prompt about it. */
const RATING_KINDS = ['rate', 'unrate', 'prompt_answer'];
/** What opening an article records. */
const READING_KINDS = ['open', 'read', 'unread', 'dwell'];

/**
 * Spec 09 §9, scenario 11: a shared card becomes public only with its original creator's approval
 * of the exact listing or after 30 days of verified creator inactivity (a separate audit basis); a
 * library update reaches only the holder who applies it; a label is neither a rating nor a start
 * of inference.
 */
test('cards and labels: publication needs the creator, updates need their holder, labels teach nothing', async ({
  api,
  browse,
  control,
}) => {
  test.setTimeout(300_000);

  const tag = uniqueTag();
  const creatorEmail = newAccount('cards-creator');
  const adopterAEmail = newAccount('cards-adopter-a');
  const adopterBEmail = newAccount('cards-adopter-b');

  const adminPage = await browse.as(EMAILS.admin);
  const admin = adminPage.request;
  let creator = await api.login(creatorEmail);
  const adopterA = await api.login(adopterAEmail);
  const adopterB = await api.login(adopterBEmail);

  /** Three accounts hold one card: its creator and two adopters who write the same text. */
  async function sharedCard(interest: string, holders: APIRequestContext[] = [adopterA, adopterB]) {
    const made = await createCard(creator, interest, 'like');
    for (const holder of holders) {
      expect(
        (await createCard(holder, interest, 'love')).id,
        'the same text is the same card',
      ).toBe(made.id);
    }
    return made;
  }

  /** The creator comes back: a new sign-in sets the last activity to now. */
  async function creatorReturns(): Promise<void> {
    creator = await api.login(creatorEmail);
  }

  // ── 1. Approval of the exact listing ────────────────────────────────────────────────────────
  const approvedInterest = `Deep sea cable repair ${tag}`;
  const approvedTitle = `Cable repair ${tag}`;
  const revisedTitle = `Cable repair crews ${tag}`;
  const approvedListing = {
    title: approvedTitle,
    titleSk: `Oprava káblov ${tag}`,
    topicIds: ['science.space'],
  };

  const approvedCard =
    await test.step('a card is proposed only once three readers hold it', async () => {
      const card = await createCard(creator, approvedInterest, 'like');
      await createCard(adopterA, approvedInterest, 'love');
      const tooEarly = await requestPublication(admin, card.id, approvedListing);
      expect(tooEarly.status(), 'two holders are not enough').toBe(409);
      expect(await tooEarly.json()).toMatchObject({
        error: { details: { reason: 'insufficient_holders', holders: 2, min: 3 } },
      });
      await createCard(adopterB, approvedInterest, 'like');
      expect((await candidateOf(admin, card.id)).holders).toBe(3);
      return card;
    });
  let request: PromotionRequestView =
    await test.step('the administrator proposes the listing', async () => {
      await openLibrary(adminPage);
      const entry = candidateEntry(adminPage, approvedCard.title);
      await expect(eligibilityBadge(entry, 'No request yet')).toBeVisible();
      await proposeInUi(adminPage, entry, approvedListing);
      await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
      await expect(promoteButton(entry)).toHaveCount(0);
      await expect(entry).toContainText(approvedTitle);
      const proposed = (await candidateOf(admin, approvedCard.id)).request;
      expect(proposed, 'the candidate carries the request').not.toBeNull();
      return proposed!;
    });

  await test.step('without the creator nobody can approve, and silence publishes nothing', async () => {
    await expectRefused(await promoteRequest(admin, request), 'the creator has not answered');
    // The request is addressed to the creator alone: an adopter sees none and cannot answer.
    expect(await publicationRequestsOf(adopterA)).toEqual([]);
    for (const adopter of [adopterA, adopterB]) {
      expect((await respondToRequest(adopter, request, 'approve')).status()).toBe(404);
    }
    await expectRefused(await promoteRequest(admin, request), 'only the adopters have answered');
    const audit = await publicationAudit(control, request.id);
    expect(audit).toMatchObject({
      status: 'pending',
      respondedAt: null,
      authorizationKind: null,
      cardVisibility: 'shared',
    });
    await adminPage.reload();
    const entry = candidateEntry(adminPage, approvedCard.title);
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
  });

  const creatorPage = await browse.as(creatorEmail);
  /** The creator's view of the request for `title`: the exact listing and the answer buttons. */
  const requestItem = (page: Page, title: string) =>
    page.getByRole('listitem', { name: title, exact: true });

  await test.step('the creator approves the exact listing', async () => {
    await creatorPage.goto('/interests?tab=requests');
    const item = requestItem(creatorPage, approvedCard.title);
    await expect(item).toContainText('Waiting for your answer');
    await expect(item).toContainText(approvedTitle);
    await expect(item).toContainText(approvedListing.titleSk);
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(item.getByText('Approved', { exact: true })).toBeVisible();
    await adminPage.reload();
    const entry = candidateEntry(adminPage, approvedCard.title);
    await expect(eligibilityBadge(entry, 'Approved by creator')).toBeVisible();
    await expect(promoteButton(entry)).toBeVisible();
  });

  await test.step('a changed title voids the approval: the stale Promote is refused', async () => {
    const staleVersion = request.version;
    await reviseProposalTitle(control, request.id, revisedTitle);
    const entry = candidateEntry(adminPage, approvedCard.title);
    // The page still shows the approved state of the earlier listing.
    await promoteButton(entry).click();
    await adminPage.getByRole('button', { name: 'Promote with creator approval' }).click();
    await expect(adminPage.getByRole('alert')).toContainText(
      'The eligibility of this card changed, for example because the creator came back or declined.',
    );
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    await expect(entry).toContainText(revisedTitle);
    request = (await candidateOf(admin, approvedCard.id)).request!;
    expect(request.version).not.toBe(staleVersion);
    await expectRefused(
      await promoteRequest(admin, { id: request.id, version: staleVersion }),
      'the version is stale',
    );
    await expectRefused(await promoteRequest(admin, request), 'the new version is unanswered');
    expect(await publicationAudit(control, request.id)).toMatchObject({
      status: 'pending',
      respondedAt: null,
      authorizationKind: null,
      cardVisibility: 'shared',
    });
  });

  await test.step('the creator approves the changed listing and the administrator publishes it', async () => {
    await creatorPage.reload();
    const item = requestItem(creatorPage, approvedCard.title);
    await expect(item).toContainText('Waiting for your answer');
    await expect(item).toContainText(revisedTitle);
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(item.getByText('Approved', { exact: true })).toBeVisible();

    await adminPage.reload();
    const entry = candidateEntry(adminPage, approvedCard.title);
    await expect(eligibilityBadge(entry, 'Approved by creator')).toBeVisible();
    await promoteButton(entry).click();
    await adminPage.getByRole('button', { name: 'Promote with creator approval' }).click();
    await expect(adminPage.getByRole('status').filter({ hasText: 'Promoted' })).toHaveText(
      `Promoted “${approvedCard.title}”. Approved by creator.`,
    );

    const audit = await publicationAudit(control, request.id);
    expect(audit).toMatchObject({
      status: 'promoted',
      authorizationKind: 'creator_approval',
      cardVisibility: 'public',
    });
    expect(audit.respondedAt, 'the creator answered').not.toBeNull();
    expect(audit.authorizationEvidence).toMatchObject({ policyVersion: 1 });
    expect(audit.authorizationEvidence).toHaveProperty('approvedVersion');

    await openLibrary(adminPage, tag);
    const published = libraryEntry(adminPage, revisedTitle);
    await expect(published).toContainText('Version 1');
    await expect(published).toContainText('Approved by creator');
    await expect(published).toContainText('Published on');
    await expect(candidateEntry(adminPage, approvedCard.title)).toHaveCount(0);
  });

  // ── 2. Thirty days without the creator ──────────────────────────────────────────────────────
  const quietInterest = `Underwater drone surveys ${tag}`;
  const quietListing = {
    title: `Drone surveys ${tag}`,
    titleSk: `Prieskumy dronov ${tag}`,
    topicIds: ['science.space'],
  };
  const quietCard = await sharedCard(quietInterest);
  const quietRequest = await proposeListing(admin, quietCard.id, quietListing);

  await test.step('an active creator who has not approved blocks publishing', async () => {
    await openLibrary(adminPage);
    const entry = candidateEntry(adminPage, quietCard.title);
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    await expectRefused(await promoteRequest(admin, quietRequest), 'the creator is active');
  });

  await test.step('29 days without the creator is one day short', async () => {
    await creatorPage.context().close();
    await setLastActive(control, creatorEmail, 29);
    await adminPage.reload();
    const entry = candidateEntry(adminPage, quietCard.title);
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    await expectRefused(await promoteRequest(admin, quietRequest), '29 days of inactivity');
  });

  await test.step('a creator who returns while the administrator confirms stops the promotion', async () => {
    await setLastActive(control, creatorEmail, 31);
    await adminPage.reload();
    const entry = candidateEntry(adminPage, quietCard.title);
    await expect(eligibilityBadge(entry, 'Eligible after 30 days inactive')).toBeVisible();
    await promoteButton(entry).click();
    const confirm = adminPage.getByRole('dialog');
    await expect(confirm).toContainText('You are publishing on that basis alone.');
    // The creator signs in again while the question is open.
    await creatorReturns();
    await confirm.getByRole('button', { name: 'Promote after 30 days of inactivity' }).click();
    await expect(adminPage.getByRole('alert')).toContainText(
      'The eligibility of this card changed, for example because the creator came back or declined.',
    );
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    expect(await publicationAudit(control, quietRequest.id)).toMatchObject({
      status: 'pending',
      authorizationKind: null,
      cardVisibility: 'shared',
    });
  });

  await test.step('after 30 quiet days the administrator publishes on a basis of its own', async () => {
    await setLastActive(control, creatorEmail, 31);
    await adminPage.reload();
    const entry = candidateEntry(adminPage, quietCard.title);
    await expect(eligibilityBadge(entry, 'Eligible after 30 days inactive')).toBeVisible();
    await promoteButton(entry).click();
    await adminPage.getByRole('button', { name: 'Promote after 30 days of inactivity' }).click();
    await expect(adminPage.getByRole('status').filter({ hasText: 'Promoted' })).toHaveText(
      `Promoted “${quietCard.title}”. Published after 30 days of creator inactivity.`,
    );

    const audit = await publicationAudit(control, quietRequest.id);
    expect(audit).toMatchObject({
      status: 'promoted',
      authorizationKind: 'creator_inactive_30d',
      cardVisibility: 'public',
      // Inactivity is not a response: the creator never answered.
      respondedAt: null,
    });
    const evidence = audit.authorizationEvidence as Record<string, string>;
    expect(evidence).toMatchObject({ policyVersion: 1, anchorSource: 'last_active_at' });
    expect(evidence).not.toHaveProperty('approvedVersion');
    const quietFor = Date.parse(evidence['checkedAt']!) - Date.parse(evidence['anchorAt']!);
    expect(quietFor, 'the evidence spans at least 30 days').toBeGreaterThanOrEqual(30 * DAY_MS);

    await openLibrary(adminPage, tag);
    const published = libraryEntry(adminPage, quietListing.title);
    await expect(published).toContainText('Published after 30 days of creator inactivity');
    await expect(published).not.toContainText('Approved by creator');
  });

  // ── 3. An explicit decline is a veto ────────────────────────────────────────────────────────
  const declinedInterest = `Lighthouse keepers diaries ${tag}`;
  const declinedCard = await sharedCard(declinedInterest);
  await creatorReturns();
  const declinedRequest = await proposeListing(admin, declinedCard.id, {
    title: `Keepers diaries ${tag}`,
    topicIds: ['science.space'],
  });

  await test.step('the creator declines the listing', async () => {
    const page = await browse.as(creatorEmail);
    await page.goto('/interests?tab=requests');
    const item = requestItem(page, declinedCard.title);
    await item.getByRole('button', { name: 'Decline' }).click();
    await expect(item.getByText('Declined', { exact: true })).toBeVisible();
    await page.context().close();
  });

  await test.step('neither another request, changed metadata nor waiting lifts the decline', async () => {
    await openLibrary(adminPage);
    const entry = candidateEntry(adminPage, declinedCard.title);
    await expect(eligibilityBadge(entry, 'Declined')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    await expect(entry.getByRole('button', { name: /^Create promotion request for / })).toHaveCount(
      0,
    );
    expect(await publicationAudit(control, declinedRequest.id)).toMatchObject({
      status: 'rejected',
      vetoed: true,
      cardVisibility: 'shared',
    });

    // The API still takes a new request, with other metadata, but it does not get past the veto.
    const again = await proposeListing(admin, declinedCard.id, {
      title: `Keepers diaries, new title ${tag}`,
      topicIds: [],
    });
    await expectRefused(await promoteRequest(admin, again), 'the creator declined');
    await setLastActive(control, creatorEmail, 40);
    await expectRefused(await promoteRequest(admin, again), 'the creator declined and left');
    await adminPage.reload();
    await expect(
      eligibilityBadge(candidateEntry(adminPage, declinedCard.title), 'Declined'),
    ).toBeVisible();
    await expect(promoteButton(candidateEntry(adminPage, declinedCard.title))).toHaveCount(0);
    expect(await publicationAudit(control, again.id)).toMatchObject({
      status: 'pending',
      authorizationKind: null,
      vetoed: true,
      cardVisibility: 'shared',
    });
  });

  // ── 4. An old request is no evidence ────────────────────────────────────────────────────────
  const oldInterest = `Heritage railway timetables ${tag}`;
  const oldCard = await sharedCard(oldInterest);
  await creatorReturns();

  await test.step('a request 60 days old does not publish a card whose creator is active', async () => {
    const old = await createOldPublicationRequest(control, oldCard.id, 60);
    const candidate = await candidateOf(admin, oldCard.id);
    expect(candidate.request?.id).toBe(old.requestId);
    const age = Date.now() - Date.parse(candidate.request!.requestedAt);
    expect(age, 'the request is about 60 days old').toBeGreaterThanOrEqual(59 * DAY_MS);
    await openLibrary(adminPage);
    const entry = candidateEntry(adminPage, oldCard.title);
    await expect(eligibilityBadge(entry, 'Awaiting approval')).toBeVisible();
    await expect(promoteButton(entry)).toHaveCount(0);
    await expectRefused(await promoteRequest(admin, candidate.request!), 'an old request alone');

    // Even a creator who left 29 days ago is one day short, whatever the age of the request.
    await setLastActive(control, creatorEmail, 29);
    await expectRefused(await promoteRequest(admin, candidate.request!), '29 days of inactivity');
    expect(await publicationAudit(control, old.requestId)).toMatchObject({
      status: 'pending',
      authorizationKind: null,
      cardVisibility: 'shared',
    });
  });

  // ── 5. A library update reaches only the holder who applies it ──────────────────────────────
  const science = await control.feed('science');
  const pageB = await browse.as(adopterBEmail);
  const pageA = await browse.as(adopterAEmail);
  const updatedInterest = `${approvedInterest} and the ships that lay them`;

  await test.step('one holder keeps a private fork of the published card', async () => {
    await subscribe(adopterB, science.url);
    await waitForExtraction(control, science.url, science.items.length);
    const example = await articleByTitle(adopterB, science.items[0]!.title);
    const fork = await addExample(adopterB, approvedCard.id, example.id, 'yes');
    expect(fork).toMatchObject({ isPrivateFork: true, interest: approvedInterest });
    expect(fork.id).not.toBe(approvedCard.id);
  });

  await test.step('the administrator publishes a new version of the card', async () => {
    await openLibrary(adminPage, tag);
    const published = libraryEntry(adminPage, revisedTitle);
    await published.getByRole('button', { name: `Edit ${revisedTitle}` }).click();
    const dialog = adminPage.getByRole('dialog', { name: `Edit ${revisedTitle} (version 1)` });
    await dialog.getByLabel('Interest', { exact: true }).fill(updatedInterest);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      adminPage.getByRole('status').filter({ hasText: 'Saved as a new version' }),
    ).toContainText('Saved as a new version (version 2).');
    await expect(
      libraryEntry(adminPage, revisedTitle).filter({ hasText: 'Version 2' }),
    ).toBeVisible();
  });

  await test.step('nobody holds the new version until they apply it', async () => {
    // Everyone still has what they had; the creator and the first adopter are offered version 2,
    // the fork's owner is told the update cannot replace their card.
    expect((await heldCard(creator, approvedInterest)).id).toBe(approvedCard.id);
    expect((await heldCard(adopterA, approvedInterest)).id).toBe(approvedCard.id);
    const forkOffer = (await updateOffersOf(adopterB)).find(
      (offer) => offer.hasPrivateCustomization,
    );
    expect(forkOffer, 'the fork has an advisory offer').toBeDefined();
    expect(forkOffer).toMatchObject({ baseCardId: approvedCard.id, fromVersion: 1, toVersion: 2 });
    for (const holder of [creator, adopterA]) {
      expect(await updateOffersOf(holder)).toEqual([
        expect.objectContaining({
          currentCardId: approvedCard.id,
          toVersion: 2,
          hasPrivateCustomization: false,
        }),
      ]);
    }
  });

  await test.step('applying the update changes the holder who applies it', async () => {
    await pageA.goto('/interests?tab=updates');
    const offer = pageA.getByRole('listitem', { name: revisedTitle, exact: true });
    await expect(offer).toContainText('Version 2 available');
    await offer.getByRole('button', { name: 'Apply this update' }).click();
    await expect(pageA.getByText('No library updates')).toBeVisible();
    expect((await heldCard(adopterA, updatedInterest)).id).not.toBe(approvedCard.id);
    // The creator still holds version 1 and is still offered the update.
    expect((await heldCard(creator, approvedInterest)).id).toBe(approvedCard.id);
    expect(await updateOffersOf(creator)).toHaveLength(1);
  });

  await test.step('a private fork is never replaced', async () => {
    await pageB.goto('/interests?tab=updates');
    const offer = pageB.getByRole('listitem', { name: revisedTitle, exact: true });
    await expect(offer).toContainText('This card has your own changes or examples');
    await expect(offer.getByRole('button', { name: 'Apply this update' })).toBeDisabled();
    const [forkOffer] = await updateOffersOf(adopterB);
    const refused = await applyUpdate(adopterB, forkOffer!);
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { details: { reason: 'private_holding' } },
    });
    const held = await heldCard(adopterB, approvedInterest);
    expect(held).toMatchObject({ isPrivateFork: true, examplesYes: expect.any(Array) });
    expect(held.examplesYes).toHaveLength(1);
  });

  // ── 6. A neutral label teaches nothing ──────────────────────────────────────────────────────
  await test.step('assigning a label is no rating and starts no inference', async () => {
    const labelName = `Read later ${tag}`;
    const target = science.items[1]!.title;
    await subscribe(adopterA, science.url);
    const before = await articleState(adopterA, target);
    expect(before).toMatchObject({
      lane: 'new',
      rating: null,
      tier: null,
      pLike: null,
      labelIds: [],
      analysis: { mode: 'off', status: 'not_requested' },
    });
    const [subscription] = await subscriptionsOf(adopterA);
    expect(subscription?.inferenceMode).toBe('off');
    const eventsBefore = await feedbackEvents(control, adopterAEmail);
    const callsBefore = await control.fakeCount();

    await createLabelInUi(pageA, {
      name: labelName,
      definition: 'Articles to come back to, whatever they say.',
    });
    await pageA.goto('/read/new');
    await refreshUntil(pageA, async () => {
      await expect(pageA.getByRole('button', { name: target, exact: true })).toBeVisible({
        timeout: 1_500,
      });
    });
    const pane = await openArticle(pageA, target);
    await labelsMenuButton(pane).click();
    await pageA.getByRole('menuitem', { name: `Add label ${labelName}` }).click();
    const label = (await labelsOf(adopterA)).find((candidate) => candidate.name === labelName);
    expect(label, 'the label exists').toBeDefined();
    await expect
      .poll(async () => (await articleState(adopterA, target)).labelIds, {
        message: 'the label is on the article',
      })
      .toEqual([label!.id]);

    // The label adds one event of its own. Opening the article to label it is reading, which the
    // reader records for any article; no event is a rating or the answer to a prompt.
    const kinds = (await feedbackEvents(control, adopterAEmail))
      .slice(eventsBefore.length)
      .map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'label')).toHaveLength(1);
    expect(
      kinds.filter((kind) => RATING_KINDS.includes(kind)),
      'no rating event',
    ).toEqual([]);
    expect(kinds.filter((kind) => !READING_KINDS.includes(kind))).toEqual(['label']);

    const after = await articleState(adopterA, target);
    expect(after).toMatchObject({
      lane: 'new',
      rating: null,
      tier: null,
      pLike: null,
      analysis: { mode: 'off', status: 'not_requested' },
    });
    const [subscriptionAfter] = await subscriptionsOf(adopterA);
    expect(subscriptionAfter).toMatchObject({
      inferenceMode: 'off',
      inferenceVersion: subscription?.inferenceVersion,
    });
    await staysTrueFor(3_000, async () => {
      expect(await control.fakeCount(), 'no model call').toBe(callsBefore);
      expect(await analysisRequests(control, adopterAEmail)).toEqual([]);
    });
  });
});
