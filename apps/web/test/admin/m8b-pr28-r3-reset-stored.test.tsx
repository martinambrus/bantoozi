import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { bodyOf, renderApp } from '../support/app.js';
import { patchAnswer, runtimeSettings } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * PR #28 review round 3: Reset is offered whenever a stored row exists for the key, even when the
 * row no longer validates and no last-good value exists (the source then reads `env`).
 */

const guard = unhandledGuard();
const PATCH = 'PATCH /admin/settings';
const KEY = 'engine.concurrency';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

function settings(withStoredRow: boolean) {
  const base = runtimeSettings();
  return withStoredRow
    ? {
        ...base,
        stored: [
          ...base.stored,
          { key: KEY as never, updatedAt: base.stored[0]?.updatedAt ?? '2026-10-01T00:00:00.000Z' },
        ],
      }
    : base;
}

async function open(withStoredRow: boolean) {
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      server: {
        me: adminMe(),
        routes: adminRoutes({
          'GET /admin/settings': () => json(200, settings(withStoredRow)),
          [PATCH]: (request) => patchAnswer(bodyOf(request) as never),
        }),
      },
    }),
  );
  await screen.findByRole('group', { name: 'Decision engine (Jev)' });
  return app;
}

const reset = () => screen.getByRole('button', { name: `Reset ${KEY}` });

describe('Reset over an invalid stored row', () => {
  it('is enabled when a row is stored although the source is env, and sends null', async () => {
    const app = await open(true);
    expect(settings(true).sources[KEY]).toBe('env');
    expect(reset()).toBeEnabled();
    await app.user.click(reset());
    await vi.waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));
    expect(bodyOf(app.calls(PATCH)[0]!)).toEqual({ [KEY]: null });
  });

  it('control: no stored row and source env keeps Reset disabled', async () => {
    await open(false);
    expect(reset()).toBeDisabled();
  });
});
