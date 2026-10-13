import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { renderApp } from '../support/app.js';
import { runtimeSettings } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * PR #28 round 5: an environment default outside the range the editor accepts (here 200 workers, a
 * 3 650 day age) is shown as the default and the screen does not crash; edits keep the field's bounds.
 */
const guard = unhandledGuard();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

describe('out-of-range environment defaults', () => {
  it('renders them in the editors', async () => {
    const wide = runtimeSettings();
    wide.defaults = { ...wide.defaults, 'engine.concurrency': 200, 'ingest.max_age_days': 3650 };
    wide.values = { ...wide.values, 'engine.concurrency': 200, 'ingest.max_age_days': 3650 };
    guard(
      await renderApp({
        path: '/admin/settings',
        server: {
          me: adminMe(),
          routes: adminRoutes({ 'GET /admin/settings': () => json(200, wide) }),
        },
      }),
    );
    await screen.findByRole('group', { name: 'Decision engine (Jev)' });
    const concurrency = screen.getByRole('group', { name: 'engine.concurrency' });
    expect(within(concurrency).getByLabelText('engine.concurrency')).toHaveValue(200);
    expect(within(concurrency).getByText('Default: 200')).toBeVisible();
    expect(
      within(screen.getByRole('group', { name: 'ingest.max_age_days' })).getByText('Default: 3650'),
    ).toBeVisible();
  });
});
