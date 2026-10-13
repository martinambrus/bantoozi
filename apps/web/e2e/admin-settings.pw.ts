import type { APIRequestContext } from '@playwright/test';

import { call, callJson } from './support/api.js';
import { EMAILS } from './support/env.js';
import { expect, test } from './support/test.js';

const TIMEOUT_KEY = 'fetch.limits';
const MODEL_KEY = 'engine.typesafe_model';
const NEW_TIMEOUT_MS = 12_345;
const NEW_MODEL = 'jev-1.14.0';

interface SettingsView {
  values: Record<string, unknown>;
  sources: Record<string, string>;
}

const settingsOf = (admin: APIRequestContext): Promise<SettingsView> =>
  callJson<SettingsView>(admin, 'GET', '/api/v1/admin/settings');

/** Resets a live key to its environment value through the API; the model key needs the acknowledgement. */
async function resetThroughApi(admin: APIRequestContext, key: string): Promise<void> {
  const response = await call(admin, 'PATCH', '/api/v1/admin/settings', {
    data: { [key]: null, acknowledge: true },
  });
  expect(response.status(), `the reset of ${key}`).toBe(200);
}

/**
 * Spec 09 §9 (Admin → Settings): a live runtime key is edited in a typed field, shows where its
 * value comes from and resets to the environment value; a change of the model asks for the eval
 * replay acknowledgement first and sends nothing until it is given.
 */
test('admin settings: a typed runtime key saves and resets, a model change needs the acknowledgement', async ({
  browse,
}) => {
  const page = await browse.as(EMAILS.admin);
  const admin = page.request;

  let failure: { error: unknown } | undefined;
  try {
    const initial = await settingsOf(admin);
    const model = initial.values[MODEL_KEY];
    expect(model, 'the model before the scenario').not.toBe(NEW_MODEL);

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

    const engine = page.getByRole('group', { name: 'Decision engine (Jev)' });
    const modelEditor = engine.getByRole('group', { name: MODEL_KEY, exact: true });
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Confirm and save' });
    const ticked = dialog.getByRole('checkbox', { name: 'I ran eval replay and it passed' });

    /** Types the new model and opens the acknowledgement dialog. */
    async function askToChange(to: string): Promise<void> {
      await modelEditor.getByLabel(MODEL_KEY, { exact: true }).fill(to);
      await modelEditor.getByRole('button', { name: `Save ${MODEL_KEY}` }).click();
      await expect(dialog).toBeVisible();
      await expect(confirm).toBeDisabled();
    }

    await test.step('cancelling the acknowledgement sends nothing', async () => {
      await askToChange(NEW_MODEL);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect((await settingsOf(admin)).values[MODEL_KEY]).toBe(model);
      expect((await settingsOf(admin)).sources[MODEL_KEY]).toBe('env');
    });

    await test.step('the acknowledged change is stored', async () => {
      await askToChange(NEW_MODEL);
      await ticked.check();
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(modelEditor.getByText('Source: stored')).toBeVisible();
      const stored = await settingsOf(admin);
      expect(stored.values[MODEL_KEY]).toBe(NEW_MODEL);
      expect(stored.sources[MODEL_KEY]).toBe('stored');
    });

    await test.step('reset of the model asks again, and restores the environment value', async () => {
      await modelEditor.getByRole('button', { name: `Reset ${MODEL_KEY}` }).click();
      await expect(dialog).toBeVisible();
      await expect(confirm).toBeDisabled();
      await ticked.check();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(modelEditor.getByText('Source: environment')).toBeVisible();
      const reset = await settingsOf(admin);
      expect(reset.values[MODEL_KEY]).toBe(model);
      expect(reset.sources[MODEL_KEY]).toBe('env');
    });
  } catch (error) {
    failure = { error };
  }

  // The scenarios share one database: leave both keys on their environment values.
  try {
    await resetThroughApi(admin, TIMEOUT_KEY);
    await resetThroughApi(admin, MODEL_KEY);
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
