import type { APIRequestContext, Page, Response } from '@playwright/test';

import { openArticle } from '../reader-support/ui.js';
import { expect } from '../support/test.js';

import { preferencesOf } from './api.js';

/**
 * What the PWA check does around "Learn from how I read" (spec 09 §3.6): the reading time the
 * page reports after "Read original", and the setting that allows it.
 */

/** The paths of the reading-time reports (`POST /articles/:id/dwell`) the page sends from now on. */
export function watchDwellRequests(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST' && /^\/api\/v1\/articles\/[^/]+\/dwell$/.test(pathname)) {
      sent.push(pathname);
    }
  });
  return sent;
}

/** The answer to the call of one article that the reader's actions make. */
export function answerTo(
  page: Page,
  articleId: string,
  action: 'open' | 'dwell',
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/articles/${articleId}/${action}`,
  );
}

/**
 * Opens the article and presses "Read original": the original opens in a tab of its own, which is
 * closed again, and the page records that the reader opened it.
 */
export async function readOriginal(page: Page, title: string, articleId: string): Promise<void> {
  const pane = await openArticle(page, title);
  const opened = answerTo(page, articleId, 'open');
  const tab = page.context().waitForEvent('page');
  await pane.getByRole('button', { name: 'Read original', exact: true }).click();
  const original = await tab;
  expect((await opened).status(), 'the page records the opening').toBe(200);
  await original.close();
}

/**
 * Sets "Learn from how I read" on the Settings page and waits until the server keeps the new
 * value (the switch moves at once, before the save).
 */
export async function setLearnFromReading(
  page: Page,
  user: APIRequestContext,
  on: boolean,
): Promise<void> {
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Learn from how I read', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await expect
    .poll(async () => (await preferencesOf(user)).implicitFeedback, {
      message: `the server keeps "Learn from how I read" ${on ? 'on' : 'off'}`,
      timeout: 10_000,
    })
    .toBe(on);
}
