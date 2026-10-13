import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { bodyOf, renderApp } from '../support/app.js';
import { patchAnswer, runtimeSettings } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * PR #28 review round 2: a switch whose effective value is unknown (no worker default) is not the
 * same as "off": the admin picks on or off explicitly and Save sends that choice.
 */

const guard = unhandledGuard();
const PATCH = 'PATCH /admin/settings';
const FALLBACK = 'engine.llm_fallback_enabled';
const RATE = 'api.rate_limits_enabled';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

function unknownSettings() {
  const base = runtimeSettings();
  return {
    ...base,
    values: { ...base.values, [FALLBACK]: null, [RATE]: null },
    defaults: { ...base.defaults, [FALLBACK]: null, [RATE]: null },
  };
}

async function open(known = false) {
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/settings': () => json(200, known ? runtimeSettings() : unknownSettings()),
          [PATCH]: (request) => patchAnswer(bodyOf(request) as never),
        }),
      },
    }),
  );
  await screen.findByRole('group', { name: 'Decision engine (Jev)' });
  return app;
}

const keyGroup = (key: string) => screen.getByRole('group', { name: key });
const save = (key: string) => screen.getByRole('button', { name: `Save ${key}` });

describe('unknown boolean runtime values', () => {
  it.each([FALLBACK, RATE])('%s: choosing off enables Save and sends false', async (key) => {
    const app = await open();
    expect(save(key)).toBeDisabled();

    await app.user.click(within(keyGroup(key)).getByRole('radio', { name: /^off$/i }));

    expect(save(key)).toBeEnabled();
    await app.user.click(save(key));
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [key]: false });
  });

  it('api.rate_limits_enabled: choosing on sends true', async () => {
    const app = await open();

    await app.user.click(within(keyGroup(RATE)).getByRole('radio', { name: /^on$/i }));
    await app.user.click(save(RATE));

    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [RATE]: true });
  });

  it('control: a known value keeps the single checkbox and no radios', async () => {
    await open(true);

    expect(within(keyGroup(RATE)).getByLabelText(RATE)).toBeChecked();
    expect(within(keyGroup(RATE)).queryByRole('radio')).toBeNull();
  });
});
