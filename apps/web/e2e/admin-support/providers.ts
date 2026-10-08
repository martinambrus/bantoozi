import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';

import { call, callJson } from '../support/api.js';
import { expect } from '../support/test.js';

import { enterSecret } from './secrets.js';

/**
 * The provider credential of the language model service (Jev, provider `typesafe`) as the
 * administrator meets it: the panel on `/admin/providers` and the credential routes of spec 08 §9.1.
 * The API calls arrange or check what the panel does not show; nothing here ever prints a key.
 */

export const PROVIDER = 'typesafe';

export interface CredentialView {
  provider: string;
  source: 'none' | 'env' | 'db';
  enabled: boolean;
  /** Decimal string; the compare-and-swap token of every change. */
  revision: string;
  activeVersion: string | null;
  candidateVersion: string | null;
  candidateStatus: 'pending' | 'validating' | 'valid' | 'invalid' | null;
  validatedAt: string | null;
  lastErrorCode: string | null;
}

/** The state of the provider's credential, as the API reports it (metadata only). */
export async function credentialOf(admin: APIRequestContext): Promise<CredentialView> {
  const list = await callJson<{ items: CredentialView[] }>(
    admin,
    'GET',
    '/api/v1/admin/engine/credentials',
  );
  const found = list.items.find((item) => item.provider === PROVIDER);
  if (found === undefined) throw new Error(`the credential list has no ${PROVIDER}`);
  return found;
}

/** Stages a key through the API, the way a second administrator session would. */
export function stageThroughApi(
  admin: APIRequestContext,
  apiKey: string,
  expectedRevision: string,
): Promise<APIResponse> {
  return call(admin, 'PUT', `/api/v1/admin/engine/credentials/${PROVIDER}`, {
    data: { apiKey, expectedRevision },
  });
}

/** Asks to activate the candidate the caller believes is staged. */
export function activateThroughApi(
  admin: APIRequestContext,
  credential: Pick<CredentialView, 'candidateVersion' | 'revision'>,
): Promise<APIResponse> {
  return call(admin, 'POST', `/api/v1/admin/engine/credentials/${PROVIDER}/activate`, {
    data: {
      candidateVersion: credential.candidateVersion,
      expectedRevision: credential.revision,
    },
  });
}

// ── The panel ─────────────────────────────────────────────────────────────────────────────────

/** Opens the providers page and returns the panel of the provider. */
export async function openPanel(page: Page): Promise<Locator> {
  await page.goto('/admin/providers');
  const panel = page.getByRole('region', { name: 'Jev (typesafe)' });
  await expect(panel).toBeVisible();
  return panel;
}

/** What a toast says; toasts are the only place a result shows up without the panel changing. */
export function toast(page: Page, text: string): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

/** Types a key into the panel and stages it; the key is cleared from the field at once. */
export async function stageKey(page: Page, panel: Locator, key: string): Promise<void> {
  const field = panel.getByLabel('New API key for Jev (typesafe)');
  await enterSecret(field, key);
  await panel.getByRole('button', { name: 'Stage key' }).click();
  await expect(toast(page, 'Key staged. Validate it next.')).toBeVisible();
  await expect(field).toHaveValue('');
}

/** Presses Validate and waits for the answer of the test call: "Valid" or "Invalid". */
export async function validateStaged(panel: Locator, outcome: 'Valid' | 'Invalid'): Promise<void> {
  await panel.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(panel.getByText(outcome, { exact: true })).toBeVisible({ timeout: 30_000 });
}

/**
 * Validates a candidate that already has an answer. The panel shows "Valid" all along, so the new
 * answer is recognised by its time: first in the API, then on the screen.
 */
export async function revalidateStaged(admin: APIRequestContext, panel: Locator): Promise<void> {
  const answeredBefore = (await credentialOf(admin)).validatedAt;
  await panel.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect
    .poll(async () => (await credentialOf(admin)).validatedAt, {
      message: 'the candidate is validated again',
      timeout: 30_000,
      intervals: [250, 500],
    })
    .not.toBe(answeredBefore);
  const answered = await credentialOf(admin);
  expect(answered.candidateStatus).toBe('valid');
  // The panel reads the list again every two seconds while it waits for an answer.
  await expect(fact(panel, 'Last validated').locator('time')).toHaveAttribute(
    'datetime',
    answered.validatedAt ?? '',
    { timeout: 15_000 },
  );
}

export function activateButton(panel: Locator): Locator {
  return panel.getByRole('button', { name: 'Activate', exact: true });
}

/** Activates the validated key. */
export async function activateStaged(page: Page, panel: Locator): Promise<void> {
  await activateButton(panel).click();
  await expect(toast(page, 'Key activated. It is used from now on.')).toBeVisible();
}

/** Disables the provider through the question that follows the button. */
export async function disableProvider(page: Page, panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Disable', exact: true }).click();
  const question = page.getByRole('dialog', { name: 'Disable Jev (typesafe)?' });
  await question.getByRole('button', { name: 'Disable provider' }).click();
  await expect(toast(page, 'Provider disabled.')).toBeVisible();
}

/** The value beside a label in the panel's facts, e.g. `fact(panel, 'Active key')`: "Version 3" or "None". */
export function fact(panel: Locator, label: string): Locator {
  return panel
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');
}

/**
 * Leaves the provider enabled with a working key, through the API: stage, validate, wait for the
 * answer, activate. The environment keeps one database for every scenario, and the credential of a
 * scenario that disabled the provider cannot be put back any other way.
 */
export async function restoreWorkingKey(admin: APIRequestContext, key: string): Promise<void> {
  const staged = await stageThroughApi(admin, key, (await credentialOf(admin)).revision);
  expect(staged.status(), 'the restored key is staged').toBe(200);
  const candidate = await credentialOf(admin);
  await callJson<unknown>(admin, 'POST', `/api/v1/admin/engine/credentials/${PROVIDER}/validate`, {
    data: { candidateVersion: candidate.candidateVersion, expectedRevision: candidate.revision },
    expected: 202,
  });
  await expect
    .poll(async () => (await credentialOf(admin)).candidateStatus, {
      message: 'the restored key is validated',
      timeout: 30_000,
      intervals: [250, 500],
    })
    .toBe('valid');
  const activated = await activateThroughApi(admin, await credentialOf(admin));
  expect(activated.status(), 'the restored key is activated').toBe(200);
  expect(await credentialOf(admin)).toMatchObject({ enabled: true, source: 'db' });
}
