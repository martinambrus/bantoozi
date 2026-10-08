import { ADMIN_PATCHABLE_SETTING_KEYS, type AdminSettings } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { bodyOf, renderApp, type ApiRouteHandler } from '../support/app.js';
import { SETTINGS_VALUES, adminMe, adminRoutes, makeSettings, unhandledGuard } from './support.js';

const BUDGET = 'engine.daily_budget_usd';
const LLM_CAP = 'engine.llm_daily_cap';
const LANGUAGES = 'language_modes';
const RANKER = 'ranker.thresholds';

const guard = unhandledGuard();

async function render(options: Parameters<typeof renderApp>[0]) {
  return guard(await renderApp(options));
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

async function openSettings(routes: Record<string, ApiRouteHandler> = {}) {
  const app = await render({
    path: '/admin/settings',
    server: { me: adminMe(), routes: adminRoutes(routes) },
  });
  await screen.findByRole('textbox', { name: BUDGET });
  return app;
}

const editor = (key: string) => screen.getByRole('textbox', { name: key });
const group = (key: string) => screen.getByRole('group', { name: key });
const save = (key: string) => screen.getByRole('button', { name: `Save ${key}` });

async function replaceText(app: { user: UserEvent }, key: string, text: string) {
  await app.user.clear(editor(key));
  await app.user.paste(text);
}

/** A PATCH handler that applies the patch like the API does and reports the changed keys. */
function applyingPatch(state: { values: AdminSettings['values'] }): ApiRouteHandler {
  return (request) => {
    const patch = bodyOf(request) as Partial<AdminSettings['values']>;
    const changed = ADMIN_PATCHABLE_SETTING_KEYS.filter(
      (key) => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(state.values[key]),
    );
    state.values = { ...state.values, ...patch };
    return json(200, { ...makeSettings({ values: state.values }), changed });
  };
}

describe('admin settings editors (spec 09 §8)', () => {
  it('shows one JSON editor per patchable key with its effective value and whether it is stored', async () => {
    await openSettings();

    for (const key of ADMIN_PATCHABLE_SETTING_KEYS) {
      expect(screen.getByRole('textbox', { name: key })).toBeVisible();
    }
    expect(editor(BUDGET)).toHaveValue('5');
    expect(editor('card_text_mode')).toHaveValue('"as_written"');
    expect(editor(LANGUAGES)).toHaveValue(JSON.stringify(SETTINGS_VALUES.language_modes, null, 2));
    expect(within(group(BUDGET)).getByText(/^Stored/)).toBeVisible();
    expect(within(group('signup_mode')).getByText('Default (not stored)')).toBeVisible();
    expect(screen.getByText('Ranker settings version: 3')).toBeVisible();
    expect(save(BUDGET)).toBeDisabled();
  });

  it('keeps Save off and sends nothing for text that is not JSON', async () => {
    const app = await openSettings();

    await replaceText(app, BUDGET, '{ nope');

    expect(within(group(BUDGET)).getByText('This is not valid JSON.')).toBeVisible();
    expect(editor(BUDGET)).toBeInvalid();
    expect(save(BUDGET)).toBeDisabled();
    expect(app.calls('PATCH /admin/settings')).toHaveLength(0);
  });

  it.each([
    [BUDGET, '-5'],
    [LLM_CAP, '1.5'],
    ['signup_mode', '"maybe"'],
    [LANGUAGES, '{"english": "native"}'],
    ['engine.prefilter_enabled', '"yes"'],
    ['question_sets.active', '{"enrich": "seven"}'],
  ])('rejects a schema-invalid value of %s before any request', async (key, text) => {
    const app = await openSettings();

    await replaceText(app, key, text);

    expect(within(group(key)).getByText(/^Not accepted:/)).toBeVisible();
    expect(editor(key)).toBeInvalid();
    expect(save(key)).toBeDisabled();
    expect(app.calls('PATCH /admin/settings')).toHaveLength(0);
  });

  it('catches an invalid ranker.thresholds merge before saving, and accepts a valid override', async () => {
    const app = await openSettings();

    // Valid on its own, but merged with the default maybe=0.35 the lanes no longer nest.
    await replaceText(app, RANKER, '{"lanes":{"forYou":0.2}}');
    expect(
      within(group(RANKER)).getByText(/^The merged ranker configuration is invalid:.*lanes/),
    ).toBeVisible();
    expect(save(RANKER)).toBeDisabled();
    expect(app.calls('PATCH /admin/settings')).toHaveLength(0);

    await replaceText(app, RANKER, '{"lanes":{"forYou":0.7}}');
    expect(within(group(RANKER)).queryByText(/merged ranker configuration/)).toBeNull();
    expect(editor(RANKER)).toBeValid();
    expect(save(RANKER)).toBeEnabled();
  });

  it('patches only the edited key, leaves other unsaved edits alone and shows the saved value', async () => {
    const state = { values: { ...SETTINGS_VALUES } };
    const app = await openSettings({ 'PATCH /admin/settings': applyingPatch(state) });
    await replaceText(app, LLM_CAP, '250');

    await replaceText(app, BUDGET, '7.5');
    expect(save(BUDGET)).toBeEnabled();
    await app.user.click(save(BUDGET));

    expect(await screen.findByText(`Saved ${BUDGET}.`)).toBeVisible();
    const requests = app.calls('PATCH /admin/settings');
    expect(requests).toHaveLength(1);
    expect(bodyOf(requests[0]!)).toEqual({ [BUDGET]: 7.5 });
    expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(editor(BUDGET)).toHaveValue('7.5');
    expect(save(BUDGET)).toBeDisabled();
    expect(editor(LLM_CAP)).toHaveValue('250');
    expect(save(LLM_CAP)).toBeEnabled();
  });

  it('says when the saved value was already in effect', async () => {
    const state = { values: { ...SETTINGS_VALUES } };
    const app = await openSettings({ 'PATCH /admin/settings': applyingPatch(state) });

    await replaceText(app, BUDGET, '5.0');
    await app.user.click(save(BUDGET));

    expect(await screen.findByText(`${BUDGET} already had this value.`)).toBeVisible();
  });

  it('puts the effective value back with Revert', async () => {
    const app = await openSettings();
    await replaceText(app, BUDGET, '9');

    await app.user.click(screen.getByRole('button', { name: `Revert ${BUDGET}` }));

    expect(editor(BUDGET)).toHaveValue('5');
    expect(save(BUDGET)).toBeDisabled();
  });

  it.each([
    [
      { reason: 'not_configured' },
      'LibreTranslate is not configured, so language changes cannot be saved.',
    ],
    [
      { reason: 'missing_languages', missing: ['sk-en'] },
      'LibreTranslate does not list these language pairs: sk-en.',
    ],
    [
      { reason: 'timeout' },
      'LibreTranslate could not confirm the languages (timeout), so language changes cannot be saved.',
    ],
  ])(
    'shows the unavailable LibreTranslate (503 %j) and keeps the edit',
    async (details, message) => {
      const app = await openSettings({
        'PATCH /admin/settings': () =>
          failure(503, 'ENGINE_UNAVAILABLE', { engine: 'libretranslate', ...details }),
      });
      const text = '{"en":"native","sk":"translate"}';

      await replaceText(app, LANGUAGES, text);
      await app.user.click(save(LANGUAGES));

      expect(await within(group(LANGUAGES)).findByRole('alert')).toHaveTextContent(message);
      expect(editor(LANGUAGES)).toHaveValue(text);
      expect(save(LANGUAGES)).toBeEnabled();
    },
  );

  it('reloads the settings and says so when they changed while saving (409 settings_changed)', async () => {
    let budget = 5;
    const app = await openSettings({
      'GET /admin/settings': () =>
        json(200, makeSettings({ values: { ...SETTINGS_VALUES, [BUDGET]: budget } })),
      'PATCH /admin/settings': () => {
        budget = 6;
        return failure(409, 'CONFLICT', { reason: 'settings_changed' });
      },
    });
    expect(app.calls('GET /admin/settings')).toHaveLength(1);

    await replaceText(app, BUDGET, '7.5');
    await app.user.click(save(BUDGET));

    expect(await within(group(BUDGET)).findByRole('alert')).toHaveTextContent(
      'Settings changed while saving. The latest values were loaded; review your edit and save again.',
    );
    expect(app.calls('GET /admin/settings')).toHaveLength(2);
    expect(editor(BUDGET)).toHaveValue('7.5');
    expect(save(BUDGET)).toBeEnabled();
  });

  it('adopts reloaded values in editors that were not edited', async () => {
    let cap = 200;
    const app = await openSettings({
      'GET /admin/settings': () =>
        json(200, makeSettings({ values: { ...SETTINGS_VALUES, [LLM_CAP]: cap } })),
      'PATCH /admin/settings': () => {
        cap = 275;
        return failure(409, 'CONFLICT', { reason: 'settings_changed' });
      },
    });

    await replaceText(app, BUDGET, '7.5');
    await app.user.click(save(BUDGET));
    await within(group(BUDGET)).findByRole('alert');

    expect(await screen.findByDisplayValue('275')).toBe(editor(LLM_CAP));
  });

  it.each([
    [
      { key: RANKER },
      RANKER,
      '{"lanes":{"forYou":0.7}}',
      'The server rejected the merged ranker configuration.',
    ],
    [
      { key: 'question_sets.active', kind: 'match' },
      'question_sets.active',
      '{"match":"9"}',
      'Unknown question set for “match”.',
    ],
  ])('shows what the server refused (400 %j)', async (details, key, text, message) => {
    const app = await openSettings({
      'PATCH /admin/settings': () => failure(400, 'VALIDATION_FAILED', details),
    });

    await replaceText(app, key, text);
    await app.user.click(save(key));

    expect(await within(group(key)).findByRole('alert')).toHaveTextContent(message);
  });

  it('explains a missing Laya worker', async () => {
    const app = await openSettings({
      'PATCH /admin/settings': () => failure(409, 'CONFLICT', { reason: 'laya_worker_missing' }),
    });

    await replaceText(app, 'engine.laya', '{"enrich":["sk"]}');
    await app.user.click(save('engine.laya'));

    expect(await within(group('engine.laya')).findByRole('alert')).toHaveTextContent(
      'No running worker consumes the Laya queues, so engine.laya cannot be set.',
    );
  });

  it('shows the error state with a retry when the settings cannot be loaded', async () => {
    let attempts = 0;
    const app = await render({
      path: '/admin/settings',
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/settings': () => {
            attempts += 1;
            return attempts === 1 ? failure(500, 'INTERNAL') : json(200, makeSettings());
          },
        }),
      },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('textbox', { name: BUDGET })).toBeVisible();
  });
});
