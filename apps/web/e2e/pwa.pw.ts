import { accountFollowing, deleteAccountInSettings } from './pwa-support/accounts.js';
import {
  articlesOf,
  cardsOf,
  enableAutomaticClassification,
  everyArticle,
  expectLane,
  expectState,
  fieldsOf,
  idOf,
  preferencesOf,
  rateFromAnotherDevice,
  rulesOf,
  stateOf,
  waitForTitles,
} from './pwa-support/api.js';
import {
  causesOf,
  expectOnlyItems,
  expectPressed,
  openReader,
  openRecentActions,
  paneButton,
  reasonBar,
  recentEntry,
  rowButton,
  rowTitle,
  showHidden,
  startReader,
  titleAbout,
  toastWith,
} from './pwa-support/reader.js';
import { recordFocus, takeFocusStops, type FocusStop } from './pwa-support/focus.js';
import { feedbackEventsOf, ratingEventsFor } from './pwa-support/hooks.js';
import {
  answerTo,
  readOriginal,
  setLearnFromReading,
  watchDwellRequests,
} from './pwa-support/implicit.js';
import {
  installabilityErrorsOf,
  startInstalledReader,
  test as installedTest,
} from './pwa-support/installed.js';
import { recordKeys, takeKeys, typeWithInputMethod } from './pwa-support/keys.js';
import { signInOnLoginPage, signOut } from './pwa-support/login.js';
import { decodedIconSize, linkedManifest } from './pwa-support/manifest.js';
import { rowWatch, watchRow, type RowWatch } from './pwa-support/motion.js';
import {
  backgroundSyncOf,
  comeBackOnline,
  goOffline,
  keepArticlesOnThisDevice,
  waitingToSync,
  watchRatingRequests,
  withoutBackgroundSync,
  workerControls,
  workerReady,
} from './pwa-support/offline.js';
import { endOtherSessions, otherSessionCount } from './pwa-support/sessions.js';
import {
  canariesIn,
  dumpStorage,
  offlineRows,
  plantInStorage,
  removePlanted,
  rowsOfAccount,
  savedOnDevice,
  tracesOfAccount,
  type Canary,
} from './pwa-support/storage.js';
import { leaveAndComeBack } from './pwa-support/visibility.js';
import { newAccount, uniqueTag } from './reader-support/accounts.js';
import { waitForExtraction } from './reader-support/api.js';
import { arrive } from './reader-support/hooks.js';
import { articlePane, openArticle, rowOf } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { callJson, type MeResponse } from './support/api.js';
import { URLS } from './support/env.js';
import { expect, test } from './support/test.js';

/**
 * Spec 09 §9, the PWA check. One test per bullet; each drives the real reader and compares the
 * screen with what the HTTP API reports. The tests of the first part run in the default browser
 * context; those on `installedTest` run in a persistent Chromium profile that keeps its service
 * worker, and lose their connection where the bullet says so.
 */

test('exact undo restores an earlier opposite rating, reason, read status and SHIFT-hide (UI and API agree)', async ({
  browse,
  control,
}) => {
  test.setTimeout(150_000);
  const reader = await startReader({ browse, control }, 'pwa-undo');
  const { page, user } = reader;
  const quantum = titleAbout(reader, 'quantum');
  const robotics = titleAbout(reader, 'robotics');
  const firmware = titleAbout(reader, 'firmware');

  await test.step('undoing a like brings back the dislike and its reason', async () => {
    const id = await idOf(user, quantum);
    await openArticle(page, quantum);
    await expectState(user, id, (state) => state.readAt !== null, 'opening the article reads it');

    await paneButton(page, 'Dislike').click();
    await reasonBar(page).getByRole('button', { name: 'Clickbait' }).click();
    const disliked = await expectState(
      user,
      id,
      { rating: -1, reason: 'clickbait' },
      'the dislike and its reason are saved',
    );
    await expect(toastWith(page, 'Marked as disliked')).toBeVisible();

    await paneButton(page, 'Like').click();
    await expectState(user, id, { rating: 1, reason: null }, 'the like replaces both');
    await expectPressed(paneButton(page, 'Like'), true);
    await expectPressed(paneButton(page, 'Dislike'), false);

    await toastWith(page, 'Marked as liked').getByRole('button', { name: 'Undo' }).click();
    await expectState(user, id, disliked, 'the undo restores the dislike, its reason and the rest');
    await expectPressed(paneButton(page, 'Dislike'), true);
    await expectPressed(paneButton(page, 'Like'), false);
  });

  await test.step('undoing a like with SHIFT on a read, disliked article brings back all of it', async () => {
    const id = await idOf(user, quantum);
    const before = await expectState(
      user,
      id,
      (state) =>
        state.rating === -1 &&
        state.reason === 'clickbait' &&
        state.readAt !== null &&
        state.archivedAt === null,
      'the article is read and disliked with a reason',
    );

    await paneButton(page, 'Like').click({ modifiers: ['Shift'] });
    await expectState(
      user,
      id,
      (state) =>
        state.rating === 1 &&
        state.reason === null &&
        state.readAt === before.readAt &&
        state.archivedAt !== null,
      'the like with SHIFT replaces the dislike and its reason, and hides the article',
    );
    expect((await articlesOf(user, 'hidden')).map((item) => item.id)).toContain(id);

    await toastWith(page, 'Marked as liked').getByRole('button', { name: 'Undo' }).click();
    await expectState(
      user,
      id,
      before,
      'the undo brings back the dislike, its reason, the read status',
    );
    expect((await articlesOf(user, 'hidden')).map((item) => item.id)).not.toContain(id);
    await expectPressed(paneButton(page, 'Dislike'), true);
    await expectPressed(paneButton(page, 'Like'), false);
  });

  await test.step('undoing a like with SHIFT unrates, unhides and unreads the article', async () => {
    const id = await idOf(user, robotics);
    const untouched = stateOf(await fieldsOf(user, id));
    expect(untouched).toEqual({
      rating: null,
      reason: null,
      readAt: null,
      archivedAt: null,
      bookmarkedAt: null,
      labelIds: [],
    });

    await rowButton(page, robotics, 'Like').click({ modifiers: ['Shift'] });
    await expectState(
      user,
      id,
      (state) => state.rating === 1 && state.readAt !== null && state.archivedAt !== null,
      'the like with SHIFT rates, reads and hides the article',
    );
    await expect(rowOf(page, robotics)).toHaveCount(0);
    expect((await articlesOf(user, 'hidden')).map((item) => item.id)).toContain(id);

    await toastWith(page, 'Marked as liked').getByRole('button', { name: 'Undo' }).click();
    await expectState(user, id, untouched, 'the undo leaves the article as it was');
    await expect(rowOf(page, robotics)).toBeVisible();
    await expect(rowOf(page, robotics).getByText('Unread', { exact: true })).toBeVisible();
    await expectPressed(rowButton(page, robotics, 'Like'), false);
    expect((await articlesOf(user, 'hidden')).map((item) => item.id)).not.toContain(id);
  });

  await test.step('undoing a like in the recent actions keeps an earlier read status', async () => {
    const id = await idOf(user, firmware);
    await openArticle(page, firmware);
    const read = await expectState(
      user,
      id,
      (state) => state.readAt !== null && state.rating === null,
      'opening the article reads it',
    );

    await rowButton(page, firmware, 'Like').click();
    await expectState(user, id, { rating: 1 }, 'the like is saved');

    const sheet = await openRecentActions(page, 'New');
    await recentEntry(sheet, 'Marked as liked', firmware)
      .getByRole('button', { name: 'Undo' })
      .click();
    await expectState(user, id, read, 'the undo takes back the rating and keeps the read status');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(rowOf(page, firmware)).toBeVisible();
    await expectPressed(rowButton(page, firmware, 'Like'), false);
  });
});

test('bulk undo refuses an intervening edit atomically', async ({ api, browse, control }) => {
  test.setTimeout(150_000);
  const reader = await startReader({ browse, control }, 'pwa-bulk');
  await expectOnlyItems(reader);
  const { page, user } = reader;
  const titles = reader.items.map((item) => item.title);
  const ids = await Promise.all(titles.map((title) => idOf(user, title)));
  const [edited] = ids;
  if (edited === undefined) throw new Error('the tech fixture feed has no items');

  async function markAllRead(): Promise<void> {
    await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
    const question = page.getByRole('dialog', { name: 'Mark all as read?' });
    await expect(question).toContainText('3 unread articles');
    await question.getByRole('button', { name: 'Mark as read' }).click();
    await expect(toastWith(page, 'Marked 3 as read')).toBeVisible();
  }

  async function everyRead(): Promise<boolean[]> {
    const all = await everyArticle(user);
    return ids.map((id) => all.get(id)?.readAt !== null);
  }

  await test.step('without an intervening edit the undo restores every article', async () => {
    await markAllRead();
    await expect.poll(everyRead).toEqual([true, true, true]);
    await toastWith(page, 'Marked 3 as read').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(everyRead).toEqual([false, false, false]);
    for (const title of titles) await expect(rowOf(page, title)).toBeVisible();
  });

  await test.step('another device edits one of them, and the undo is refused', async () => {
    await markAllRead();
    await expect.poll(everyRead).toEqual([true, true, true]);

    const device = await api.login(reader.email);
    await rateFromAnotherDevice(device, edited, 1);
    const before = await everyArticle(user);
    expect(before.get(edited)?.rating).toBe(1);

    const sheet = await openRecentActions(page, 'New');
    const entry = recentEntry(sheet, 'Marked everything in a view as read', '3 articles');
    await entry.getByRole('button', { name: 'Undo' }).click();
    await expect(toastWith(page, 'Newer changes were kept.')).toBeVisible();
    await expect(entry).toHaveCount(0);

    // Nothing changed, not even the articles nobody else touched: same state, same version.
    expect(await everyArticle(user)).toEqual(before);
  });
});

test('an excluded article is recoverable via Show hidden with its explanation, and Unhide clears only a manual archive', async ({
  browse,
  control,
}) => {
  test.setTimeout(170_000);
  const reader = await startReader({ browse, control }, 'pwa-hidden', {
    feeds: ['science', 'culture'],
  });
  const { page, user } = reader;
  const muted = titleAbout(reader, 'glacier');
  const archived = titleAbout(reader, 'enzyme');
  const tag = uniqueTag();
  const carded = `Marmot ${tag} colony counted by alpine rangers`;
  const ids = { muted: '', archived: '', carded: '' };

  await test.step('a rule, a Never card and the reader exclude one article each', async () => {
    await enableAutomaticClassification(user, (await control.feed('culture')).url);
    await callJson<unknown>(user, 'POST', '/api/v1/rules', {
      data: { kind: 'mute_keyword', value: 'glacier' },
      expected: 201,
    });
    await callJson<unknown>(user, 'POST', '/api/v1/cards', {
      data: { interest: 'Alpine marmot colonies', strength: 'never' },
      expected: 201,
    });
    // Only an arrival after the switch is analyzed, and the fake model matches it to the card.
    await arrive(control, 'culture', {
      title: carded,
      excerpt: `Rangers counted the marmot colony above the tree line (${tag}).`,
    });
    await waitForTitles(user, [carded]);
    ids.muted = await idOf(user, muted);
    ids.archived = await idOf(user, archived);
    ids.carded = await idOf(user, carded);
    const byRule = await expectLane(
      user,
      ids.muted,
      (lane) => lane === 'hidden',
      'the rule hides it',
    );
    expect(byRule.topReason).toMatchObject({ kind: 'rule', code: 'mute_keyword:glacier' });
    const byCard = await expectLane(
      user,
      ids.carded,
      (lane) => lane === 'hidden',
      'the Never card hides the analyzed arrival',
    );
    expect(byCard.topReason?.code).toMatch(/^never:/);

    await rowButton(page, archived, 'Like').click({ modifiers: ['Shift'] });
    await expectState(
      user,
      ids.archived,
      (state) => state.archivedAt !== null,
      'the reader hides it',
    );
  });

  await test.step('Show hidden lists all three with what hides each', async () => {
    await showHidden(page, 'New');
    for (const title of [muted, archived, carded]) await expect(rowOf(page, title)).toBeVisible();

    await expect(causesOf(page, archived)).toHaveText(/^Hidden by youUnhide$/);
    await expect(causesOf(page, muted)).toHaveText(
      /^Hidden by a rule: Muted keyword: “glacier”Go to Rules$/,
    );
    await expect(causesOf(page, carded)).toHaveText(
      /^Hidden by a never-show interestGo to Interests$/,
    );
    for (const title of [muted, carded]) {
      await expect(causesOf(page, title).getByRole('button', { name: 'Unhide' })).toHaveCount(0);
    }

    // Why this? names the same rule, and the card behind the Never rule.
    await rowOf(page, muted)
      .getByRole('button', { name: 'Muted keyword: “glacier”, Why this?' })
      .click();
    const why = page.getByRole('dialog', { name: 'Why this?' });
    await expect(why.getByRole('list', { name: 'Rules applied' })).toHaveText(
      'Muted keyword: “glacier”Undo',
    );
    await page.keyboard.press('Escape');
    await expect(why).toBeHidden();
    await rowOf(page, carded)
      .getByRole('button', { name: 'Hidden by a never-show interest, Why this?' })
      .click();
    await expect(why.getByRole('list', { name: 'Rules applied' })).toContainText(
      'Hidden by a never-show interest: Alpine marmot colonies',
    );
    await page.keyboard.press('Escape');
    await expect(why).toBeHidden();
  });

  await test.step('Unhide clears a manual archive and nothing else', async () => {
    const before = await expectState(
      user,
      ids.archived,
      (state) => state.archivedAt !== null && state.rating === 1,
      'the reader hid and liked it',
    );
    await causesOf(page, archived).getByRole('button', { name: 'Unhide' }).click();
    await expect(causesOf(page, archived)).toHaveText(
      'Not hidden any more. It leaves this list when the list is loaded again.',
    );
    await expectState(user, ids.archived, { ...before, archivedAt: null }, 'only the archive goes');
    await expectLane(user, ids.archived, (lane) => lane !== 'hidden', 'it is no longer hidden');
  });

  for (const [title, key, cause, link] of [
    [muted, 'muted', 'Hidden by a rule: Muted keyword: “glacier”', 'Go to Rules'],
    [carded, 'carded', 'Hidden by a never-show interest', 'Go to Interests'],
  ] as const) {
    await test.step(`Unhide of an archive on top of ${link === 'Go to Rules' ? 'a rule' : 'a Never card'} leaves that in place`, async () => {
      const id = ids[key];
      await rowButton(page, title, 'Like').click({ modifiers: ['Shift'] });
      await expect(causesOf(page, title)).toContainText('Hidden by you');
      await expect(causesOf(page, title)).toContainText(cause);
      const both = await expectState(
        user,
        id,
        (state) => state.archivedAt !== null && state.rating === 1,
        'the reader archives it as well',
      );

      await causesOf(page, title).getByRole('button', { name: 'Unhide' }).click();
      await expect(causesOf(page, title)).not.toContainText('Hidden by you');
      await expect(causesOf(page, title)).toContainText(cause);
      await expect(causesOf(page, title).getByRole('link', { name: link })).toBeVisible();
      await expect(causesOf(page, title).getByRole('button', { name: 'Unhide' })).toHaveCount(0);
      await expectState(user, id, { ...both, archivedAt: null }, 'only the archive goes');
      // The worker ranks again after an unhide; the rule or card still decides.
      await staysTrueFor(3_000, async () => {
        expect((await fieldsOf(user, id)).lane).toBe('hidden');
      });
    });
  }

  await test.step('the rule and the card are still there, and the rule-hidden articles stay hidden', async () => {
    expect(await rulesOf(user)).toMatchObject([{ kind: 'mute_keyword', value: 'glacier' }]);
    expect((await cardsOf(user)).map((card) => card.strength)).toEqual(['never']);

    await page.goto('/read/hidden');
    await expect(rowOf(page, muted)).toBeVisible();
    await expect(rowOf(page, carded)).toBeVisible();
    await expect(rowOf(page, archived)).toHaveCount(0);
    const listed = (await articlesOf(user, 'all')).map((item) => item.id);
    expect(listed).toContain(ids.archived);
    expect(listed).not.toContain(ids.muted);
    expect(listed).not.toContain(ids.carded);

    await causesOf(page, muted).getByRole('link', { name: 'Go to Rules' }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('button', { name: 'Delete rule: glacier' })).toBeVisible();
  });
});

test('keyboard and screen-reader focus across row removal, reason bar, Why-this sheet and toast', async ({
  browse,
  control,
}) => {
  test.setTimeout(150_000);
  const reader = await startReader({ browse, control }, 'pwa-focus');
  await expectOnlyItems(reader);
  const { page, user } = reader;
  const quantum = titleAbout(reader, 'quantum');
  const robotics = titleAbout(reader, 'robotics');
  const firmware = titleAbout(reader, 'firmware');
  const id = {
    quantum: await idOf(user, quantum),
    robotics: await idOf(user, robotics),
    firmware: await idOf(user, firmware),
  };
  // The page announces toasts through a live region that is in it before there is a toast.
  const toasts = page.locator('[role="status"][aria-live="polite"]');
  const neverOnBody = (stops: FocusStop[]) =>
    expect(stops.filter((stop) => stop.onBody)).toEqual([]);

  await test.step('a liked row leaves, the focus goes to the next row and the toast is announced', async () => {
    await expect(toasts).toHaveCount(1);
    await expect(toasts.locator('[data-toast-id]')).toHaveCount(0);

    await page.keyboard.press('j');
    await expect(rowTitle(page, quantum)).toBeFocused();
    await recordFocus(page);
    await page.keyboard.press('+');
    await expect(rowOf(page, quantum)).toHaveCount(0);
    await expect(rowTitle(page, robotics)).toBeFocused();

    const stops = await takeFocusStops(page);
    neverOnBody(stops);
    expect(stops.map((stop) => stop.articleId)).toEqual([id.quantum, id.robotics]);

    await expect(toasts).toHaveCount(1);
    await expect(
      toasts.locator('[data-toast-id]').filter({ hasText: 'Marked as liked' }),
    ).toBeVisible();
  });

  await test.step('a disliked last row hands the focus back to the row before it, and the bar is announced', async () => {
    await page.keyboard.press('j');
    await expect(rowTitle(page, firmware)).toBeFocused();
    await takeFocusStops(page);

    await page.keyboard.press('-');
    await expect(reasonBar(page)).toBeVisible();
    await expect(
      page.locator('[aria-live="polite"]').filter({
        hasText: `Disliked: ${firmware}. Choose a reason with the keys 1 to 6, or undo.`,
      }),
    ).toBeAttached();
    await expect(rowOf(page, firmware)).toHaveCount(0);
    await expect(rowTitle(page, robotics)).toBeFocused();

    await page.keyboard.press('2');
    await expect(reasonBar(page)).toBeHidden();
    await expectState(
      user,
      id.firmware,
      { rating: -1, reason: 'clickbait' },
      'the reason is saved',
    );
    neverOnBody(await takeFocusStops(page));
  });

  await test.step('the Why-this sheet takes the focus in and gives it back to what opened it', async () => {
    const sheet = page.getByRole('dialog', { name: 'Why this?' });
    const focusInSheet = () =>
      page.evaluate(() => document.activeElement?.closest('dialog') !== null);

    // Opened with the key from the row that has the focus.
    await expect(rowTitle(page, robotics)).toBeFocused();
    await page.keyboard.press('w');
    await expect(sheet).toBeVisible();
    await expect.poll(focusInSheet).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(rowTitle(page, robotics)).toBeFocused();

    // Opened with the button of the article pane.
    await openArticle(page, robotics);
    await paneButton(page, 'Why this?').click();
    await expect(sheet).toBeVisible();
    await expect.poll(focusInSheet).toBe(true);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
    await expect(paneButton(page, 'Why this?')).toBeFocused();
    neverOnBody(await takeFocusStops(page));
  });

  await test.step('an Undo in the Recent actions sheet keeps the focus in the sheet', async () => {
    const more = page.getByRole('group', { name: 'New', exact: true }).getByRole('button', {
      name: 'More',
      exact: true,
    });
    const sheet = await openRecentActions(page, 'New');
    const entries = sheet.getByRole('listitem');
    const liked = recentEntry(sheet, 'Marked as liked', quantum);
    const disliked = recentEntry(sheet, 'Marked as disliked', firmware);
    const undoOf = (entry: ReturnType<typeof recentEntry>) =>
      entry.getByRole('button', { name: 'Undo' });

    await undoOf(liked).click();
    await expect(liked).toHaveCount(0);
    await expect(undoOf(entries.last())).toBeFocused();
    await undoOf(disliked).click();
    await expect(disliked).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('dialog') !== null))
      .toBe(true);
    await expectState(user, id.quantum, { rating: null }, 'the like is taken back');
    await expectState(user, id.firmware, { rating: null }, 'the dislike is taken back');

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await expect(rowOf(page, quantum)).toBeVisible();
    await expect(rowOf(page, firmware)).toBeVisible();
  });

  await test.step('a reason chosen in the bar leaves the focus on the row that took the disliked row’s place', async () => {
    await rowTitle(page, robotics).focus();
    await page.keyboard.press('-');
    await expect(reasonBar(page)).toBeVisible();
    await expect(rowOf(page, robotics)).toHaveCount(0);
    await expect(rowTitle(page, firmware)).toBeFocused();

    await page
      .getByRole('group', { name: 'New', exact: true })
      .getByRole('button', { name: 'More', exact: true })
      .focus();
    await recordFocus(page);
    await reasonBar(page).getByRole('button', { name: 'Clickbait' }).click();
    await expect(reasonBar(page)).toBeHidden();
    await expect(rowTitle(page, firmware)).toBeFocused();
    await expectState(
      user,
      id.robotics,
      { rating: -1, reason: 'clickbait' },
      'the reason is saved',
    );
    neverOnBody(await takeFocusStops(page));
  });

  await test.step('an Undo in the toast of a rating focuses the title of the row that comes back', async () => {
    const undoToast = () =>
      toastWith(page, 'Marked as liked').getByRole('button', { name: 'Undo', exact: true });

    await rowTitle(page, quantum).focus();
    await page.keyboard.press('+');
    await expect(rowOf(page, quantum)).toHaveCount(0);
    await undoToast().click();
    await expect(rowOf(page, quantum)).toBeVisible();
    await expect(rowTitle(page, quantum)).toBeFocused();
    await expectState(user, id.quantum, { rating: null }, 'the like is taken back by mouse');

    await rowTitle(page, firmware).focus();
    await page.keyboard.press('+');
    await expect(rowOf(page, firmware)).toHaveCount(0);
    await undoToast().focus();
    await page.keyboard.press('Enter');
    await expect(rowOf(page, firmware)).toBeVisible();
    await expect(rowTitle(page, firmware)).toBeFocused();
    await expectState(user, id.firmware, { rating: null }, 'the like is taken back by keyboard');
  });

  await test.step('Undo in the bar focuses the title of the row that comes back', async () => {
    await rowTitle(page, quantum).focus();
    await page.keyboard.press('-');
    await expect(reasonBar(page)).toBeVisible();
    await expect(rowOf(page, quantum)).toHaveCount(0);

    await reasonBar(page).getByRole('button', { name: 'Undo' }).click();
    await expect(reasonBar(page)).toBeHidden();
    await expect(rowOf(page, quantum)).toBeVisible();
    await expect(rowTitle(page, quantum)).toBeFocused();
    await expectState(user, id.quantum, { rating: null }, 'the dislike is taken back');
  });
});

test('reduced motion, browser zoom keys and input-method typing leave the reader working', async ({
  browse,
  control,
}) => {
  test.setTimeout(150_000);
  const reader = await startReader({ browse, control }, 'pwa-input');
  const { page, user } = reader;
  const context = page.context();
  const quantum = titleAbout(reader, 'quantum');
  const robotics = titleAbout(reader, 'robotics');
  const firmware = titleAbout(reader, 'firmware');
  const id = {
    quantum: await idOf(user, quantum),
    robotics: await idOf(user, robotics),
    firmware: await idOf(user, firmware),
  };
  const reducedMotion = () =>
    page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);

  async function likeAndWatchTheRowLeave(title: string, articleId: string): Promise<RowWatch> {
    await watchRow(page, articleId);
    await rowButton(page, title, 'Like').click();
    await expect
      .poll(async () => (await rowWatch(page)).gone, { message: `the row of "${title}" leaves` })
      .toBe(true);
    return rowWatch(page);
  }

  await test.step('with the usual motion the row fades out (control)', async () => {
    expect(await reducedMotion()).toBe(false);
    const watch = await likeAndWatchTheRowLeave(quantum, id.quantum);
    const opacities = watch.frames.map((frame) => Number(frame.opacity));
    expect(opacities.some((opacity) => opacity > 0 && opacity < 1)).toBe(true);
    await expectState(user, id.quantum, { rating: 1 }, 'the like is saved');
  });

  await test.step('with reduced motion the row is removed without animation, and undo still works', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await reducedMotion()).toBe(true);
    const watch = await likeAndWatchTheRowLeave(robotics, id.robotics);
    // Every frame shows the row as it was or as it is when it is out of sight, none in between.
    expect(watch.frames[0]).toMatchObject({ opacity: '1' });
    expect(watch.frames.filter((frame) => frame.opacity !== '1' && frame.opacity !== '0')).toEqual(
      [],
    );
    expect(new Set(watch.frames.map((frame) => frame.translate)).size).toBeLessThanOrEqual(2);
    await expectState(user, id.robotics, { rating: 1 }, 'the like is saved');

    await toastWith(page, 'Marked as liked').getByRole('button', { name: 'Undo' }).click();
    await expectState(user, id.robotics, { rating: null }, 'the undo takes the like back');
    await expect(rowOf(page, robotics)).toBeVisible();
  });

  await test.step('browser zoom keys are not prevented and change nothing', async () => {
    await rowTitle(page, robotics).focus();
    await recordKeys(page);
    const zoom = [
      ['Control+=', '='],
      ['Control+-', '-'],
      ['Control+0', '0'],
      ['Control++', '+'],
      ['Meta+=', '='],
      ['Meta+-', '-'],
      ['Meta+0', '0'],
      ['Meta++', '+'],
    ] as const;
    for (const [chord] of zoom) await page.keyboard.press(chord);

    const seen = await takeKeys(page);
    expect(seen.map((key) => key.key)).toEqual(zoom.map(([, key]) => key));
    expect(seen.filter((key) => key.prevented)).toEqual([]);
    expect(seen.every((key) => key.ctrl || key.meta)).toBe(true);
    await staysTrueFor(1_500, async () => {
      expect(stateOf(await fieldsOf(user, id.robotics))).toMatchObject({
        rating: null,
        bookmarkedAt: null,
      });
      await expect(toastWith(page, 'Marked as')).toHaveCount(0);
    });
    await expect(rowTitle(page, robotics)).toBeFocused();

    // The same key without the modifier is the reader's own shortcut: the keys are live, and the
    // recording shows the page taking a key when it does.
    await page.keyboard.press('+');
    await expectState(user, id.robotics, { rating: 1 }, 'the plain key likes the article');
    expect(await takeKeys(page)).toMatchObject([{ key: '+', prevented: true }]);
  });

  await test.step('typing with an input method in the search field triggers no shortcut', async () => {
    // The article is open in the pane, so a key that leaked would act on it.
    await openArticle(page, firmware);
    const opened = await expectState(
      user,
      id.firmware,
      (state) => state.readAt !== null,
      'opening reads it',
    );
    const preferences = await preferencesOf(user);
    const pages = context.pages().length;

    await page.keyboard.press('/');
    const filter = page.getByRole('textbox', { name: 'Filter feeds' });
    await expect(filter).toBeFocused();
    await recordKeys(page);
    // Every letter is a shortcut of the reader when it is not typed into a field.
    const letters = ['x', 'b', 's', 'w', 'l', 'm', 'g', 'j', 'k', 'o'];
    await typeWithInputMethod(page, letters, '日本語');

    await expect(filter).toHaveValue('日本語');
    await expect(page.getByText('No feeds match your filter.')).toBeVisible();
    const seen = await takeKeys(page);
    expect(seen).toHaveLength(letters.length);
    expect(seen.every((key) => key.keyCode === 229)).toBe(true);
    expect(seen.some((key) => key.composing)).toBe(true);
    expect(seen.filter((key) => key.prevented)).toEqual([]);

    await staysTrueFor(1_500, async () => {
      expect(stateOf(await fieldsOf(user, id.firmware))).toEqual(opened);
      expect(await preferencesOf(user)).toEqual(preferences);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page).toHaveURL(/\/read\/new$/);
      expect(context.pages()).toHaveLength(pages);
    });
    await expect(filter).toBeFocused();

    // Control: out of the field the same letter is a shortcut again.
    await page.keyboard.press('Escape');
    await filter.blur();
    await page.keyboard.press('x');
    await expectState(
      user,
      id.firmware,
      { readAt: null },
      'the plain key marks the open article unread',
    );
  });
});

test('private storage stays empty before device opt-in', async ({ browse, control }) => {
  test.setTimeout(150_000);
  const reader = await startReader({ browse, control }, 'pwa-storage');
  await expectOnlyItems(reader);
  const { page, user, email } = reader;
  const robotics = titleAbout(reader, 'robotics');
  const articles = [...(await everyArticle(user)).values()];
  // Whatever of the articles the page showed or sent must not be found in the browser's storage.
  const canaries: Canary[] = [
    ...reader.items.flatMap((item) => [
      { label: `the title of ${item.slug}`, needle: item.title },
      { label: `the summary of ${item.slug}`, needle: item.excerpt },
      { label: `the address of ${item.slug}`, needle: item.slug },
    ]),
    ...articles.flatMap((article) => [
      { label: `the id ${article.id} as a value`, needle: `"${article.id}"` },
      { label: `the id ${article.id} in an address`, needle: `/articles/${article.id}` },
    ]),
  ];
  await waitForExtraction(control, (await control.feed('tech')).url, articles.length);
  for (const article of articles) {
    // The text the detail route gives for an article: its second paragraph, past the summary.
    const lead = (await fieldsOf(user, article.id)).bodyLead?.split('\n\n')[1];
    if (lead === undefined) throw new Error(`"${article.title}" has no text of its own`);
    canaries.push({ label: `the text of ${article.id}`, needle: lead.slice(0, 60) });
  }

  await test.step('browsing, opening a detail and rating leave nothing in the browser', async () => {
    // Moving between the lanes needs no page load, so the single page keeps all it was given.
    await page.keyboard.press('g');
    await page.keyboard.press('f');
    await expect(page).toHaveURL(/\/read\/for_you$/);
    await page.keyboard.press('g');
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/\/read\/new$/);

    const pane = await openArticle(page, robotics);
    await expect(pane).toContainText(
      reader.items.find((item) => item.title === robotics)?.excerpt ?? '',
    );
    await paneButton(page, 'Like').click();
    await expectState(user, await idOf(user, robotics), { rating: 1 }, 'the like is saved');
    await expect(toastWith(page, 'Marked as liked')).toBeVisible();
    await paneButton(page, 'Why this?').click();
    await expect(page.getByRole('dialog', { name: 'Why this?' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/feeds');
    await expect(page.getByRole('heading', { level: 1, name: 'Feeds' })).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByRole('switch', { name: 'Keep articles on this device' })).toBeVisible();

    const dump = await dumpStorage(page);
    expect(canariesIn(dump, canaries)).toEqual([]);
    expect(dump.databases).not.toContain('bantoozi-offline');
    expect(dump.indexedDb).toEqual([]);
    expect(dump.cacheNames).toEqual([]);
    expect(dump.sessionStorage).toEqual([]);
    expect(
      dump.localStorage.filter((line) => line.startsWith('bantoozi:offline:enabled:')),
    ).toEqual([]);
  });

  await test.step('the search finds a title in each of the four kinds of storage', async () => {
    await plantInStorage(page, robotics);
    const found = canariesIn(await dumpStorage(page), canaries);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^indexedDB: /),
        expect.stringMatching(/^localStorage: /),
        expect.stringMatching(/^sessionStorage: /),
        expect.stringMatching(/^cacheStorage: /),
      ]),
    );
    await removePlanted(page);
    expect(canariesIn(await dumpStorage(page), canaries)).toEqual([]);
  });

  await test.step('turning on offline reading is what starts the store', async () => {
    const keep = page.getByRole('switch', { name: 'Keep articles on this device' });
    await keep.click();
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await dumpStorage(page)).databases, {
        message: 'the offline store is created',
      })
      .toContain('bantoozi-offline');
    const dump = await dumpStorage(page);
    expect(
      dump.localStorage.filter((line) => line.startsWith('bantoozi:offline:enabled:')),
    ).toHaveLength(1);
    expect(canariesIn(dump, [{ label: 'the account address', needle: email }])).toEqual([
      'indexedDB: the account address',
    ]);
  });
});

test('implicit feedback off sends no /dwell and no behavioural features on open, ratings still record, and on it sends a /dwell', async ({
  browse,
  control,
}) => {
  test.setTimeout(170_000);
  const reader = await startReader({ browse, control }, 'pwa-implicit', {
    feeds: ['science', 'culture'],
  });
  const { page, user, email } = reader;
  const exoplanet = titleAbout(reader, 'exoplanet');
  const glacier = titleAbout(reader, 'glacier');
  const enzyme = titleAbout(reader, 'enzyme');
  const orchestra = titleAbout(reader, 'orchestra');
  const id = {
    exoplanet: await idOf(user, exoplanet),
    glacier: await idOf(user, glacier),
    enzyme: await idOf(user, enzyme),
    orchestra: await idOf(user, orchestra),
  };
  const dwellRequests = watchDwellRequests(page);
  const eventsOf = async (kind: string, articleId?: string) =>
    (await feedbackEventsOf(control, email)).filter(
      (event) => event.kind === kind && (articleId === undefined || event.articleId === articleId),
    );

  await test.step('with the setting off, as it is by default, no reading time is reported', async () => {
    expect((await preferencesOf(user)).implicitFeedback).toBe(false);

    await readOriginal(page, exoplanet, id.exoplanet);
    await leaveAndComeBack(page);
    // The like is sent after the return, and the calls of an article are answered in order.
    await paneButton(page, 'Like').click();
    await expectState(user, id.exoplanet, { rating: 1 }, 'the like is saved');
    await expectPressed(paneButton(page, 'Like'), true);
    await staysTrueFor(1_500, async () => {
      expect(dwellRequests).toEqual([]);
    });

    await openArticle(page, glacier);
    await paneButton(page, 'Dislike').click();
    await reasonBar(page).getByRole('button', { name: 'Clickbait' }).click();
    await expectState(
      user,
      id.glacier,
      { rating: -1, reason: 'clickbait' },
      'the dislike and its reason are saved',
    );

    expect(await eventsOf('open')).toEqual([
      { kind: 'open', articleId: id.exoplanet, hasFeatures: false },
    ]);
    expect(await eventsOf('dwell')).toEqual([]);
    const rated = await eventsOf('rate');
    expect(new Set(rated.map((event) => event.articleId))).toEqual(
      new Set([id.exoplanet, id.glacier]),
    );
    // Only the ratings keep a snapshot of the article's features; nothing records behaviour.
    const withFeatures = (await feedbackEventsOf(control, email)).filter(
      (event) => event.hasFeatures && event.kind !== 'rate',
    );
    expect(withFeatures).toEqual([]);
  });

  await test.step('with the setting on (control) the return reports the time away', async () => {
    await setLearnFromReading(page, user, true);
    await page.goto('/read/new');
    await expect(rowOf(page, enzyme)).toBeVisible();

    await readOriginal(page, enzyme, id.enzyme);
    const reported = answerTo(page, id.enzyme, 'dwell');
    await leaveAndComeBack(page);
    expect((await reported).status(), 'the time away is accepted').toBe(200);
    expect(dwellRequests).toEqual([`/api/v1/articles/${id.enzyme}/dwell`]);

    expect(await eventsOf('open', id.enzyme)).toEqual([
      { kind: 'open', articleId: id.enzyme, hasFeatures: true },
    ]);
    expect(await eventsOf('dwell')).toEqual([
      { kind: 'dwell', articleId: id.enzyme, hasFeatures: true },
    ]);
  });

  await test.step('switched off again, the next return reports nothing', async () => {
    await setLearnFromReading(page, user, false);
    await page.goto('/read/new');
    await expect(rowOf(page, orchestra)).toBeVisible();

    await readOriginal(page, orchestra, id.orchestra);
    await leaveAndComeBack(page);
    await paneButton(page, 'Like').click();
    await expectState(user, id.orchestra, { rating: 1 }, 'the like is saved');
    await staysTrueFor(1_500, async () => {
      expect(dwellRequests).toHaveLength(1);
    });

    expect(await eventsOf('open', id.orchestra)).toEqual([
      { kind: 'open', articleId: id.orchestra, hasFeatures: false },
    ]);
    expect(await eventsOf('dwell')).toHaveLength(1);
  });
});

installedTest(
  'the app is installable: the service worker is ready, the manifest is valid with icons that load, and Chrome reports no installability error',
  async ({ installed }) => {
    const app = await installed.open(newAccount('pwa-installable'));
    const { page } = app;
    await page.goto('/read/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();

    await test.step('navigator.serviceWorker.ready resolves with the worker of the app', async () => {
      const worker = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return { scope: registration.scope, script: registration.active?.scriptURL ?? null };
      });
      expect(worker).toEqual({ scope: `${URLS.app}/`, script: `${URLS.app}/sw.js` });
    });

    await test.step('the worker controls the page that installed it, without a reload and without an update notice', async () => {
      await expect
        .poll(() => workerControls(page), {
          message: 'the worker answers for the page that installed it',
        })
        .toBe(true);
      await staysTrueFor(1_500, async () => {
        await expect(page.getByTestId('update-bar')).toHaveCount(0);
      });
    });

    await test.step('the manifest link leads to a manifest with its name, start address, display mode and icons', async () => {
      const { url, contentType, manifest } = await linkedManifest(page);
      expect(url).toBe(`${URLS.app}/manifest.webmanifest`);
      expect(contentType).toMatch(/json/);
      expect(manifest).toMatchObject({ name: 'Bantoozi', start_url: '/', display: 'standalone' });
      expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
        expect.arrayContaining(['192x192', '512x512']),
      );
      for (const icon of manifest.icons) {
        const [width = 0, height = 0] = icon.sizes.split('x').map(Number);
        expect(icon.type).toBe('image/png');
        expect(
          await decodedIconSize(page, icon.src, url),
          `the icon ${icon.src} loads at ${icon.sizes}`,
        ).toEqual({ width, height });
      }
    });

    await test.step('Chrome finds nothing in the way of installing the app', async () => {
      expect(await installabilityErrorsOf(app)).toEqual([]);
    });
  },
);

installedTest(
  'offline after opting in and one online visit, a reload shows the saved list and the opened article, and an unopened article says to connect',
  async ({ installed, control }) => {
    installedTest.setTimeout(150_000);
    const reader = await startInstalledReader({ installed, control }, 'pwa-offline');
    const { page, user } = reader;
    const quantum = titleAbout(reader, 'quantum');
    const robotics = titleAbout(reader, 'robotics');
    const excerptOf = (title: string): string =>
      reader.items.find((item) => item.title === title)?.excerpt ?? '';
    const me = await callJson<MeResponse>(user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(user)).keys()].sort();
    const quantumId = await idOf(user, quantum);

    await test.step('one online visit with the choice made leaves the list and the opened article on the device', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await openArticle(page, quantum);
      await expect
        .poll(() => savedOnDevice(page, me.id), {
          message: 'the device keeps the list and the opened article',
        })
        .toEqual({ account: true, items: articleIds, views: 1, details: [quantumId], unsent: 0 });
    });

    await test.step('with the connection gone, the reload shows the saved list at once', async () => {
      await goOffline(page);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Offline. Showing articles saved on this device at' }),
      ).toBeVisible();
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
    });

    await test.step('the article opened before shows its text, an unopened one asks for a connection', async () => {
      const opened = await openArticle(page, quantum);
      await expect(opened).toContainText(excerptOf(quantum));
      await expect(opened).not.toContainText('Connect to load this article');

      const unopened = await openArticle(page, robotics);
      await expect(
        unopened.getByText('Connect to load this article', { exact: true }),
      ).toBeVisible();
      await expect(unopened).not.toContainText(excerptOf(robotics));
    });

    await test.step('no spinner stays on the page', async () => {
      await staysTrueFor(1_500, async () => {
        await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
        await expect(page.getByText(/Loading/)).toHaveCount(0);
      });
    });
  },
);

installedTest(
  'replayed twice without Background Sync, a like made offline reaches the server once: one rating event, and the API shows it liked',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(150_000);
    const reader = await startInstalledReader({ installed, control }, 'pwa-replay');
    const { page, user, email } = reader;
    const robotics = titleAbout(reader, 'robotics');
    const robotId = await idOf(user, robotics);
    const me = await callJson<MeResponse>(user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(user)).keys()].sort();
    const device = await api.login(email);
    const sent = watchRatingRequests(page);

    await test.step('without Background Sync, one online visit with the choice made leaves the list on the device', async () => {
      await workerReady(page);
      await withoutBackgroundSync(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      expect(await backgroundSyncOf(page)).toEqual({ manager: false, registration: false });
      expect(await workerControls(page)).toBe(true);
      await expect
        .poll(() => savedOnDevice(page, me.id), { message: 'the device keeps the list' })
        .toMatchObject({ account: true, items: articleIds, views: 1 });
    });

    await test.step('offline, the like waits on the device, and a reload still shows it waiting to sync', async () => {
      await goOffline(page);
      await rowButton(page, robotics, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
      await page.reload();
      await expect(waitingToSync(page, robotics)).toBeVisible();
      await expectPressed(rowButton(page, robotics, 'Like'), true);
      await expectState(device, robotId, { rating: null }, 'the server has not heard of the like');
      expect(sent).toEqual([]);
    });

    await test.step('back online, the like is sent once, whichever way the replay is started', async () => {
      await comeBackOnline(page);
      await leaveAndComeBack(page);
      await expectState(device, robotId, { rating: 1 }, 'the like reaches the server');
      await expect(waitingToSync(page, robotics)).toBeHidden();
      await expectPressed(rowButton(page, robotics, 'Like'), true);
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'nothing is left to send',
        })
        .toBe(0);

      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
      await staysTrueFor(1_500, async () => {
        expect(await ratingEventsFor(control, email, robotId)).toHaveLength(1);
        expect(sent).toEqual([robotId]);
      });
      await expectState(device, robotId, { rating: 1 }, 'the like is still the saved rating');
    });
  },
);

installedTest(
  'a like made offline on an article this device opened online first is accepted on reconnect: the API shows it liked, with one rating event and no notice of a change on another device',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(150_000);
    const reader = await startInstalledReader({ installed, control }, 'pwa-opened');
    const { page, user, email } = reader;
    const quantum = titleAbout(reader, 'quantum');
    const quantumId = await idOf(user, quantum);
    const me = await callJson<MeResponse>(user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(user)).keys()].sort();
    const device = await api.login(email);
    const sent = watchRatingRequests(page);

    await test.step('one online visit leaves the list on the device, and opening the article reads it', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await openArticle(page, quantum);
      await expectState(
        device,
        quantumId,
        (state) => state.readAt !== null,
        'opening the article reads it',
      );
      await expect
        .poll(() => savedOnDevice(page, me.id), {
          message: 'the device keeps the list and the opened article',
        })
        .toEqual({ account: true, items: articleIds, views: 1, details: [quantumId], unsent: 0 });
    });

    await test.step('offline, the reload shows the saved list and the like waits on the device', async () => {
      await goOffline(page);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await rowButton(page, quantum, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
      expect(sent).toEqual([]);
    });

    await test.step('back online, the like reaches the server once and nothing says it was refused', async () => {
      await comeBackOnline(page);
      await expectState(device, quantumId, { rating: 1 }, 'the like reaches the server');
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'nothing is left to send',
        })
        .toBe(0);
      await staysTrueFor(1_500, async () => {
        expect(await ratingEventsFor(control, email, quantumId)).toHaveLength(1);
        expect(sent).toEqual([quantumId]);
        await expect(
          toastWith(page, "This changed on another device, so your change wasn't applied."),
        ).toHaveCount(0);
      });
    });
  },
);

installedTest(
  'a like made offline waits for sign-in when the session ended meanwhile, and signing in again as the same account sends it once',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(170_000);
    const reader = await startInstalledReader({ installed, control }, 'pwa-401');
    const { page, user, email } = reader;
    const robotics = titleAbout(reader, 'robotics');
    const robotId = await idOf(user, robotics);
    const me = await callJson<MeResponse>(user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(user)).keys()].sort();
    const device = await api.login(email);
    const sent = watchRatingRequests(page);

    await test.step('the like is made offline and kept on the device', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await expect
        .poll(() => savedOnDevice(page, me.id), { message: 'the device keeps the list' })
        .toMatchObject({ account: true, items: articleIds, views: 1 });
      await goOffline(page);
      await rowButton(page, robotics, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
    });

    await test.step('with the session ended on the server, the reconnect sends nothing and asks to sign in', async () => {
      expect(await endOtherSessions(device), 'the one session of the page is ended').toBe(1);
      await comeBackOnline(page);
      await expect(page).toHaveURL(/\/login\?redirect=%2Fread%2Fnew$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await staysTrueFor(1_500, async () => {
        expect(sent).toEqual([]);
        expect((await fieldsOf(device, robotId)).rating).toBeNull();
      });
      const kept = rowsOfAccount(await offlineRows(page), me.id, 'queue');
      expect(kept.map((row) => (row.value as { state: string }).state)).toEqual(['frozen']);
    });

    await test.step('signing in again as the same account sends the like once', async () => {
      await signInOnLoginPage(page, email);
      await expect(page).toHaveURL(/\/read\/new$/);
      await expectState(device, robotId, { rating: 1 }, 'the like reaches the server');
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'nothing is left to send',
        })
        .toBe(0);
      await staysTrueFor(1_500, async () => {
        expect(await ratingEventsFor(control, email, robotId)).toHaveLength(1);
        expect(sent).toEqual([robotId]);
      });
    });
  },
);

installedTest(
  'a change made offline more than 24 hours ago is not sent on reconnect: the person is told, and the row shows its earlier state',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(150_000);
    const email = newAccount('pwa-expiry');
    const { page } = await installed.open(email);
    await page.clock.install();
    const reader = await openReader({ page, email, control });
    const robotics = titleAbout(reader, 'robotics');
    const robotId = await idOf(reader.user, robotics);
    const me = await callJson<MeResponse>(reader.user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(reader.user)).keys()].sort();
    const device = await api.login(email);
    const sent = watchRatingRequests(page);

    await test.step('the like is made offline and kept on the device', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await expect
        .poll(() => savedOnDevice(page, me.id), { message: 'the device keeps the list' })
        .toMatchObject({ account: true, items: articleIds, views: 1 });
      await goOffline(page);
      await rowButton(page, robotics, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
    });

    await test.step('a day and an hour later, the reconnect drops the like and says so', async () => {
      await page.clock.fastForward('25:00:00');
      await comeBackOnline(page);
      await expect(toastWith(page, '1 offline change expired and was not sent')).toBeVisible();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the expired like is gone from the device',
        })
        .toBe(0);
    });

    await test.step('the row is back as it was, and the server never heard of the like', async () => {
      const row = rowOf(page, robotics);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Unread');
      await expect(waitingToSync(page, robotics)).toBeHidden();
      await expectPressed(rowButton(page, robotics, 'Like'), false);
      await staysTrueFor(1_500, async () => {
        expect(sent).toEqual([]);
        expect(await ratingEventsFor(control, email, robotId)).toEqual([]);
        expect((await fieldsOf(device, robotId)).rating).toBeNull();
      });
    });
  },
);

installedTest(
  'a like made offline is refused when another device rated the article meanwhile: the person is told, the dislike stays, and the next replay sends nothing',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(150_000);
    // With "mark read on rating" off, a rated article stays in the unread list, so the row can show
    // what the server holds once the list is loaded again.
    const reader = await startInstalledReader({ installed, control }, 'pwa-conflict', {
      preferences: { markReadOnRate: false },
    });
    const { page, user, email } = reader;
    const robotics = titleAbout(reader, 'robotics');
    const robotId = await idOf(user, robotics);
    const me = await callJson<MeResponse>(user, 'GET', '/api/v1/me');
    const articleIds = [...(await everyArticle(user)).keys()].sort();
    const device = await api.login(email);
    const sent = watchRatingRequests(page);

    await test.step('the like is made offline and kept on the device', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
      await expect
        .poll(() => savedOnDevice(page, me.id), { message: 'the device keeps the list' })
        .toMatchObject({ account: true, items: articleIds, views: 1 });
      await goOffline(page);
      await rowButton(page, robotics, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
    });

    await test.step('another device dislikes the article, and the reconnect refuses the like in words', async () => {
      await rateFromAnotherDevice(device, robotId, -1);
      await comeBackOnline(page);
      await expect(
        toastWith(page, "This changed on another device, so your change wasn't applied."),
      ).toBeVisible();
      await expectState(device, robotId, { rating: -1 }, 'the dislike is the saved rating');
      await expect
        .poll(async () => (await savedOnDevice(page, me.id)).unsent, {
          message: 'the refused like is gone from the device',
        })
        .toBe(0);
    });

    await test.step('the list shows the dislike, and no later replay sends anything', async () => {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(rowOf(page, robotics)).toBeVisible();
      await expectPressed(rowButton(page, robotics, 'Dislike'), true);
      await expectPressed(rowButton(page, robotics, 'Like'), false);

      await leaveAndComeBack(page);
      await page.reload();
      await expect(rowOf(page, robotics)).toBeVisible();
      await expectPressed(rowButton(page, robotics, 'Dislike'), true);
      await staysTrueFor(1_500, async () => {
        expect(sent).toEqual([robotId]);
        expect(await ratingEventsFor(control, email, robotId)).toHaveLength(1);
      });
      await expectState(device, robotId, { rating: -1 }, 'the dislike is still the saved rating');
    });
  },
);

installedTest(
  'signing in as another account in the same browser shows nothing of the first, and deleting an account leaves no private store of it',
  async ({ installed, control, api }) => {
    installedTest.setTimeout(240_000);
    const a = await startInstalledReader({ installed, control }, 'pwa-isolation-a');
    const { page } = a;
    const quantum = titleAbout(a, 'quantum');
    const robotics = titleAbout(a, 'robotics');
    const meA = await callJson<MeResponse>(a.user, 'GET', '/api/v1/me');
    const idsOfA = [...(await everyArticle(a.user)).keys()].sort();
    const quantumId = await idOf(a.user, quantum);
    const roboticsId = await idOf(a.user, robotics);
    const deviceA = await api.login(a.email);
    const b = await accountFollowing({ api, control }, 'pwa-isolation-b', 'science');
    const exoplanet = titleAbout(b, 'exoplanet');
    const sent = watchRatingRequests(page);
    const traceOfA = { id: meA.id, email: a.email, items: a.items };
    const traceOfB = { id: b.id, email: b.email, items: b.items };

    await test.step('A keeps a list, an opened article and a like on the device, and signs out offline', async () => {
      await workerReady(page);
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of a.items) await expect(rowOf(page, item.title)).toBeVisible();
      await openArticle(page, quantum);
      await paneButton(page, 'Why this?').click();
      await expect(page.getByRole('dialog', { name: 'Why this?' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await workerControls(page)).toBe(true);
      await expect
        .poll(() => savedOnDevice(page, meA.id), {
          message: 'the device keeps the list and the opened article',
        })
        .toEqual({ account: true, items: idsOfA, views: 1, details: [quantumId], unsent: 0 });
      expect(tracesOfAccount(await dumpStorage(page), traceOfA)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^indexedDB: /)]),
      );

      await goOffline(page);
      await rowButton(page, robotics, 'Like').click();
      await expect
        .poll(async () => (await savedOnDevice(page, meA.id)).unsent, {
          message: 'the like is kept on the device',
        })
        .toBe(1);
      await signOut(page);
      await expect(toastWith(page, 'Signed out on this device.')).toBeVisible();
      await expect
        .poll(() => offlineRows(page), { message: 'nothing of A stays in the offline database' })
        .toEqual([]);
    });

    await test.step('back online, B signs in through the login page and nothing of A shows', async () => {
      await comeBackOnline(page);
      await expect(toastWith(page, 'Signed out on this device.')).toBeVisible();
      await signInOnLoginPage(page, b.email);
      await expect(page.getByRole('heading', { level: 1, name: 'For you' })).toBeVisible();
      await expect(
        page.locator('[data-toast-id]'),
        'no toast of A survives the sign-in of B',
      ).toHaveCount(0);

      await page.getByRole('link', { name: /^New/ }).click();
      for (const item of b.items) await expect(rowOf(page, item.title)).toBeVisible();
      for (const item of a.items) await expect(page.getByText(item.title)).toHaveCount(0);
      await expect(articlePane(page)).toContainText('Select an article to read it here.');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Waiting to sync')).toHaveCount(0);

      await expect
        .poll(() => otherSessionCount(deviceA), { message: 'the sign-out of A reaches the server' })
        .toBe(0);
      await staysTrueFor(1_500, async () => {
        expect(sent).toEqual([]);
        expect((await fieldsOf(deviceA, roboticsId)).rating).toBeNull();
        expect(await ratingEventsFor(control, a.email, roboticsId)).toEqual([]);
        expect((await callJson<MeResponse>(page.request, 'GET', '/api/v1/me')).email).toBe(b.email);
      });

      const dump = await dumpStorage(page);
      expect(tracesOfAccount(dump, traceOfA)).toEqual([]);
      expect(dump.indexedDb).toEqual([]);
    });

    await test.step('B keeps a list and an opened article on the device, then deletes the account', async () => {
      await keepArticlesOnThisDevice(page);
      await page.goto('/read/new');
      for (const item of b.items) await expect(rowOf(page, item.title)).toBeVisible();
      await openArticle(page, exoplanet);
      const exoplanetId = await idOf(page.request, exoplanet);
      await expect
        .poll(() => savedOnDevice(page, b.id), {
          message: 'the device keeps the list and the opened article',
        })
        .toMatchObject({ account: true, views: 1, details: [exoplanetId], unsent: 0 });
      expect(tracesOfAccount(await dumpStorage(page), traceOfB)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^indexedDB: /)]),
      );

      await deleteAccountInSettings(page, b.email);
      await expect(toastWith(page, 'Your account is deleted.')).toBeVisible();
      await expect
        .poll(() => offlineRows(page), { message: 'nothing of B stays in the offline database' })
        .toEqual([]);
      const dump = await dumpStorage(page);
      expect(tracesOfAccount(dump, traceOfB)).toEqual([]);
      expect(tracesOfAccount(dump, traceOfA)).toEqual([]);
      expect(dump.indexedDb).toEqual([]);
      expect(dump.sessionStorage).toEqual([]);
      expect(
        dump.localStorage.filter(
          (line) =>
            line.startsWith('bantoozi:offline:') && !line.startsWith('bantoozi:offline:enabled:'),
        ),
      ).toEqual([]);
      expect(dump.cacheNames.filter((name) => !name.startsWith('workbox-precache'))).toEqual([]);
      const requested = dump.cacheStorage
        .filter((line) => / GET http/.test(line))
        .map((line) => new URL(line.slice(line.indexOf(' GET ') + 5)).pathname);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.filter((path) => path.startsWith('/api/'))).toEqual([]);
      expect(sent).toEqual([]);
    });
  },
);
