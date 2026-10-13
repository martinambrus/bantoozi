import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { failure } from '../api/fake-fetch.js';
import { bodyOf, renderApp, type ApiRouteHandler } from '../support/app.js';
import {
  RUNTIME_DEFAULTS,
  patchAnswer,
  runtimeRoutes,
  type RuntimeFixture,
} from './m8b-t10-support.js';
import { adminMe, unhandledGuard } from './support.js';

/**
 * M8b-T10 ruler (spec 09 §8). Conventions fixed by this ruler, in the order the implementer meets
 * them:
 * - Groups: `role=group` named 'Decision engine (Jev)', 'LLM fallback (Ollama)', 'Ingestion and
 *   fetching', 'API', 'Translation'; inside, one `role=group` per setting key (name = the key), as
 *   the existing editors do. A control is found by `getByLabelText(key)` inside its key group;
 *   compound keys label their parts `<key>.fast|strong|timeoutMs|maxBytes`; `fetch.limits.maxBytes`
 *   is in MB (1 MB = 1024*1024 bytes).
 * - Buttons: `Save <key>`, `Reset <key>`; a rejected value shows 'Not accepted: …', sets
 *   aria-invalid on the control and disables Save; nothing is sent.
 * - A control starts at the stored value, else at the environment default.
 */

const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

const PATCH = 'PATCH /admin/settings';
const MODEL = 'engine.typesafe_model';
const FALLBACK = 'engine.llm_fallback_enabled';
const OLLAMA = 'engine.ollama_models';

async function open(fixture: RuntimeFixture = {}, over: Record<string, ApiRouteHandler> = {}) {
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      server: { me: adminMe(), routes: runtimeRoutes(fixture, over) },
    }),
  );
  await screen.findByRole('group', { name: 'Decision engine (Jev)' });
  return app;
}

const keyGroup = (key: string) => screen.getByRole('group', { name: key });
const control = (key: string, label = key) => within(keyGroup(key)).getByLabelText(label);
const save = (key: string) => screen.getByRole('button', { name: `Save ${key}` });
const reset = (key: string) => screen.getByRole('button', { name: `Reset ${key}` });

async function fill(app: { user: UserEvent }, key: string, text: string, label = key) {
  const input = control(key, label);
  await app.user.clear(input);
  if (text !== '') await app.user.type(input, text);
}

describe('M8b-T10 grouped typed editors', () => {
  it('puts every runtime key in its group, with a typed control that starts at the default', async () => {
    await open();

    const groups: Record<string, string[]> = {
      'Decision engine (Jev)': [
        MODEL,
        'engine.typesafe_base_url',
        'engine.typesafe_price_per_mtok_usd',
        'engine.concurrency',
        'engine.prefilter_min_cards',
      ],
      'LLM fallback (Ollama)': [
        FALLBACK,
        OLLAMA,
        'engine.ollama_base_url',
        'engine.ollama_max_concurrency',
      ],
      'Ingestion and fetching': ['ingest.max_age_days', 'fetch.limits'],
      API: ['api.rate_limits_enabled'],
      Translation: ['translate.libretranslate_url'],
    };
    for (const [name, keys] of Object.entries(groups)) {
      const group = screen.getByRole('group', { name });
      for (const key of keys) expect(within(group).getByRole('group', { name: key })).toBeVisible();
    }
    expect(control('engine.concurrency')).toHaveValue(RUNTIME_DEFAULTS['engine.concurrency']);
    expect(control('engine.concurrency')).toHaveAttribute('type', 'number');
    expect(control(MODEL)).toHaveValue('jev-1.13.0');
    expect(control(FALLBACK)).not.toBeChecked();
    expect(control('api.rate_limits_enabled')).toBeChecked();
    expect(control(OLLAMA, `${OLLAMA}.fast`)).toHaveValue('glm-5.3-flash');
    expect(control(OLLAMA, `${OLLAMA}.strong`)).toHaveValue('glm-5.3');
    expect(control('fetch.limits', 'fetch.limits.timeoutMs')).toHaveValue(20_000);
    expect(control('fetch.limits', 'fetch.limits.maxBytes')).toHaveValue(10);
    expect(save('engine.concurrency')).toBeDisabled();
  });

  it('starts a stored key at its stored value', async () => {
    await open({ stored: { 'engine.concurrency': 12 } });

    expect(control('engine.concurrency')).toHaveValue(12);
  });

  it.each([
    ['engine.concurrency', '0'],
    ['engine.concurrency', '65'],
    ['engine.concurrency', '1.5'],
    ['engine.ollama_max_concurrency', '0'],
    ['engine.prefilter_min_cards', '0'],
    ['engine.prefilter_min_cards', '10001'],
    ['ingest.max_age_days', '0'],
    ['ingest.max_age_days', '366'],
    ['engine.typesafe_price_per_mtok_usd', '-1'],
    ['engine.typesafe_price_per_mtok_usd', '11'],
    [MODEL, ''],
    ['engine.typesafe_base_url', 'ftp://jev.example.com'],
    ['engine.typesafe_base_url', 'https://user:pass@jev.example.com'],
    ['engine.ollama_base_url', 'not a url'],
    ['translate.libretranslate_url', 'libretranslate:5000'],
  ])('rejects %s = %j client-side with the shared schema and sends nothing', async (key, text) => {
    const app = await open();

    await fill(app, key, text);

    expect(within(keyGroup(key)).getByText(/^Not accepted:/)).toBeVisible();
    expect(control(key)).toBeInvalid();
    expect(save(key)).toBeDisabled();
    await app.user.click(save(key));
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it.each([
    [OLLAMA, `${OLLAMA}.fast`, ''],
    ['fetch.limits', 'fetch.limits.timeoutMs', '500'],
    ['fetch.limits', 'fetch.limits.timeoutMs', '120001'],
    ['fetch.limits', 'fetch.limits.maxBytes', '100'],
    ['fetch.limits', 'fetch.limits.maxBytes', '0.01'],
  ])('rejects the part %s / %s = %j of a compound key', async (key, label, text) => {
    const app = await open();

    await fill(app, key, text, label);

    expect(within(keyGroup(key)).getByText(/^Not accepted:/)).toBeVisible();
    expect(save(key)).toBeDisabled();
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it('clears the rejection when the value is corrected (negative control)', async () => {
    const app = await open();
    await fill(app, 'engine.concurrency', '0');
    expect(save('engine.concurrency')).toBeDisabled();

    await fill(app, 'engine.concurrency', '12');

    expect(within(keyGroup('engine.concurrency')).queryByText(/^Not accepted:/)).toBeNull();
    expect(control('engine.concurrency')).toBeValid();
    expect(save('engine.concurrency')).toBeEnabled();
  });

  it.each([
    ['engine.concurrency', undefined, '12', { 'engine.concurrency': 12 }],
    ['engine.ollama_max_concurrency', undefined, '2', { 'engine.ollama_max_concurrency': 2 }],
    ['engine.prefilter_min_cards', undefined, '80', { 'engine.prefilter_min_cards': 80 }],
    ['ingest.max_age_days', undefined, '30', { 'ingest.max_age_days': 30 }],
    [
      'engine.typesafe_price_per_mtok_usd',
      undefined,
      '0.75',
      { 'engine.typesafe_price_per_mtok_usd': 0.75 },
    ],
    [
      'engine.typesafe_base_url',
      undefined,
      'https://jev2.example.com',
      { 'engine.typesafe_base_url': 'https://jev2.example.com' },
    ],
    [
      'engine.ollama_base_url',
      undefined,
      'https://ollama2.example.com',
      { 'engine.ollama_base_url': 'https://ollama2.example.com' },
    ],
    [
      'fetch.limits',
      'fetch.limits.maxBytes',
      '5',
      { 'fetch.limits': { timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024 } },
    ],
    [
      'fetch.limits',
      'fetch.limits.timeoutMs',
      '30000',
      { 'fetch.limits': { timeoutMs: 30_000, maxBytes: 10 * 1024 * 1024 } },
    ],
  ])(
    'saves a valid %s edit as exactly that key, without an acknowledgement',
    async (key, label, text, body) => {
      const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

      await fill(app, key, text, label);
      await app.user.click(save(key));

      await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
      expect(bodyOf(app.calls(PATCH)[0]!)).toEqual(body);
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('saves the switches true and false (rate limits need no acknowledgement)', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await app.user.click(control('api.rate_limits_enabled'));
    await app.user.click(save('api.rate_limits_enabled'));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ 'api.rate_limits_enabled': false });
  });

  it('saves the LibreTranslate URL', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await fill(app, 'translate.libretranslate_url', 'http://lt2:5000');
    await app.user.click(save('translate.libretranslate_url'));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({
      'translate.libretranslate_url': 'http://lt2:5000',
    });
  });
});

describe('M8b-T10 source badge, default and reset', () => {
  it.each([
    ['engine.concurrency', 'stored', 'Source: stored'],
    ['engine.concurrency', 'env', 'Source: environment'],
    ['engine.concurrency', 'last_good', 'Source: last good value'],
  ] as const)('shows the %s source %s as "%s"', async (key, source, text) => {
    await open({
      stored: source === 'env' ? {} : { [key]: 12 },
      sources: { [key]: source },
    });

    const group = keyGroup(key);
    expect(within(group).getByText(text)).toBeVisible();
    for (const other of ['Source: stored', 'Source: environment', 'Source: last good value']) {
      if (other !== text) expect(within(group).queryByText(other)).toBeNull();
    }
  });

  it('shows the environment default next to every key', async () => {
    await open({ stored: { 'engine.concurrency': 12, [MODEL]: 'jev-1.14.0' } });

    expect(within(keyGroup('engine.concurrency')).getByText('Default: 8')).toBeVisible();
    expect(within(keyGroup(MODEL)).getByText('Default: jev-1.13.0')).toBeVisible();
    expect(within(keyGroup('ingest.max_age_days')).getByText('Default: 14')).toBeVisible();
    expect(within(keyGroup(OLLAMA)).getByText(/Default:.*glm-5\.3-flash.*glm-5\.3/)).toBeVisible();
  });

  it('sends null when a stored key is reset', async () => {
    const fixture = { stored: { 'engine.concurrency': 12 } };
    const app = await open(fixture, {
      [PATCH]: (request) => patchAnswer(bodyOf(request) as never, fixture),
    });

    await app.user.click(reset('engine.concurrency'));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ 'engine.concurrency': null });
  });

  it('offers no reset while a key reads its environment default (negative control)', async () => {
    const app = await open();

    expect(reset('engine.concurrency')).toBeDisabled();
    await app.user.click(reset('engine.concurrency'));
    expect(app.calls(PATCH)).toHaveLength(0);
  });
});

describe('M8b-T10 acknowledgement for model and fallback changes', () => {
  it('cannot save a model change until the replay acknowledgement is ticked, then sends acknowledge', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await fill(app, MODEL, 'jev-1.14.0');
    await app.user.click(save(MODEL));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/eval replay/)).toBeVisible();
    expect(within(dialog).getByText(/jev-1\.13\.0/)).toBeVisible();
    expect(within(dialog).getByText(/jev-1\.14\.0/)).toBeVisible();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and save' });
    expect(confirm).toBeDisabled();
    await app.user.click(confirm);
    expect(app.calls(PATCH)).toHaveLength(0);

    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    expect(confirm).toBeEnabled();
    await app.user.click(confirm);

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: 'jev-1.14.0', acknowledge: true });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the edit and sends nothing when the dialog is cancelled', async () => {
    const app = await open();
    await fill(app, MODEL, 'jev-1.14.0');
    await app.user.click(save(MODEL));

    await app.user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(control(MODEL)).toHaveValue('jev-1.14.0');
    expect(app.calls(PATCH)).toHaveLength(0);
  });

  it('asks again for each later model change (the tick is not remembered)', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });
    await fill(app, MODEL, 'jev-1.14.0');
    await app.user.click(save(MODEL));
    let dialog = await screen.findByRole('dialog');
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));
    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await fill(app, MODEL, 'jev-1.15.0');
    await app.user.click(save(MODEL));

    dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    ).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Confirm and save' })).toBeDisabled();
  });

  it('gates the fallback switch the same way', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await app.user.click(control(FALLBACK));
    await app.user.click(save(FALLBACK));
    const dialog = await screen.findByRole('dialog');
    expect(app.calls(PATCH)).toHaveLength(0);
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [FALLBACK]: true, acknowledge: true });
  });

  it('gates the Ollama models the same way', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await fill(app, OLLAMA, 'glm-5.4', `${OLLAMA}.strong`);
    await app.user.click(save(OLLAMA));
    const dialog = await screen.findByRole('dialog');
    expect(app.calls(PATCH)).toHaveLength(0);
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({
      [OLLAMA]: { fast: 'glm-5.3-flash', strong: 'glm-5.4' },
      acknowledge: true,
    });
  });

  it('gates a reset of a stored model too, and sends null with the acknowledgement', async () => {
    const fixture = { stored: { [MODEL]: 'jev-1.14.0' } };
    const app = await open(fixture, {
      [PATCH]: (request) => patchAnswer(bodyOf(request) as never, fixture),
    });

    await app.user.click(reset(MODEL));
    const dialog = await screen.findByRole('dialog');
    expect(app.calls(PATCH)).toHaveLength(0);
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [MODEL]: null, acknowledge: true });
  });

  it('shows the dialog when the server asks for confirmation (409 confirmation_required) and then resends with acknowledge', async () => {
    const app = await open(
      {},
      {
        [PATCH]: (request) => {
          const body = bodyOf(request) as Record<string, unknown>;
          return body['acknowledge'] === true
            ? patchAnswer(body)
            : failure(409, 'CONFLICT', {
                reason: 'confirmation_required',
                effects: ['reenrich', 'rematch'],
              });
        },
      },
    );

    await fill(app, 'engine.prefilter_min_cards', '80');
    await app.user.click(save('engine.prefilter_min_cards'));

    const dialog = await screen.findByRole('dialog');
    expect(app.calls(PATCH)).toHaveLength(1);
    await app.user.click(
      within(dialog).getByRole('checkbox', { name: 'I ran eval replay and it passed' }),
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(2));
    expect(bodyOf(app.calls(PATCH)[1]!)).toEqual({
      'engine.prefilter_min_cards': 80,
      acknowledge: true,
    });
  });

  it('shows no dialog for a key that needs none (negative control)', async () => {
    const app = await open({}, { [PATCH]: (request) => patchAnswer(bodyOf(request) as never) });

    await fill(app, 'engine.concurrency', '12');
    await app.user.click(save('engine.concurrency'));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bodyOf(app.calls(PATCH)[0]!)).not.toHaveProperty('acknowledge');
  });
});

describe('M8b-T10 server refusals', () => {
  it('highlights the field named by a 400 details.key and no other', async () => {
    const app = await open(
      {},
      {
        [PATCH]: () =>
          failure(400, 'VALIDATION_FAILED', {
            key: 'engine.typesafe_base_url',
            reason: 'host_not_allowed',
          }),
      },
    );

    await fill(app, 'engine.typesafe_base_url', 'https://evil.example.com');
    await app.user.click(save('engine.typesafe_base_url'));

    expect(await within(keyGroup('engine.typesafe_base_url')).findByRole('alert')).toBeVisible();
    expect(control('engine.typesafe_base_url')).toBeInvalid();
    expect(control('engine.ollama_base_url')).toBeValid();
    expect(within(keyGroup('engine.ollama_base_url')).queryByRole('alert')).toBeNull();
    expect(control('engine.typesafe_base_url')).toHaveValue('https://evil.example.com');
    expect(save('engine.typesafe_base_url')).toBeEnabled();
  });

  it('shows the missing pairs of a 503 LibreTranslate refusal and keeps the edit', async () => {
    const app = await open(
      {},
      {
        [PATCH]: () =>
          failure(503, 'ENGINE_UNAVAILABLE', {
            engine: 'libretranslate',
            reason: 'missing_languages',
            missing: ['sk-en', 'cs-en'],
          }),
      },
    );

    await fill(app, 'translate.libretranslate_url', 'http://lt2:5000');
    await app.user.click(save('translate.libretranslate_url'));

    expect(
      await within(keyGroup('translate.libretranslate_url')).findByRole('alert'),
    ).toHaveTextContent('sk-en, cs-en');
    expect(control('translate.libretranslate_url')).toHaveValue('http://lt2:5000');
    expect(save('translate.libretranslate_url')).toBeEnabled();
  });
});
