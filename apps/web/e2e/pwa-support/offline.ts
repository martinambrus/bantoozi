import type { Locator, Page } from '@playwright/test';

import { rowOf } from '../reader-support/ui.js';
import { expect } from '../support/test.js';

/**
 * What the PWA check does about reading offline (spec 09 §1): the choice to keep articles on the
 * device, the connection that goes away, and what the page shows and sends meanwhile.
 */

/** Settings → "Keep articles on this device": switched on, and the device has taken the choice. */
export async function keepArticlesOnThisDevice(page: Page): Promise<void> {
  await page.goto('/settings');
  const keep = page.getByRole('switch', { name: 'Keep articles on this device' });
  await expect(keep).toBeVisible();
  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
}

/**
 * The page is opened as it is in a browser without Background Sync (Firefox, Safari): neither
 * `SyncManager` nor `registration.sync` exists. Takes effect from the next load of the page.
 */
export async function withoutBackgroundSync(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'SyncManager');
    if (typeof ServiceWorkerRegistration !== 'undefined') {
      Reflect.deleteProperty(ServiceWorkerRegistration.prototype, 'sync');
    }
  });
}

/** Whether the page can still reach Background Sync. */
export function backgroundSyncOf(page: Page): Promise<{ manager: boolean; registration: boolean }> {
  return page.evaluate(() => ({
    manager: 'SyncManager' in window,
    registration:
      typeof ServiceWorkerRegistration !== 'undefined' &&
      'sync' in ServiceWorkerRegistration.prototype,
  }));
}

/** The note on a row that says its change has not been sent yet. */
export function waitingToSync(page: Page, title: string): Locator {
  return rowOf(page, title).getByText('Waiting to sync', { exact: true });
}

/**
 * The articles whose rating the page sends from now on (`POST /articles/:id/rating`), one entry per
 * request, in the order they were made.
 */
export function watchRatingRequests(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    const articleId = /^\/api\/v1\/articles\/([^/]+)\/rating$/.exec(pathname)?.[1];
    if (request.method() === 'POST' && articleId !== undefined) sent.push(articleId);
  });
  return sent;
}

const OFFLINE_BANNER = "You're offline. Some features need a connection.";

/** The connection goes away, and the reader has noticed: it says so above the page. */
export async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await expect(page.getByText(OFFLINE_BANNER)).toBeVisible();
}

/** The connection is back, and the reader has noticed: the banner is gone. */
export async function comeBackOnline(page: Page): Promise<void> {
  await page.context().setOffline(false);
  await expect(page.getByText(OFFLINE_BANNER)).toBeHidden();
}

/** The service worker of the page is active: its install and the precache of the shell are done. */
export async function workerReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

/** Whether a service worker controls this page: the first one claims the page that installs it. */
export function workerControls(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.serviceWorker.controller !== null);
}
