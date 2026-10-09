import type { Locator, Page } from '@playwright/test';

import { expect } from '../support/test.js';

import { meOf } from './api.js';

/**
 * What a reader does in the PWA, as steps the scenarios share. They use roles and visible names, not
 * the markup, and wait for the screen to show the result rather than for time to pass.
 */

export async function gotoFeeds(page: Page): Promise<void> {
  await page.goto('/feeds');
  await expect(page.getByRole('heading', { level: 1, name: 'Feeds' })).toBeVisible();
}

/** Adds a feed on the Feeds page and waits for the confirmation. */
export async function addFeed(page: Page, feedUrl: string, feedTitle: string): Promise<void> {
  await page.getByLabel('Website or feed address').fill(feedUrl);
  await page.getByRole('button', { name: 'Add feed' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added' })).toHaveText(
    `Added “${feedTitle}”.`,
  );
}

/** The row of a feed on the Feeds page. */
export function feedRow(page: Page, feedTitle: string): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name: feedTitle, exact: true }) });
}

/** Opens the settings sheet of a feed (the page is the Feeds page). */
export async function openFeedSettings(page: Page, feedTitle: string): Promise<Locator> {
  await page.getByRole('button', { name: `Settings for ${feedTitle}`, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Feed settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

export type ImageChoice = 'Use my global setting' | 'Always allow' | 'Always block';

/** Picks the feed's image setting in its settings sheet and saves it. */
export async function chooseFeedImages(
  page: Page,
  feedTitle: string,
  choice: ImageChoice,
): Promise<void> {
  const sheet = await openFeedSettings(page, feedTitle);
  await sheet.getByRole('radio', { name: choice, exact: true }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Saved the settings of “${feedTitle}”.`)).toBeVisible();
  await expect(sheet).toBeHidden();
}

/** Unsubscribes from a feed through its settings sheet and the question that follows. */
export async function unsubscribeFrom(page: Page, feedTitle: string): Promise<void> {
  const sheet = await openFeedSettings(page, feedTitle);
  await sheet.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  const question = page.getByRole('dialog', { name: `Unsubscribe from “${feedTitle}”?` });
  await question.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(page.getByText(`Unsubscribed from “${feedTitle}”.`)).toBeVisible();
  await expect(feedRow(page, feedTitle)).toHaveCount(0);
}

/** One article of a list, found by its title. */
export function rowOf(page: Page, title: string): Locator {
  return page
    .locator('li[data-article-id]')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
}

/** The article beside the list (a wide screen). */
export function articlePane(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Article' });
}

/** Opens an article of the list by its title and waits for its pane. */
export async function openArticle(page: Page, title: string): Promise<Locator> {
  await page.getByRole('button', { name: title, exact: true }).click();
  const pane = articlePane(page);
  await expect(pane.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible();
  return pane;
}

/**
 * Presses Refresh until `check` passes. An idle list is not polled, so a reader who waits for a new
 * article presses Refresh (spec 09 §1); `check` needs only a short timeout of its own.
 */
export async function refreshUntil(
  page: Page,
  check: () => Promise<void>,
  timeoutMs = 45_000,
): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await check();
  }).toPass({ timeout: timeoutMs, intervals: [500, 1_000, 2_000] });
}

/** An `<img>` the browser has fetched and decoded. */
export async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toHaveCount(1);
  // A list loads its thumbnails as they come near the screen, so a row far down must be scrolled to.
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
      { message: 'the image has loaded', timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

/**
 * Sets "Load images from publishers' websites" on the Settings page and waits until the server
 * keeps the new value (the switch moves at once, before the save).
 */
export async function setGlobalImages(page: Page, on: boolean): Promise<void> {
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: "Load images from publishers' websites" });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await expect
    .poll(async () => (await meOf(page.request)).preferences.loadRemoteImages, {
      message: `the server keeps "load remote images" ${on ? 'on' : 'off'}`,
      timeout: 10_000,
    })
    .toBe(on);
}
