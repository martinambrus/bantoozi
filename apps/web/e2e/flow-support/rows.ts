import type { Locator, Page } from '@playwright/test';

import { refreshUntil, rowOf } from '../reader-support/ui.js';
import { expect } from '../support/test.js';

/**
 * The rows of the reader's list as a person meets them. A wide screen shows the open article beside
 * the list and its action bar has the same buttons as a row, so every query that acts on one article
 * is scoped to its row: the `article` element named by the title.
 */

/** The row of an article, found by its exact title. */
export function articleRow(page: Page, title: string): Locator {
  return page.getByRole('article', { name: title, exact: true });
}

/** The title of a row: the button that opens the article, and the one `j` and `k` focus. */
export function titleButton(page: Page, title: string): Locator {
  return articleRow(page, title).getByRole('button', { name: title, exact: true });
}

/** A button of a row (Like, Dislike, Bookmark). */
export function rowButton(page: Page, title: string, name: 'Like' | 'Dislike' | 'Bookmark') {
  return articleRow(page, title).getByRole('button', { name, exact: true });
}

/** The group that asks for the reason of a dislike. */
export function reasonBar(page: Page): Locator {
  return page.getByRole('group', { name: 'Reason for the dislike' });
}

/** The toast that says what was done to an article; it carries the Undo button. */
export function toastSaying(page: Page, message: string): Locator {
  return page.getByRole('status').filter({ hasText: message });
}

/**
 * Opens the New lane and presses Refresh until every one of `titles` is listed: a feed that was
 * just subscribed to reaches the list a few seconds later, and an idle list is not polled.
 */
export async function openNewLane(page: Page, titles: readonly string[]): Promise<void> {
  await page.goto('/read/new');
  await expect(page.getByRole('heading', { level: 1, name: 'New' })).toBeVisible();
  await refreshUntil(page, async () => {
    for (const title of titles) await expect(rowOf(page, title)).toBeVisible({ timeout: 1_500 });
  });
}

/** The titles of the rows that are in the list now, top to bottom. */
export async function rowTitles(page: Page): Promise<string[]> {
  return page.locator('li[data-article-id] h3 button').allInnerTexts();
}

/** At least `count` rows are in the list; returns their titles, top to bottom. */
export async function waitForRows(page: Page, count: number): Promise<string[]> {
  await expect
    .poll(async () => (await rowTitles(page)).length, { message: `${count} rows in the list` })
    .toBeGreaterThanOrEqual(count);
  return rowTitles(page);
}
