import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { makeMe } from '../session/fixtures.js';
import {
  HOUR_MS,
  LIST,
  ago,
  feedIn,
  feedsServer,
  findRow,
  makeSubscription,
  rowOf,
  type FeedsServerOptions,
} from './support.js';

const { open } = createHarness();

async function openFeeds(options: FeedsServerOptions = {}) {
  const { server, state } = feedsServer(options);
  const app = await open({ path: '/feeds', server });
  await screen.findByRole('heading', { level: 1, name: 'Feeds' });
  return { app, server, state };
}

describe('the feed list', () => {
  it('shows the title override first, then the feed title, then the feed address', async () => {
    await openFeeds({
      subscriptions: [
        makeSubscription({ feed: { id: '1', title: 'Original' }, titleOverride: 'My name' }),
        makeSubscription({ feed: { id: '2', title: 'Plain' } }),
        makeSubscription({ feed: { id: '3', title: null, url: 'https://untitled.example/rss' } }),
      ],
    });

    const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(titles).toHaveLength(3);
    expect(titles).toEqual(
      expect.arrayContaining(['My name', 'Plain', 'https://untitled.example/rss']),
    );
    expect(screen.queryByRole('heading', { name: 'Original' })).not.toBeInTheDocument();
  });

  it('lists the feeds of a group alphabetically by the title they are shown with', async () => {
    await openFeeds({
      subscriptions: [
        makeSubscription({ feed: { id: '1', title: 'Zebra' } }),
        makeSubscription({ feed: { id: '2', title: 'Yak' }, titleOverride: 'Ant' }),
        makeSubscription({ feed: { id: '3', title: 'bee' } }),
      ],
    });

    const titles = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(titles).toEqual(['Ant', 'bee', 'Zebra']);
  });

  it('names every feed on its settings button', async () => {
    await openFeeds({
      subscriptions: [
        makeSubscription({ feed: { id: '1', title: 'Alpha' } }),
        makeSubscription({ feed: { id: '2', title: 'Beta' } }),
      ],
    });

    expect(await screen.findByRole('button', { name: 'Settings for Alpha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Settings for Beta' })).toBeVisible();
  });

  describe('health', () => {
    it.each([
      ['active', 'Working'],
      ['quarantined', 'Having problems'],
      ['dead', 'Stopped'],
      ['paused', 'Paused'],
    ] as const)('says %s in words and shows an icon', async (status, word) => {
      await openFeeds({
        subscriptions: [makeSubscription({ feed: { id: '1', title: 'Alpha', status } })],
      });

      const badge = within(await findRow('Alpha')).getByText(word);
      expect(badge.querySelector('svg')).not.toBeNull();
      expect(badge).toHaveTextContent(`Feed status: ${word}`);
    });

    it('shows a feed that was never fetched as not updated yet', async () => {
      await openFeeds({
        subscriptions: [
          makeSubscription({ feed: { id: '1', title: 'Alpha', lastSuccessAt: null } }),
        ],
      });

      expect(within(await findRow('Alpha')).getByText('Not updated yet')).toBeVisible();
    });

    it('shows the last success relative to now, with the exact time on the element', async () => {
      const lastSuccessAt = ago(3 * HOUR_MS);
      await openFeeds({
        subscriptions: [makeSubscription({ feed: { id: '1', title: 'Alpha', lastSuccessAt } })],
      });

      const updated = await screen.findByText('Updated 3 hours ago');
      expect(updated.tagName).toBe('TIME');
      expect(updated).toHaveAttribute('datetime', lastSuccessAt);
    });
  });

  describe('the last error', () => {
    it.each([
      ['FEED_DNS_ERROR', "We couldn't find that website."],
      ['FEED_TIMEOUT', 'The website took too long to answer.'],
      ['FEED_HTTP_503', 'The website answered with an error (503).'],
      ['SOMETHING_NEW', "We couldn't fetch it."],
    ])('localizes %s for a feed that has problems', async (code, message) => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: {
              id: '1',
              title: 'Alpha',
              status: 'quarantined',
              lastErrorCode: code,
              lastErrorAt: ago(HOUR_MS),
            },
          }),
        ],
      });

      expect(await screen.findByText(`Last error: ${message}`)).toBeVisible();
    });

    it('shows a failure that came after the last success on a feed that is still active', async () => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: {
              id: '1',
              title: 'Alpha',
              lastSuccessAt: ago(5 * HOUR_MS),
              lastErrorCode: 'FEED_TIMEOUT',
              lastErrorAt: ago(HOUR_MS),
            },
          }),
        ],
      });

      expect(
        await screen.findByText('Last error: The website took too long to answer.'),
      ).toBeVisible();
    });

    it('does not repeat an error the feed has recovered from', async () => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: {
              id: '1',
              title: 'Alpha',
              lastSuccessAt: ago(HOUR_MS),
              lastErrorCode: 'FEED_TIMEOUT',
              lastErrorAt: ago(5 * HOUR_MS),
            },
          }),
        ],
      });

      await screen.findByRole('heading', { level: 3, name: 'Alpha' });
      expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
    });

    it('shows nothing for a feed without an error', async () => {
      await openFeeds({ subscriptions: [makeSubscription({ feed: { id: '1', title: 'Alpha' } })] });

      await screen.findByRole('heading', { level: 3, name: 'Alpha' });
      expect(screen.queryByText(/Last error/)).not.toBeInTheDocument();
    });
  });

  describe('the classification badge', () => {
    it.each([
      ['off', 'Off'],
      ['training', 'Training: selected articles'],
      ['active', 'Active: new articles'],
    ] as const)('says %s as "%s"', async (inferenceMode, word) => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: { id: '1', title: 'Alpha' },
            inferenceMode,
            inferenceActivatedAt: inferenceMode === 'active' ? ago(HOUR_MS) : null,
          }),
        ],
      });

      const badge = within(await findRow('Alpha')).getByText(word);
      expect(badge).toHaveTextContent(`Classification: ${word}`);
    });
  });

  describe('unread counts', () => {
    it('lists the lanes that have unread articles', async () => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: { id: '1', title: 'Alpha' },
            unread: { forYou: 3, maybe: 2, everything: 10, new: 5 },
          }),
        ],
      });

      const counts = within(await findRow('Alpha')).getByRole('list', { name: 'Unread articles' });
      expect(
        within(counts)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['For you 3', 'Maybe 2', 'Everything else 10', 'New 5']);
    });

    it('leaves out the lanes without unread articles', async () => {
      await openFeeds({
        subscriptions: [
          makeSubscription({
            feed: { id: '1', title: 'Alpha' },
            unread: { forYou: 0, maybe: 0, everything: 0, new: 7 },
          }),
        ],
      });

      const counts = within(await findRow('Alpha')).getByRole('list', { name: 'Unread articles' });
      expect(
        within(counts)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['New 7']);
    });

    it('says so when nothing is unread', async () => {
      await openFeeds({ subscriptions: [makeSubscription({ feed: { id: '1', title: 'Alpha' } })] });

      const row = await findRow('Alpha');
      expect(within(row).getByText('No unread articles')).toBeVisible();
      expect(within(row).queryByRole('list', { name: 'Unread articles' })).toBeNull();
    });
  });

  describe('in Slovak', () => {
    it('speaks Slovak: words, plural forms of the folder counts and relative time', async () => {
      const { server } = feedsServer({
        me: makeMe({ locale: 'sk' }),
        subscriptions: [
          makeSubscription({
            feed: { id: '1', title: 'Alpha', lastSuccessAt: ago(3 * HOUR_MS) },
            folder: 'Jeden',
            unread: { forYou: 3, maybe: 0, everything: 0, new: 0 },
          }),
          feedIn('Dva', 'Beta', '2'),
          feedIn('Dva', 'Gamma', '3'),
          ...['4', '5', '6', '7', '8'].map((id) => feedIn('Päť', `Zdroj ${id}`, id)),
        ],
      });
      await open({ path: '/feeds', server, language: 'sk' });

      expect(await screen.findByRole('heading', { level: 1, name: 'Zdroje' })).toBeVisible();
      for (const count of ['1 zdroj', '2 zdroje', '5 zdrojov']) {
        expect(await screen.findByText(count)).toBeVisible();
      }
      const row = rowOf('Alpha');
      expect(within(row).getByText('Aktualizované pred 3 hodinami')).toBeVisible();
      expect(within(row).getByText('Funguje')).toHaveTextContent('Stav zdroja: Funguje');
      expect(within(row).getByText('Vypnutá')).toHaveTextContent('Klasifikácia: Vypnutá');
      expect(within(row).getByText('Pre vás')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Nastavenia zdroja Alpha' })).toBeVisible();
    });
  });

  describe('states', () => {
    it('invites you to add the first feed, with the add form in reach', async () => {
      await openFeeds({ subscriptions: [] });

      expect(await screen.findByText('Add your first feed')).toBeVisible();
      expect(screen.getByLabelText('Website or feed address')).toBeVisible();
    });

    it('shows a loading state while the list is on its way', async () => {
      const { server } = feedsServer();
      server.routes[LIST] = () => new Promise<Response>(() => undefined);
      await open({ path: '/feeds', server });

      expect(await screen.findByRole('status', { name: 'Loading…' })).toBeVisible();
      expect(screen.getByRole('heading', { level: 1, name: 'Feeds' })).toBeVisible();
    });

    it('explains an error and retries on request', async () => {
      const { app, server, state } = await openFeeds({
        routes: { [LIST]: () => failure(500, 'INTERNAL') },
      });
      state.subscriptions = [makeSubscription({ feed: { id: '1', title: 'Alpha' } })];

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );
      server.routes[LIST] = () => json(200, state.subscriptions);
      await app.user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('heading', { level: 3, name: 'Alpha' })).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says you are offline when the server cannot be reached, and retries', async () => {
      const { app, server } = await openFeeds({
        routes: { [LIST]: () => Promise.reject(new TypeError('Failed to fetch')) },
      });

      expect(await screen.findByText("You're offline")).toBeVisible();
      server.routes[LIST] = () =>
        json(200, [makeSubscription({ feed: { id: '1', title: 'Beta' } })]);
      await app.user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('heading', { level: 3, name: 'Beta' })).toBeVisible();
    });
  });
});
