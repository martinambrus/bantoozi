import type { APIRequestContext } from '@playwright/test';

import {
  clearModelState,
  clearSeededUserModels,
  seedActiveUserModel,
} from './admin-support/hooks.js';
import { setModels } from './admin-support/models.js';
import { newAccount } from './reader-support/accounts.js';
import { call, callJson } from './support/api.js';
import type { Control } from './support/control.js';
import { EMAILS } from './support/env.js';
import { expect, test } from './support/test.js';

const MODEL_KEY = 'engine.typesafe_model';
const PROBE_TIMEOUT_MS = 30_000;

interface SettingsView {
  values: Record<string, unknown>;
  sources: Record<string, string>;
  defaults: Record<string, unknown>;
}

interface Probe {
  requested: string;
  answered?: string;
  ok: boolean;
  at: string;
  error?: string;
}

interface ModelStatus {
  setting: { value: string; source: string };
  resolution: { alias: string; model: string; checkedAt: string } | null;
  watch: { lastCheck: { at: string; ok: boolean } | null };
  probes: Record<string, Probe>;
  impact: { activeModels: number } | null;
}

const settingsOf = (admin: APIRequestContext): Promise<SettingsView> =>
  callJson<SettingsView>(admin, 'GET', '/api/v1/admin/settings');

const statusOf = (admin: APIRequestContext): Promise<ModelStatus> =>
  callJson<ModelStatus>(admin, 'GET', '/api/v1/admin/engine/model');

/** The model id `model` is saved as: the API's own answer, not the screen's. */
async function savedModel(admin: APIRequestContext): Promise<{ value: unknown; source: string }> {
  const settings = await settingsOf(admin);
  return { value: settings.values[MODEL_KEY], source: settings.sources[MODEL_KEY] ?? 'unknown' };
}

/** Queues a probe of `model` and waits until a probe newer than the one before it is recorded. */
async function probeThroughApi(admin: APIRequestContext, model: string): Promise<Probe> {
  const before = (await statusOf(admin)).probes[model]?.at;
  await callJson<unknown>(admin, 'POST', '/api/v1/admin/engine/model-probe', {
    data: { model },
    expected: 202,
  });
  let found: Probe | undefined;
  await expect
    .poll(
      async () => {
        const probe = (await statusOf(admin)).probes[model];
        found = probe !== undefined && probe.at !== before ? probe : undefined;
        return found !== undefined;
      },
      { message: `the probe of ${model}`, timeout: PROBE_TIMEOUT_MS },
    )
    .toBe(true);
  return found!;
}

/** Puts the model back to its environment value; a changed one needs a fresh probe of that value. */
async function restoreModel(admin: APIRequestContext, control: Control): Promise<void> {
  await control.setFakeOptions({ models: null });
  const settings = await settingsOf(admin);
  if (settings.sources[MODEL_KEY] === 'env') return;
  const target = String(settings.defaults[MODEL_KEY]);
  const probe = await probeThroughApi(admin, target);
  expect(probe.ok, `the probe of the environment model ${target}`).toBe(true);
  const response = await call(admin, 'PATCH', '/api/v1/admin/settings', {
    data: { [MODEL_KEY]: null, acknowledge: true },
  });
  expect(response.status(), 'the reset of the model').toBe(200);
}

/**
 * Admin -> Settings, the Jev release editor (visible-learning §4): a save is probed first and a
 * refusal names the id Jev answered; a change to another family says how many personal models
 * restart and needs the eval-replay tick; following jev-latest rebuilds nothing and shows what it
 * resolves to; a change within the family keeps ratings and models; Reset goes back to the
 * environment value. One chain on one database, kept short: the worker is stale while the stored
 * model differs from the one it started with.
 */
test('admin model: a refused save names the answer, a restart needs the tick, the alias rebuilds nothing', async ({
  browse,
  api,
  control,
}) => {
  test.setTimeout(180_000);
  const page = await browse.as(EMAILS.admin);
  const admin = page.request;

  const engine = page.getByRole('group', { name: 'Decision engine (Jev)' });
  const editor = engine.getByRole('group', { name: MODEL_KEY, exact: true });
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Confirm and save' });
  const ticked = dialog.getByRole('checkbox', { name: 'I ran eval replay and it passed' });
  const restartText = /2 users['’] personal models restart/;

  const save = () => editor.getByRole('button', { name: `Save ${MODEL_KEY}` }).click();
  const idField = () => editor.getByLabel(MODEL_KEY, { exact: true });
  /** Waits for the dialog, or fails with the words of the refusal when the save was refused instead. */
  async function dialogOpens(): Promise<void> {
    const refusal = editor.getByRole('alert');
    await expect(dialog.or(refusal).first()).toBeVisible({ timeout: PROBE_TIMEOUT_MS });
    if (await refusal.isVisible()) {
      throw new Error(`the save was refused instead of asking: ${await refusal.innerText()}`);
    }
  }
  const seeded: string[] = [newAccount('model-seed'), newAccount('model-seed')];

  let failure: { error: unknown } | undefined;
  try {
    await test.step('start from the environment model with no probes and no seeded models', async () => {
      await restoreModel(admin, control);
      await clearModelState(control);
      await clearSeededUserModels(control);
      expect(await savedModel(admin)).toEqual({ value: 'jev-fake', source: 'env' });
    });

    await test.step('the server refuses a change that has no fresh probe', async () => {
      const response = await call(admin, 'PATCH', '/api/v1/admin/settings', {
        data: { [MODEL_KEY]: 'jev-1.13.0', acknowledge: true },
      });
      expect(response.status()).toBe(409);
      const body = (await response.json()) as { error: { details?: { reason?: string } } };
      expect(body.error.details?.reason).toBe('model_probe_required');
    });

    await page.goto('/admin/settings');
    await expect(editor).toBeVisible();

    await test.step('(a) a release Jev answers with another one is refused, naming the answer', async () => {
      await idField().fill('jev-1.14.0');
      await save();
      const alert = editor.getByRole('alert');
      await expect(alert).toContainText('jev-fake', { timeout: PROBE_TIMEOUT_MS });
      await expect(alert).toContainText('jev-1.14.0');
      await expect(dialog).toBeHidden();
      expect(await savedModel(admin)).toEqual({ value: 'jev-fake', source: 'env' });
      const probe = (await statusOf(admin)).probes['jev-1.14.0'];
      expect(probe).toMatchObject({ ok: false, answered: 'jev-fake', error: 'model_mismatch' });

      const response = await call(admin, 'PATCH', '/api/v1/admin/settings', {
        data: { [MODEL_KEY]: 'jev-1.14.0', acknowledge: true },
      });
      expect(response.status()).toBe(409);
      const body = (await response.json()) as {
        error: { details?: { reason?: string; answered?: string } };
      };
      expect(body.error.details).toMatchObject({
        reason: 'model_probe_failed',
        answered: 'jev-fake',
      });
    });

    await test.step('two accounts get an active personal model, and Jev serves the releases', async () => {
      for (const email of seeded) {
        await api.login(email);
        await seedActiveUserModel(control, email);
      }
      await setModels(control, {
        'jev-1.13.0': 'jev-1.13.0',
        'jev-1.14.0': 'jev-1.14.0',
        'jev-latest': 'jev-1.13.0',
      });
    });

    await test.step('(c) another family names the restart, needs the tick, and Cancel sends nothing', async () => {
      await page.reload();
      await idField().fill('jev-1.13.0');
      await save();
      await dialogOpens();
      await expect(dialog).toContainText(restartText);
      await expect(confirm).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      expect(await savedModel(admin)).toEqual({ value: 'jev-fake', source: 'env' });

      await save();
      await expect(dialog).toContainText(restartText);
      await ticked.check();
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(editor.getByText('Source: stored')).toBeVisible();
      expect(await savedModel(admin)).toEqual({ value: 'jev-1.13.0', source: 'stored' });
      const status = await statusOf(admin);
      expect(status.probes['jev-1.13.0']).toMatchObject({ ok: true, answered: 'jev-1.13.0' });
      expect(status.impact?.activeModels).toBe(2);
    });

    await test.step('(b) following jev-latest rebuilds nothing, and Check now shows what it resolves to', async () => {
      await editor.getByRole('radio', { name: 'Follow the newest Jev (jev-latest)' }).check();
      await save();
      await dialogOpens();
      await expect(dialog).toContainText(/nothing is rebuilt/i);
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toBeHidden();
      expect(await savedModel(admin)).toEqual({ value: 'jev-latest', source: 'stored' });
      expect((await statusOf(admin)).probes['jev-latest']).toMatchObject({
        ok: true,
        answered: 'jev-1.13.0',
      });

      // One click, right after the save: the worker's check reads the setting fresh, so it is not lost
      // to the worker's 10 s settings cache.
      await editor.getByRole('button', { name: 'Check now' }).click();
      await expect(
        editor.getByText(/Resolves to jev-1\.13\.0\D+checked \d{1,2}:\d{2}/),
      ).toBeVisible({
        timeout: PROBE_TIMEOUT_MS,
      });
      expect((await statusOf(admin)).resolution).toMatchObject({
        alias: 'jev-latest',
        model: 'jev-1.13.0',
      });
    });

    await test.step('(d) a release of the same family keeps ratings and models, with no tick', async () => {
      await editor.getByRole('radio', { name: 'Use one release' }).check();
      await idField().fill('jev-1.14.0');
      await save();
      await dialogOpens();
      await expect(dialog).toContainText(
        'Ratings and personal models are kept; the 14-day window is analysed again.',
      );
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dialog).toBeHidden();
      expect(await savedModel(admin)).toEqual({ value: 'jev-1.14.0', source: 'stored' });
    });

    await test.step('(e) Reset goes back to the environment value after the same warning', async () => {
      await editor.getByRole('button', { name: `Reset ${MODEL_KEY}` }).click();
      await dialogOpens();
      await expect(dialog).toContainText(restartText);
      await ticked.check();
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(editor.getByText('Source: environment')).toBeVisible();
      expect(await savedModel(admin)).toEqual({ value: 'jev-fake', source: 'env' });
    });
  } catch (error) {
    failure = { error };
  }

  try {
    await restoreModel(admin, control);
    await clearSeededUserModels(control);
    await clearModelState(control);
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
