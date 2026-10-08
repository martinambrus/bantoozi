import type { APIRequestContext, Locator } from '@playwright/test';

import { newAccount } from './reader-support/accounts.js';
import {
  articleByTitle,
  articleDetail,
  feedPreferencesOf,
  meOf,
  subscribe,
  subscriptionsOf,
  waitForExtraction,
  type SubscriptionView,
} from './reader-support/api.js';
import {
  expectNoNewImageRequests,
  imageRequests,
  requestsFor,
  WORKER_AGENT,
} from './reader-support/origin.js';
import {
  articlePane,
  chooseFeedImages,
  expectImageLoaded,
  gotoFeeds,
  openArticle,
  refreshUntil,
  rowOf,
  setGlobalImages,
  unsubscribeFrom,
} from './reader-support/ui.js';
import { callJson } from './support/api.js';
import type { FeedItem } from './support/control.js';
import { expect, test } from './support/test.js';

/** What the open article says where the images of its feed are not loaded. */
const NOT_LOADED = "Images from this feed aren't loaded.";

interface ImageItem {
  title: string;
  /** Where the publisher's server keeps its image. */
  imagePath: string;
}

/** The one item of a fixture feed that comes with an image. */
function imageItemOf(items: readonly FeedItem[], slug: string): ImageItem {
  const item = items.find((candidate) => candidate.slug === slug);
  if (item === undefined || item.imageUrl === null) {
    throw new Error(`the fixture item ${slug} has no image`);
  }
  return { title: item.title, imagePath: new URL(item.imageUrl).pathname };
}

/** Whether the server lets the open article show images: the value its body is rendered with. */
async function detailAllowsImages(user: APIRequestContext, articleId: string): Promise<boolean> {
  return (await articleDetail(user, articleId)).effectiveImagesAllowed;
}

async function subscriptionOf(user: APIRequestContext, feedId: string): Promise<SubscriptionView> {
  const found = (await subscriptionsOf(user)).find(({ feed }) => feed.id === feedId);
  if (found === undefined) throw new Error(`no subscription to the feed ${feedId}`);
  return found;
}

/**
 * The image of a list row (not its feed icon). Embedded images never reach the stored text of an
 * article in the beta (spec 03 §6.3), so this thumbnail is where the reader sees whether images are
 * loaded; the open article shows the same decision as the "aren't loaded" note.
 */
function thumbnail(row: Locator, item: ImageItem): Locator {
  return row.locator(`img[src$="${item.imagePath}"]`);
}

/**
 * Spec 09 §9, scenario 9: a feed's own image choice beats the global setting and survives a new
 * browser and an unsubscribe in the saved copy of a bookmark; and while images are blocked nothing,
 * not even a placeholder, asks the publisher for one.
 */
test('remembered images: the feed choice beats the global setting and outlives the subscription', async ({
  browse,
  control,
}) => {
  test.setTimeout(180_000);

  const email = newAccount('remembered-images');
  const science = await control.feed('science');
  const culture = await control.feed('culture');
  const glacier = imageItemOf(science.items, 'science-glacier');
  const cinema = imageItemOf(culture.items, 'culture-cinema');
  const page = await browse.as(email);
  const user = page.request;
  // An article that is opened stays unread, and so stays in the unread-only lists the steps use.
  await callJson(user, 'PATCH', '/api/v1/me', {
    data: { preferences: { markReadOnExpand: false } },
  });

  await setGlobalImages(page, false);
  const subscription = await subscribe(user, science.url);
  await waitForExtraction(control, science.url, 3);
  const glacierArticle = await articleByTitle(user, glacier.title);

  await test.step('with the global setting off, a feed that follows it loads no image', async () => {
    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, glacier.title)).toBeVisible({ timeout: 1_500 });
    });
    await expect(rowOf(page, glacier.title).locator('img')).toHaveCount(0);
    const pane = await openArticle(page, glacier.title);
    await expect(pane.getByText(NOT_LOADED)).toBeVisible();
    await expect(pane.locator('img')).toHaveCount(0);
    expect(await detailAllowsImages(user, glacierArticle.id)).toBe(false);
    await expectNoNewImageRequests(control, 'science');
    expect(await imageRequests(control, 'science')).toEqual([]);
  });

  await test.step('Always allow on the feed loads its images although the global setting is off', async () => {
    await gotoFeeds(page);
    await chooseFeedImages(page, science.title, 'Always allow');
    expect((await meOf(user)).preferences.loadRemoteImages).toBe(false);
    expect(await feedPreferencesOf(user)).toEqual([
      { feedId: subscription.feed.id, imagePolicy: 'allow', effectiveImagesAllowed: true },
    ]);

    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, glacier.title)).toBeVisible({ timeout: 1_500 });
    });
    await expectImageLoaded(thumbnail(rowOf(page, glacier.title), glacier));
    // The reader's own browser asked the publisher for it, without telling where it was reading.
    const requests = await requestsFor(control, 'science', glacier.imagePath);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.userAgent ?? '').not.toMatch(WORKER_AGENT);
      expect(request.referer).toBeNull();
    }

    const pane = await openArticle(page, glacier.title);
    await expect(pane.getByRole('button', { name: 'Read original' })).toBeVisible();
    await expect(pane.getByText(NOT_LOADED)).toHaveCount(0);
    expect(await detailAllowsImages(user, glacierArticle.id)).toBe(true);
  });

  await test.step('bookmark the article', async () => {
    const pane = articlePane(page);
    await pane.getByRole('button', { name: 'Bookmark' }).click();
    // A capture that is still pending is asked for again every 30 seconds (spec 09 §3.2).
    await expect(pane).toContainText('Full text saved', { timeout: 75_000 });
  });

  const askedBeforeFreshBrowser = (await requestsFor(control, 'science', glacier.imagePath)).length;
  await test.step('a fresh browser keeps the choice in the saved view of the bookmark', async () => {
    const fresh = await browse.as(email);
    await fresh.goto('/read/bookmarks');
    const row = rowOf(fresh, glacier.title);
    await expect(row).toBeVisible();
    await expectImageLoaded(thumbnail(row, glacier));
    // It has no cache of the first browser: the publisher is asked again, by this browser.
    expect((await requestsFor(control, 'science', glacier.imagePath)).length).toBeGreaterThan(
      askedBeforeFreshBrowser,
    );
    const pane = await openArticle(fresh, glacier.title);
    await expect(pane).toContainText('Full text saved');
    await expect(pane.getByText(NOT_LOADED)).toHaveCount(0);

    await fresh.goto('/settings');
    const exceptions = fresh.getByRole('list', { name: 'Feeds with their own image setting' });
    await expect(exceptions.getByRole('listitem').filter({ hasText: science.title })).toContainText(
      'Always show images',
    );
  });

  await test.step('after unsubscribing, the saved view still allows the images of that source', async () => {
    await gotoFeeds(page);
    await unsubscribeFrom(page, science.title);
    expect(await subscriptionsOf(user)).toEqual([]);

    const later = await browse.as(email);
    const asked = (await requestsFor(control, 'science', glacier.imagePath)).length;
    await later.goto('/read/bookmarks');
    const row = rowOf(later, glacier.title);
    await expect(row).toBeVisible();
    await expectImageLoaded(thumbnail(row, glacier));
    expect((await requestsFor(control, 'science', glacier.imagePath)).length).toBeGreaterThan(
      asked,
    );
    const pane = await openArticle(later, glacier.title);
    await expect(pane).toContainText('Full text saved');
    await expect(pane.getByText(NOT_LOADED)).toHaveCount(0);

    await later.goto('/settings');
    const exceptions = later.getByRole('list', { name: 'Feeds with their own image setting' });
    await expect(exceptions.getByRole('listitem')).toHaveCount(1);
    await expect(exceptions.getByRole('listitem')).toContainText('A feed you no longer follow');
    await expect(exceptions.getByRole('listitem')).toContainText('Always show images');

    // What the server remembers, and the frozen source of the saved copy.
    expect(await feedPreferencesOf(user)).toEqual([
      { feedId: subscription.feed.id, imagePolicy: 'allow', effectiveImagesAllowed: true },
    ]);
    const saved = (await articleDetail(user, glacierArticle.id, true)).bookmarkSnapshot;
    expect(saved).toMatchObject({
      mediaPolicyFeedId: subscription.feed.id,
      effectiveImagesAllowed: true,
    });
  });

  await setGlobalImages(page, true);
  const followed = await subscribe(user, culture.url);
  await waitForExtraction(control, culture.url, 3);
  const cinemaArticle = await articleByTitle(user, cinema.title);
  await test.step('with the global setting on, a feed that follows it loads its images', async () => {
    expect(followed).toMatchObject({ imagePolicy: 'inherit', effectiveImagesAllowed: true });

    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, cinema.title)).toBeVisible({ timeout: 1_500 });
    });
    await expectImageLoaded(thumbnail(rowOf(page, cinema.title), cinema));
    expect((await requestsFor(control, 'culture', cinema.imagePath)).length).toBeGreaterThan(0);
    expect(await detailAllowsImages(user, cinemaArticle.id)).toBe(true);
  });

  await test.step('Always block on the feed beats the global setting, and nothing asks for an image', async () => {
    await gotoFeeds(page);
    await chooseFeedImages(page, culture.title, 'Always block');
    expect((await meOf(user)).preferences.loadRemoteImages).toBe(true);
    expect(await subscriptionOf(user, followed.feed.id)).toMatchObject({
      imagePolicy: 'block',
      effectiveImagesAllowed: false,
    });

    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, cinema.title)).toBeVisible({ timeout: 1_500 });
    });
    await expect(rowOf(page, cinema.title).locator('img')).toHaveCount(0);
    const pane = await openArticle(page, cinema.title);
    await expect(pane.getByText(NOT_LOADED)).toBeVisible();
    await expect(pane.locator('img')).toHaveCount(0);
    expect(await detailAllowsImages(user, cinemaArticle.id)).toBe(false);
    await expectNoNewImageRequests(control, 'culture');
  });

  await test.step('Use global setting follows the global value in both directions', async () => {
    const pane = articlePane(page);
    await pane.getByRole('button', { name: 'Use global setting' }).click();
    await expect(page.getByText('Image setting saved')).toBeVisible();
    await expect(pane.getByText(NOT_LOADED)).toHaveCount(0);
    await expectImageLoaded(thumbnail(rowOf(page, cinema.title), cinema));
    expect(await subscriptionOf(user, followed.feed.id)).toMatchObject({
      imagePolicy: 'inherit',
      effectiveImagesAllowed: true,
    });
    expect(await detailAllowsImages(user, cinemaArticle.id)).toBe(true);

    await setGlobalImages(page, false);
    await page.goto('/read/new');
    await refreshUntil(page, async () => {
      await expect(rowOf(page, cinema.title)).toBeVisible({ timeout: 1_500 });
    });
    await expect(rowOf(page, cinema.title).locator('img')).toHaveCount(0);
    const closed = await openArticle(page, cinema.title);
    await expect(closed.getByText(NOT_LOADED)).toBeVisible();
    expect(await subscriptionOf(user, followed.feed.id)).toMatchObject({
      imagePolicy: 'inherit',
      effectiveImagesAllowed: false,
    });
    expect(await detailAllowsImages(user, cinemaArticle.id)).toBe(false);
    await expectNoNewImageRequests(control, 'culture');
  });
});
