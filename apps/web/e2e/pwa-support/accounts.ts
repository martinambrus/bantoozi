import type { Page } from '@playwright/test';

import { newAccount } from '../reader-support/accounts.js';
import { subscribe } from '../reader-support/api.js';
import { callJson, type MeResponse } from '../support/api.js';
import type { Control, FeedItem } from '../support/control.js';
import type { FeedKey } from '../support/env.js';
import { expect, type Api } from '../support/test.js';

import { waitForTitles } from './api.js';

/**
 * Accounts as the PWA check uses them: one that is ready to sign in on a page, and the deletion
 * that Settings offers.
 */

export interface ReadyAccount {
  email: string;
  id: string;
  /** The items of the feed it follows, all of them already among its articles. */
  items: FeedItem[];
}

/**
 * A new account that has finished the first-run wizard and follows one fixture feed. No browser is
 * signed in as it yet; the page signs in through the login page.
 */
export async function accountFollowing(
  { api, control }: { api: Api; control: Control },
  label: string,
  feed: FeedKey,
): Promise<ReadyAccount> {
  const email = newAccount(label);
  const session = await api.login(email);
  await callJson<unknown>(session, 'PATCH', '/api/v1/me', {
    data: { preferences: { onboardingCompletedAt: new Date().toISOString() } },
  });
  const view = await control.feed(feed);
  await subscribe(session, view.url);
  await waitForTitles(
    session,
    view.items.map((item) => item.title),
  );
  const me = await callJson<MeResponse>(session, 'GET', '/api/v1/me');
  return { email, id: me.id, items: view.items };
}

/** Settings → Delete account, with the address typed to confirm; returns on the login page. */
export async function deleteAccountInSettings(page: Page, email: string): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Delete my account…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await dialog.getByLabel(`Type ${email} to confirm`).fill(email);
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
}
