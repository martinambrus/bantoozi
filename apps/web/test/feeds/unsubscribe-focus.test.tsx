import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json, noContent } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { createReaderHarness, item } from '../reader/support.js';
import { DELETE_FEED, feedsServer, makeSubscription } from './support.js';

const FAILED_AT = '2026-10-01T08:00:00.000Z';

const dead = () =>
  makeSubscription({
    feed: {
      id: '9',
      title: 'Dead Blog',
      status: 'dead',
      lastErrorCode: 'FEED_DNS_ERROR',
      lastErrorAt: FAILED_AT,
    },
  });

/** Nothing the person can read from has the focus, but the page still has a place for it. */
function expectFocusInsideMain() {
  expect(document.body).not.toHaveFocus();
  expect(screen.getByRole('main')).toContainElement(document.activeElement as HTMLElement);
}

const confirmName = 'Unsubscribe from “Dead Blog”?';

describe('the focus after unsubscribing on the feeds page', () => {
  const { open } = createHarness();

  async function openFeeds() {
    const { server, state } = feedsServer({
      subscriptions: [dead(), makeSubscription({ feed: { id: '2', title: 'Fine Blog' } })],
    });
    server.routes[DELETE_FEED] = (_request, params) => {
      state.subscriptions = state.subscriptions.filter((sub) => sub.feed.id !== params['feedId']);
      return noContent();
    };
    const app = await open({ path: '/feeds', server });
    await screen.findByRole('heading', { level: 3, name: 'Dead Blog' });
    return app;
  }

  const gone = () =>
    waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Dead Blog' }),
      ).not.toBeInTheDocument(),
    );

  it('stays in the page when the question was asked by the notice of the feed', async () => {
    const app = await openFeeds();
    const row = screen.getByRole('heading', { level: 3, name: 'Dead Blog' }).closest('li')!;

    await app.user.click(within(row).getByRole('button', { name: 'Unsubscribe' }));
    const confirm = await screen.findByRole('dialog', { name: confirmName });
    await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

    await gone();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectFocusInsideMain();
  });

  it('stays in the page when the question was asked by the settings of the feed', async () => {
    const app = await openFeeds();

    await app.user.click(screen.getByRole('button', { name: 'Settings for Dead Blog' }));
    const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
    await app.user.click(within(sheet).getByRole('button', { name: 'Unsubscribe' }));
    const confirm = await screen.findByRole('dialog', { name: confirmName });
    await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

    await gone();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectFocusInsideMain();
  });
});

describe('the focus after unsubscribing in the view of the feed', () => {
  const { open } = createReaderHarness();

  it('stays in the page when the question was asked by the notice of the feed', async () => {
    let subscriptions = [dead(), makeSubscription({ feed: { id: '3' } })];
    const { app } = await open({
      path: '/read/feed/9',
      items: [item(1), item(2)],
      routes: {
        'GET /subscriptions': () => json(200, subscriptions),
        [DELETE_FEED]: () => {
          subscriptions = subscriptions.filter((sub) => sub.feed.id !== '9');
          return noContent();
        },
      },
    });
    await screen.findByText(/stopped working/);

    await app.user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    const confirm = await screen.findByRole('dialog', { name: confirmName });
    await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

    await waitFor(() => expect(screen.queryByText(/stopped working/)).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectFocusInsideMain();
  });
});
