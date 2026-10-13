import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { bodyOf, renderApp } from '../support/app.js';
import { patchAnswer, runtimeSettings, worker } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * PR #28 Codex round 5: the workers list of a newer settings response replaces the list wholesale, so
 * a worker that exited is dropped; an older response (sent earlier, answered later) changes only the
 * key it saved.
 */

const guard = unhandledGuard();
const PATCH = 'PATCH /admin/settings';
const A = 'engine.concurrency';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

const group = (key: string) => screen.getByRole('group', { name: key });

describe('settings response ordering', () => {
  it('a newer answer that lists only worker B drops the exited worker A', async () => {
    let gets = 0;
    const app = guard(
      await renderApp({
        path: '/admin/settings',
        server: {
          me: adminMe(),
          routes: adminRoutes({
            'GET /admin/settings': () => {
              gets += 1;
              // The first read lists A; any later read never answers, so only the save counts.
              return gets === 1
                ? json(
                    200,
                    runtimeSettings({
                      workers: [
                        worker({ processId: 'worker-a', pendingRestart: true }),
                        worker({ processId: 'worker-c', pendingRestart: true }),
                      ],
                    }),
                  )
                : new Promise<never>(() => {});
            },
            [PATCH]: (request) =>
              patchAnswer(bodyOf(request) as Record<string, unknown>, {
                workers: [worker({ processId: 'worker-b', pendingRestart: true })],
              }),
          }),
        },
      }),
    );
    await screen.findByRole('group', { name: 'Decision engine (Jev)' });
    expect(await screen.findByText(/Pending restart: 2 of 2/)).toBeVisible();

    const input = within(group(A)).getByLabelText(A);
    await app.user.clear(input);
    await app.user.type(input, '12');
    await app.user.click(screen.getByRole('button', { name: `Save ${A}` }));
    await within(group(A)).findByText('Source: stored');
    // The exited workers (A, C) are gone: the newer answer lists only B.
    await waitFor(() => expect(screen.getByText(/Pending restart: 1 of 1/)).toBeVisible());
    expect(screen.queryByText(/Pending restart: 2 of 2/)).toBeNull();
  });
});
