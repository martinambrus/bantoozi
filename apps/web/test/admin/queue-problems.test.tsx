import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '../support/app.js';
import { runtimeRoutes, worker } from './m8b-t10-support.js';
import { adminMe, unhandledGuard } from './support.js';

const guard = unhandledGuard();
const message = 'pg-boss queues missing: user.estimate — run the migrate job';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

describe('worker problems without a settings editor', () => {
  it.each([
    ['en', 'Applied by workers', 'Worker problem:'],
    ['sk', 'Použité workermi', 'Problém workera:'],
  ] as const)('shows the worker message once in %s', async (language, title, prefix) => {
    const problems = [
      { key: 'queues.missing', message },
      { key: 'runtime.unknown', message: 'another worker problem' },
      { key: 'fetch.limits', message: 'maxBytes above the limit' },
    ];
    guard(
      await renderApp({
        path: '/admin/settings',
        language,
        server: {
          me: adminMe(),
          routes: runtimeRoutes({
            workers: [worker({ problems }), worker({ processId: 'worker-2', problems })],
          }),
        },
      }),
    );
    const status = await screen.findByRole('status', { name: title });
    expect(within(status).getAllByText(`${prefix} ${message}`)).toHaveLength(1);
    expect(within(status).getByText(`${prefix} another worker problem`)).toBeVisible();
    expect(within(status).queryByText(/maxBytes/)).toBeNull();
    expect(
      within(screen.getByRole('group', { name: 'fetch.limits' })).getByText(
        /maxBytes above the limit/,
      ),
    ).toBeVisible();
  });
});
