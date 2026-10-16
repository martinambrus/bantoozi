import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import { feedsServer, makeSubscription, LIST } from './support.js';

const { open } = createHarness();
afterEach(() => vi.useRealTimers());

describe('the visible feed update schedule', () => {
  it('refreshes subscription timing when the next account update arrives', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-16T10:44:55Z'), shouldAdvanceTime: true });
    const { server, state } = feedsServer({
      me: makeMe({ timezone: 'UTC' }),
      subscriptions: [
        makeSubscription({
          feed: {
            id: '608',
            title: 'Scheduled',
            updateIntervalS: 900,
            nextUpdateAt: '2026-10-16T10:45:00Z',
            intervalReason: 'plan',
          },
        }),
      ],
    });
    const app = await open({ path: '/feeds', server });
    await screen.findByRole('heading', { name: 'Feeds', level: 1 });
    const calls = app.calls(LIST).length;
    state.subscriptions = [
      makeSubscription({
        feed: {
          id: '608',
          title: 'Scheduled',
          updateIntervalS: 900,
          nextUpdateAt: '2026-10-16T11:00:00Z',
          intervalReason: 'plan',
        },
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(app.calls(LIST).length).toBeGreaterThan(calls);
    expect(screen.getByText(/Next update at 11:00/)).toBeVisible();
  });
  it('shows the source-limited cadence and next update in both the feed row and its settings', async () => {
    const subscription = makeSubscription({
      feed: {
        id: '5',
        title: 'Alpha',
        updateIntervalS: 1800,
        nextUpdateAt: '2026-10-16T10:45:00.000Z',
        intervalReason: 'source',
      },
    });
    const { server } = feedsServer({
      me: makeMe({ timezone: 'Europe/Bratislava' }),
      subscriptions: [subscription],
    });
    const app = await open({ path: '/feeds', server });
    expect(
      await screen.findByText('Updates every 30 minutes — limited by the source'),
    ).toBeVisible();
    expect(screen.getByText(/Next update at 12:45/)).toBeVisible();
    await app.user.click(screen.getByRole('button', { name: 'Settings for Alpha' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Feed settings' }));
    expect(dialog.getByText('Updates every 30 minutes — limited by the source')).toBeVisible();
    expect(dialog.getByText(/Next update at 12:45/)).toBeVisible();
  });
});
