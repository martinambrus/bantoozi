import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FIRST_FETCH_GIVE_UP_MS,
  isFirstFetchPending,
} from '../../src/features/feeds/subscriptions.js';
import { createHarness } from '../auth/harness.js';
import {
  LIST,
  feedsServer,
  findRow,
  rowOf,
  makeSubscription,
  type FeedsServerOptions,
} from './support.js';

const { open } = createHarness();

afterEach(() => {
  vi.useRealTimers();
});

const waiting = (id: string) =>
  makeSubscription({
    feed: { id, title: `Fresh ${id}`, lastSuccessAt: null, lastErrorAt: null },
  });

async function openFeeds(options: FeedsServerOptions) {
  const { server, state } = feedsServer(options);
  const app = await open({ path: '/feeds', server });
  await screen.findByRole('heading', { level: 1, name: 'Feeds' });
  return { app, state };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('feeds whose first fetch is still queued', () => {
  it('shows a fetching state and polls the list until the worker has fetched the feed', async () => {
    vi.useFakeTimers({ now: Date.now(), shouldAdvanceTime: true });
    const { app, state } = await openFeeds({ subscriptions: [waiting('801')] });
    await advance(500);
    await findRow('Fresh 801');
    const row = () => rowOf('Fresh 801');

    expect(within(row()).getByText('Fetching first articles…')).toBeVisible();
    expect(within(row()).queryByText('Not updated yet')).not.toBeInTheDocument();
    const before = app.calls(LIST).length;

    await advance(7_000);
    expect(app.calls(LIST).length).toBeGreaterThan(before);

    state.subscriptions = [
      makeSubscription({
        feed: { id: '801', title: 'Fresh 801', lastSuccessAt: new Date().toISOString() },
      }),
    ];
    await advance(4_000);
    expect(within(row()).queryByText('Fetching first articles…')).not.toBeInTheDocument();
    const settled = app.calls(LIST).length;
    await advance(10_000);
    expect(app.calls(LIST)).toHaveLength(settled);
  });

  it('gives up after three minutes so a dead worker is not polled forever', async () => {
    vi.useFakeTimers({ now: Date.now(), shouldAdvanceTime: true });
    const { app } = await openFeeds({ subscriptions: [waiting('802')] });
    await advance(500);
    await findRow('Fresh 802');
    const row = () => rowOf('Fresh 802');

    await advance(181_000);
    expect(within(row()).queryByText('Fetching first articles…')).not.toBeInTheDocument();
    expect(within(row()).getByText('Not updated yet')).toBeVisible();
    const settled = app.calls(LIST).length;
    await advance(20_000);
    expect(app.calls(LIST)).toHaveLength(settled);
  });

  it('times the wait per account: another account subscribing to the same feed waits afresh', () => {
    const feed = waiting('805');
    const t0 = 1_000_000;
    expect(isFirstFetchPending(feed, 'account-a', t0)).toBe(true);
    expect(isFirstFetchPending(feed, 'account-a', t0 + FIRST_FETCH_GIVE_UP_MS)).toBe(false);
    expect(isFirstFetchPending(feed, 'account-b', t0 + FIRST_FETCH_GIVE_UP_MS + 1)).toBe(true);
  });

  it('does not call a feed that failed its first fetch fetching', async () => {
    await openFeeds({
      subscriptions: [
        makeSubscription({
          feed: {
            id: '803',
            title: 'Broken',
            lastSuccessAt: null,
            lastErrorAt: new Date().toISOString(),
            lastErrorCode: 'http_500',
          },
        }),
      ],
    });
    expect(screen.queryByText('Fetching first articles…')).not.toBeInTheDocument();
  });
});
