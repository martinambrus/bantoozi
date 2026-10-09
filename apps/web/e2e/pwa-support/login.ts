import type { Page } from '@playwright/test';

import { codeIn, mailTo } from '../flow-support/mail.js';
import { expect } from '../support/test.js';

/**
 * Signing in and out as a person does, on the pages of the app: the login page asks for the
 * address, then for the code that the dev mail log (`GET /api/v1/dev/last-email`) holds.
 */

/** Fills in the login page and signs in; returns once the page has left it. */
export async function signInOnLoginPage(page: Page, email: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send code', exact: true }).click();
  // The page says so once the server has answered, and the server sends the mail before it answers.
  await expect(page.getByRole('status').filter({ hasText: email })).toContainText(
    `If ${email} can use Bantoozi, we've emailed it a code.`,
  );
  const code = codeIn(await mailTo(page.request, email));
  expect(code, `the mail to ${email} carries a code`).toMatch(/^\d{6}$/);
  await page.getByLabel('Code', { exact: true }).fill(code ?? '');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Chooses Sign out in the account menu and waits for the login page. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Account menu: / }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
}
