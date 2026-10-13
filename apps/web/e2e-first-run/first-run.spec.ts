import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

/**
 * M8b-T11 E2E scenario (NOT in the main `e2e/` run: that run has ADMIN_EMAILS, so setup is closed).
 * It needs the first-run environment the builder adds (see harness/E2E-SEAM.md): a Playwright config
 * whose API runs on a fresh database WITHOUT ADMIN_EMAILS and whose log goes to the file named by
 * E2E_API_LOG_FILE.
 */

const LOG = process.env['E2E_API_LOG_FILE'] ?? '';
const EMAIL = 'first-admin@example.com';
const LINE =
  /First-run setup is open\. Setup token \(shown once, valid until the next start\): (\S+)/g;

/** The newest token in the API log (each start rotates it, so only the last line is valid). */
function latestToken(): string {
  const text = readFileSync(LOG, 'utf8');
  const all = [...text.matchAll(LINE)].map((match) => match[1] ?? '');
  const last = all.at(-1);
  if (last === undefined) throw new Error(`no setup token line in ${LOG}`);
  return last;
}

test('first run: the logged token and an email make the first admin, and setup then closes', async ({
  page,
  request,
}) => {
  expect(LOG, 'E2E_API_LOG_FILE must name the API log').not.toBe('');

  await test.step('setup is open and /login offers the way in', async () => {
    const state = await request.get('/api/v1/setup');
    expect(await state.json()).toEqual({ open: true });
    await page.goto('/login');
    await page.getByRole('link', { name: 'First-run setup', exact: true }).click();
    await expect(page).toHaveURL(/\/setup$/);
  });

  await test.step('a wrong token is refused with the generic message', async () => {
    await page.getByLabel('Setup token', { exact: true }).fill('not-the-token');
    await page.getByLabel('Email', { exact: true }).fill(EMAIL);
    await page.getByRole('button', { name: 'Create admin account', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText("That setup token didn't work.");
    await expect(page).toHaveURL(/\/setup$/);
  });

  await test.step('the token from the API log lands the admin in /admin', async () => {
    await page.getByLabel('Setup token', { exact: true }).fill(latestToken());
    await page.getByRole('button', { name: 'Create admin account', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  });

  await test.step('the session is the new admin', async () => {
    const me = await page.request.get('/api/v1/me');
    expect(await me.json()).toMatchObject({ email: EMAIL, role: 'admin' });
  });

  await test.step('setup is now closed: /setup redirects to /login, and /login has no link', async () => {
    expect(await (await request.get('/api/v1/setup')).json()).toEqual({ open: false });
    const visitor = await page.context().browser()!.newContext();
    const fresh = await visitor.newPage();
    await fresh.goto('/setup');
    await expect(fresh).toHaveURL(/\/login$/);
    await expect(fresh.getByRole('link', { name: 'First-run setup' })).toHaveCount(0);
    await visitor.close();
  });
});
