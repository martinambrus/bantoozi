import type { AdminSettings } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { renderApp } from '../support/app.js';

import { runtimeSettings } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * D-251: Admin → Settings shows `engine.auto_analysis_daily_cap` in the Decision engine (Jev)
 * group with an integer editor (0..1 000 000), its environment default and a reset. The response
 * carries the new key (value null = the env default, default 1000).
 */

const KEY = 'engine.auto_analysis_daily_cap';
const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

function settingsWithCap(stored: number | null): AdminSettings {
  const base = runtimeSettings() as unknown as AdminSettings & {
    values: Record<string, unknown>;
    defaults: Record<string, unknown>;
    sources: Record<string, unknown>;
    stored: unknown[];
  };
  return {
    ...base,
    values: { ...base.values, [KEY]: stored },
    defaults: { ...base.defaults, [KEY]: 1000 },
    sources: { ...base.sources, [KEY]: stored === null ? 'env' : 'stored' },
    stored:
      stored === null
        ? base.stored
        : [...base.stored, { key: KEY, updatedAt: '2026-05-31T09:00:00.000Z' }],
  } as AdminSettings;
}

async function open(stored: number | null = null) {
  const app = guard(
    await renderApp({
      path: '/admin/settings',
      server: {
        me: adminMe(),
        routes: adminRoutes({ 'GET /admin/settings': () => json(200, settingsWithCap(stored)) }),
      },
    }),
  );
  await screen.findByRole('group', { name: 'Decision engine (Jev)' });
  return app;
}

describe('engine.auto_analysis_daily_cap in Admin → Settings', () => {
  it('sits in the Decision engine group with a number editor starting at the env default', async () => {
    await open();
    const group = screen.getByRole('group', { name: 'Decision engine (Jev)' });
    const key = within(group).getByRole('group', { name: KEY });
    expect(key).toBeVisible();
    const input = within(key).getByLabelText(KEY);
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveValue(1000);
    expect(within(key).getByText('Default: 1000')).toBeVisible();
    expect(within(key).getByRole('button', { name: `Save ${KEY}` })).toBeDisabled();
  });

  it('starts at a stored value', async () => {
    await open(250);
    const key = screen.getByRole('group', { name: KEY });
    expect(within(key).getByLabelText(KEY)).toHaveValue(250);
  });

  it.each(['-1', '1000001', '1.5'])('rejects %s client-side and sends nothing', async (text) => {
    const app = await open();
    const key = screen.getByRole('group', { name: KEY });
    const input = within(key).getByLabelText(KEY);
    await app.user.clear(input);
    await app.user.type(input, text);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(key).getByRole('button', { name: `Save ${KEY}` })).toBeDisabled();
  });

  it('accepts 0 (no automatic analysis) as a value', async () => {
    const app = await open();
    const key = screen.getByRole('group', { name: KEY });
    const input = within(key).getByLabelText(KEY);
    await app.user.clear(input);
    await app.user.type(input, '0');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(within(key).getByRole('button', { name: `Save ${KEY}` })).toBeEnabled();
  });
});
