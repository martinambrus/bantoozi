import type { APIRequestContext } from '@playwright/test';

import { call, callJson } from './support/api.js';
import { EMAILS } from './support/env.js';
import { expect, test } from './support/test.js';

const TIMEOUT_KEY = 'fetch.limits';
const NEW_TIMEOUT_MS = 12_345;

interface SettingsView {
  values: Record<string, unknown>;
  sources: Record<string, string>;
}

const settingsOf = (admin: APIRequestContext): Promise<SettingsView> =>
  callJson<SettingsView>(admin, 'GET', '/api/v1/admin/settings');

/** Resets a live key to its environment value through the API. */
async function resetThroughApi(admin: APIRequestContext, key: string): Promise<void> {
  const response = await call(admin, 'PATCH', '/api/v1/admin/settings', {
    data: { [key]: null, acknowledge: true },
  });
  expect(response.status(), `the reset of ${key}`).toBe(200);
}

/**
 * Spec 09 §9 (Admin → Settings): a live runtime key is edited in a typed field, shows where its
 * value comes from and resets to the environment value. The model editor has its own scenario
 * (admin-model.pw.ts).
 */
test('admin settings: a typed runtime key saves and resets', async ({ browse }) => {
  const page = await browse.as(EMAILS.admin);
  const admin = page.request;

  let failure: { error: unknown } | undefined;
  try {
    await page.goto('/admin/settings');
    const ingestion = page.getByRole('group', { name: 'Ingestion and fetching' });
    const limits = ingestion.getByRole('group', { name: TIMEOUT_KEY, exact: true });

    await test.step('a valid timeout saves, the source becomes stored, and the server has it', async () => {
      await expect(limits).toBeVisible();
      await limits.getByLabel(`${TIMEOUT_KEY}.timeoutMs`).fill(String(NEW_TIMEOUT_MS));
      await limits.getByRole('button', { name: `Save ${TIMEOUT_KEY}` }).click();
      await expect(limits.getByText('Source: stored')).toBeVisible();
      await expect(limits.getByLabel(`${TIMEOUT_KEY}.timeoutMs`)).toHaveValue(
        String(NEW_TIMEOUT_MS),
      );

      const stored = await settingsOf(admin);
      expect(stored.sources[TIMEOUT_KEY]).toBe('stored');
      expect(stored.values[TIMEOUT_KEY]).toMatchObject({ timeoutMs: NEW_TIMEOUT_MS });
    });

    await test.step('reset returns the key to its environment value', async () => {
      await limits.getByRole('button', { name: `Reset ${TIMEOUT_KEY}` }).click();
      await expect(limits.getByText('Source: environment')).toBeVisible();
      const reset = await settingsOf(admin);
      expect(reset.sources[TIMEOUT_KEY]).toBe('env');
      expect(reset.values[TIMEOUT_KEY]).not.toMatchObject({ timeoutMs: NEW_TIMEOUT_MS });
    });
  } catch (error) {
    failure = { error };
  }

  // The scenarios share one database: leave the key on its environment value.
  try {
    await resetThroughApi(admin, TIMEOUT_KEY);
  } catch (error) {
    if (failure === undefined) failure = { error };
    else {
      const reason = error instanceof Error ? error.message : 'unknown';
      test.info().annotations.push({ type: 'cleanup failed', description: reason });
      console.error(`The cleanup after the failed step failed too: ${reason}`);
    }
  }
  if (failure !== undefined) throw failure.error;
});
