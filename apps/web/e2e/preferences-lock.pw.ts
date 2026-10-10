import type { Page } from '@playwright/test';

import { newAccount } from './reader-support/accounts.js';
import { meOf } from './reader-support/api.js';
import { expect, test } from './support/test.js';

const LOCK_TITLE = 'Preferences are being adjusted in another tab or window';
const SWITCH = 'Mark as read when I open an article';

function overlay(page: Page) {
  return page.getByRole('status').filter({ hasText: LOCK_TITLE });
}

function preference(page: Page) {
  return page.getByRole('switch', { name: SWITCH });
}

test('two tabs of one account cannot edit the preferences at once', async ({ browse, api }) => {
  const email = newAccount('prefs-lock');
  const tabA = await browse.as(email);
  const tabB = await tabA.context().newPage();
  const user = await api.login(email);

  await test.step('the first tab to open the settings edits', async () => {
    await tabA.goto('/settings');
    await expect(preference(tabA)).toBeEnabled();
    await expect(preference(tabA)).toHaveAttribute('aria-checked', 'true');
    await expect(overlay(tabA)).toHaveCount(0);
  });

  await test.step('the second tab is locked out', async () => {
    await tabB.goto('/settings');
    await expect(overlay(tabB)).toBeVisible();
    const focused = await preference(tabB).evaluate((element) => {
      (element as HTMLElement).focus();
      return document.activeElement === element;
    });
    expect(focused).toBe(false);
    await expect(overlay(tabA)).toHaveCount(0);
  });

  await test.step('the first tab saves and leaves, and the second shows the saved value', async () => {
    await preference(tabA).click();
    await expect(preference(tabA)).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await meOf(user)).preferences.markReadOnExpand).toBe(false);
    await tabA.goto('/read');
    await expect(overlay(tabB)).toHaveCount(0);
    await expect(preference(tabB)).toBeEnabled();
    await expect(preference(tabB)).toHaveAttribute('aria-checked', 'false');
  });

  await test.step('the first tab, back on the settings, waits and can take the editing over', async () => {
    await tabA.goto('/settings');
    await expect(overlay(tabA)).toBeVisible();
    await expect(overlay(tabB)).toHaveCount(0);
    await tabA.getByRole('button', { name: 'Edit here instead' }).click();
    await expect(overlay(tabA)).toHaveCount(0);
    await expect(preference(tabA)).toBeEnabled();
    await expect(overlay(tabB)).toBeVisible();
  });

  await test.step('closing the tab that edits frees the other', async () => {
    await tabA.close();
    await expect(overlay(tabB)).toHaveCount(0);
    await expect(preference(tabB)).toBeEnabled();
  });
});
