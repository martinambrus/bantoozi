import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import { LEARNING, learningRoute, makeLearning, readyAgreement } from '../learning/fixtures.js';
import { createReaderHarness } from '../reader/support.js';
import { bodyOf } from '../support/app.js';
import { SET_INFERENCE, makeSubscription } from './support.js';

const { open } = createReaderHarness();

async function openReader(articlesPerWeek: number | null, version = '3') {
  const alpha = makeSubscription({
    feed: { id: '5', title: 'Alpha' },
    inferenceMode: 'training',
    inferenceVersion: version,
  });
  let currentVersion = version;
  const result = await open({
    path: '/read/for_you',
    subscriptions: [alpha],
    routes: {
      [LEARNING]: learningRoute(() => makeLearning({}, [readyAgreement('5', { articlesPerWeek })])),
      [SET_INFERENCE]: (request) => {
        const { mode, expectedVersion } = bodyOf(request) as {
          mode: 'active';
          expectedVersion: string;
        };
        if (expectedVersion !== currentVersion) return failure(409, 'STALE_STATE');
        currentVersion = '9';
        return json(200, {
          subscription: { ...alpha, inferenceMode: mode, inferenceVersion: '9' },
        });
      },
    },
  });
  const ask = async () => {
    await result.app.user.click(
      await screen.findByRole('button', { name: 'Enable automatic classification for Alpha' }),
    );
    return screen.findByRole('dialog', { name: 'Enable automatic classification for Alpha?' });
  };
  return { ...result, ask, bump: () => (currentVersion = '4') };
}

describe('the enable-automatic confirmation', () => {
  it('shows the evidence and the weekly volume, and changes nothing until confirmed', async () => {
    const { app, ask } = await openReader(14);

    const dialog = await ask();

    expect(
      within(dialog).getByText(
        /of 10 it rated high you liked 8; of 9 it rated low you disliked 7\./,
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        'About 14 new articles a week will be analyzed as they arrive; older ones stay manual.',
      ),
    ).toBeVisible();
    expect(app.calls(SET_INFERENCE)).toHaveLength(0);

    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls(SET_INFERENCE)).toHaveLength(0);
  });

  it('says it without a number when the volume is not known', async () => {
    const { ask } = await openReader(null);

    const dialog = await ask();

    expect(
      within(dialog).getByText(
        'New articles will be analyzed as they arrive; older ones stay manual.',
      ),
    ).toBeVisible();
  });

  it('switches the feed to active with the version it saw, then closes and refetches the status', async () => {
    const { app, ask } = await openReader(1);
    const dialog = await ask();
    expect(within(dialog).getByText(/^About 1 new article a week/)).toBeVisible();

    await app.user.click(
      within(dialog).getByRole('button', { name: 'Enable automatic classification' }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(SET_INFERENCE).map((request) => bodyOf(request))).toEqual([
      { mode: 'active', expectedVersion: '3' },
    ]);
    expect(
      screen.queryByRole('button', { name: 'Enable automatic classification for Alpha' }),
    ).toBeNull();
  });

  it('stays open with an answer, and reloads the subscriptions, when the setting changed elsewhere', async () => {
    const { app, ask, bump } = await openReader(14);
    const dialog = await ask();
    bump();

    await app.user.click(
      within(dialog).getByRole('button', { name: 'Enable automatic classification' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/changed on another device/);
    expect(screen.getByRole('dialog')).toBeVisible();
    await waitFor(() => expect(app.calls('GET /subscriptions').length).toBeGreaterThan(1));
  });
});
