import { codeIn, lastMail, mailTo } from './flow-support/mail.js';
import { newAccount } from './reader-support/accounts.js';
import { callJson, type MeResponse } from './support/api.js';
import { expect, test } from './support/test.js';

interface SignedInUser extends MeResponse {
  preferences: { onboardingCompletedAt: string | null };
}

/**
 * Spec 09 §9, scenario 1: a code requested on the login page for a new address is read from the dev
 * mail log (`GET /api/v1/dev/last-email`), entered, and leads to the first step of onboarding.
 */
test('login: a code read from the dev mail log signs a new address in and opens onboarding', async ({
  api,
  page,
}) => {
  const email = newAccount('login');
  const bystander = newAccount('login-bystander');

  await test.step('another account has just been sent a code, so the log holds its mail', async () => {
    // The log keeps one mail, so a reader that took "the last mail" would sign in as this account.
    await api.login(bystander);
    const left = await lastMail(await api.anonymous());
    expect(left?.to).toBe(bystander);
  });

  await test.step('the visitor asks for a code on the login page', async () => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Send code', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: email })).toContainText(
      `If ${email} can use Bantoozi, we've emailed it a code.`,
    );
  });

  let code = '';
  await test.step('the code is the one in the mail addressed to the new address', async () => {
    const mail = await mailTo(await api.anonymous(), email);
    expect(mail.to.toLowerCase()).toBe(email.toLowerCase());
    code = codeIn(mail) ?? '';
    expect(code).toMatch(/^\d{6}$/);
  });

  await test.step('entering it signs the visitor in and shows the first step of onboarding', async () => {
    await page.getByLabel('Code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Welcome to Bantoozi' }),
    ).toBeVisible();
    await expect(page.getByText('Step 1 of 4', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'How Bantoozi works' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get started', exact: true })).toBeVisible();
  });

  await test.step('the session belongs to the new address and its onboarding is not done', async () => {
    const me = await callJson<SignedInUser>(page.request, 'GET', '/api/v1/me');
    expect(me.email.toLowerCase()).toBe(email.toLowerCase());
    expect(me.preferences.onboardingCompletedAt).toBeNull();
  });
});
