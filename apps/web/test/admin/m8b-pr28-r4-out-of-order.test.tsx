import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { bodyOf, renderApp } from '../support/app.js';
import { patchAnswer, runtimeSettings, worker } from './m8b-t10-support.js';
import { adminMe, adminRoutes, unhandledGuard } from './support.js';

/**
 * PR #28 Codex round 4: two editors save at once and the first answer arrives after the second.
 * The late answer holds all settings as they stood when it was made, so it must change only the
 * metadata of the key it saved (source, default, stored time), never the other key's or the
 * workers' status.
 */

const guard = unhandledGuard();
const PATCH = 'PATCH /admin/settings';
const A = 'engine.concurrency';
const B = 'ingest.max_age_days';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

const group = (key: string) => screen.getByRole('group', { name: key });

describe('out-of-order save answers', () => {
  it('a late answer for key A leaves key B source and the workers status as the newer answer set them', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    // The server's state: a worker waits for a restart once B is stored.
    const stored: Record<string, unknown> = {};
    const serverState = () =>
      runtimeSettings({
        stored: { ...stored } as never,
        workers: [worker({ pendingRestart: B in stored })],
      });
    const app = guard(
      await renderApp({
        path: '/admin/settings',
        server: {
          me: adminMe(),
          routes: adminRoutes({
            'GET /admin/settings': () => json(200, serverState()),
            [PATCH]: async (request) => {
              const patch = bodyOf(request) as Record<string, unknown>;
              if (A in patch) {
                // Answered with the state as it was when A was stored, before B existed.
                const before = { ...stored, ...patch };
                Object.assign(stored, patch);
                await gateA;
                return patchAnswer(patch, { stored: before as never, workers: [worker()] });
              }
              Object.assign(stored, patch);
              return patchAnswer(patch, {
                stored: { ...stored } as never,
                workers: [worker({ pendingRestart: true })],
              });
            },
          }),
        },
      }),
    );
    await screen.findByRole('group', { name: 'Decision engine (Jev)' });

    const inputA = within(group(A)).getByLabelText(A);
    await app.user.clear(inputA);
    await app.user.type(inputA, '12');
    await app.user.click(screen.getByRole('button', { name: `Save ${A}` }));
    await waitFor(() => expect(app.calls(PATCH)).toHaveLength(1));

    const inputB = within(group(B)).getByLabelText(B);
    await app.user.clear(inputB);
    await app.user.type(inputB, '30');
    await app.user.click(screen.getByRole('button', { name: `Save ${B}` }));
    await within(group(B)).findByText('Source: stored');
    expect(await screen.findByText(/Pending restart: 1 of 1/)).toBeVisible();

    releaseA();
    await within(group(A)).findByText('Source: stored');
    // Let the late answer and the snapshot read that follows it settle.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The late answer had B as "environment"; B keeps what its own answer set.
    expect(within(group(B)).getByText('Source: stored')).toBeVisible();
    expect(screen.getByText(/Pending restart: 1 of 1/)).toBeVisible();
  });
});
