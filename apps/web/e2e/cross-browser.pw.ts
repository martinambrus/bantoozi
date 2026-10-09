import { expectState, idOf } from './pwa-support/api.js';
import { ratingEventsFor } from './pwa-support/hooks.js';
import { signInOnLoginPage, signOut } from './pwa-support/login.js';
import {
  backgroundSyncOf,
  comeBackOnline,
  goOffline,
  keepArticlesOnThisDevice,
  watchRatingRequests,
  withoutBackgroundSync,
} from './pwa-support/offline.js';
import { expectPressed, openReader, rowButton, titleAbout } from './pwa-support/reader.js';
import { newAccount } from './reader-support/accounts.js';
import { rowOf } from './reader-support/ui.js';
import { staysTrueFor } from './reader-support/wait.js';
import { call } from './support/api.js';
import { expect, test } from './support/test.js';

/**
 * Spec 01 §1: the critical auth and offline flows in every engine CI runs (Chromium, Firefox,
 * WebKit). Only the `page` and `browse.as` fixtures and what every engine has: no DevTools
 * Protocol, no persistent profile, no service worker.
 */

test('a person signs in with a code through the login page, reaches the reader and signs out', async ({
  page,
  browse,
}) => {
  const email = newAccount('cross-login');
  // Creates the account and ends its first-run wizard; the `page` fixture signs in on its own.
  await browse.as(email);

  await page.goto('/login');
  await signInOnLoginPage(page, email);
  await expect(page.getByRole('heading', { level: 1, name: 'For you' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Account menu: ${email}` })).toBeVisible();
  expect((await call(page.request, 'GET', '/api/v1/me')).status()).toBe(200);

  await signOut(page);
  // The device is signed out before the server answers; its session ends once the answer is in.
  await expect.poll(async () => (await call(page.request, 'GET', '/api/v1/me')).status()).toBe(401);
});

test('a like made offline is sent once when the connection returns without a reload, and the row shows it liked', async ({
  browse,
  control,
}) => {
  test.setTimeout(120_000);
  const email = newAccount('cross-offline');
  const page = await browse.as(email);
  await withoutBackgroundSync(page);
  // With "mark read on rating" off, a rated article stays in the unread list, so its row can show
  // what the server holds once the list is loaded again.
  const reader = await openReader(
    { page, email, control },
    { preferences: { markReadOnRate: false } },
  );
  const robotics = titleAbout(reader, 'robotics');
  const roboticsId = await idOf(reader.user, robotics);
  const sent = watchRatingRequests(page);

  await keepArticlesOnThisDevice(page);
  await page.goto('/read/new');
  for (const item of reader.items) await expect(rowOf(page, item.title)).toBeVisible();
  expect(await backgroundSyncOf(page)).toEqual({ manager: false, registration: false });
  await page.evaluate(() => Object.assign(window, { sameDocument: true }));

  await goOffline(page);
  await rowButton(page, robotics, 'Like').click();
  await comeBackOnline(page);
  await expectState(reader.user, roboticsId, { rating: 1 }, 'the like reaches the server');
  expect(await page.evaluate(() => 'sameDocument' in window), 'the page was not reloaded').toBe(
    true,
  );

  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(rowOf(page, robotics)).toBeVisible();
  await expectPressed(rowButton(page, robotics, 'Like'), true);
  await staysTrueFor(1_500, async () => {
    expect(await ratingEventsFor(control, email, roboticsId)).toHaveLength(1);
    expect(sent).toEqual([roboticsId]);
  });
});
