import type { Subscription } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { subscriptionsKey } from '../../src/features/feeds/subscriptions.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { createHarness } from '../auth/harness.js';
import { USER_A_ID } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { CREATE, LIST, feedsServer, makeSubscription, type FeedsServerOptions } from './support.js';

const { open } = createHarness();

type App = Awaited<ReturnType<typeof open>>;

async function openFeeds(options: FeedsServerOptions = {}) {
  const { server, state } = feedsServer(options);
  const app = await open({ path: '/feeds', server });
  await screen.findByRole('heading', { level: 1, name: 'Feeds' });
  return { app, server, state };
}

const addressField = () => screen.getByLabelText('Website or feed address');

async function submit(app: App, address: string) {
  await app.user.type(addressField(), address);
  await app.user.click(screen.getByRole('button', { name: 'Add feed' }));
}

const CANDIDATES = [
  { url: 'https://example.com/feed.xml', title: 'Main feed', type: 'rss' },
  { url: 'https://example.com/comments.atom', title: null, type: 'atom' },
];

describe('adding a feed', () => {
  it('asks for an address, without forcing a scheme', async () => {
    await openFeeds();

    expect(screen.getByRole('heading', { level: 2, name: 'Add a feed' })).toBeVisible();
    const field = addressField();
    expect(field).toBeRequired();
    expect(field).not.toHaveAttribute('type', 'url');
    expect(field).toHaveAttribute('inputmode', 'url');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    expect(field).toHaveAttribute('spellcheck', 'false');
  });

  it('subscribes and says the feed was added when the API answers 201', async () => {
    const added = makeSubscription({ feed: { id: '7', title: 'New Blog' } });
    const { app, server, state } = await openFeeds({
      subscriptions: [makeSubscription({ feed: { id: '1', title: 'Old' } })],
    });
    server.routes[CREATE] = () => {
      state.subscriptions.push(added);
      return json(201, { subscription: added });
    };

    await submit(app, 'example.com/blog');

    expect(await screen.findByText(/^Added “New Blog”\./)).toBeVisible();
    const posts = app.calls(CREATE);
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0]!)).toEqual({ url: 'example.com/blog' });
    expect(posts[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(posts[0]!.headers.get('X-Bantoozi-Client')).toBe('web');
    expect(addressField()).toHaveValue('');
    expect(await screen.findByRole('heading', { level: 3, name: 'New Blog' })).toBeVisible();
    expect(screen.queryByText(/already subscribed/)).not.toBeInTheDocument();
  });

  it('sends the address without the spaces around it', async () => {
    const { app, server } = await openFeeds();
    server.routes[CREATE] = () => json(201, { subscription: makeSubscription() });

    await submit(app, '  example.com/blog  ');

    await waitFor(() => expect(app.calls(CREATE)).toHaveLength(1));
    expect(bodyOf(app.calls(CREATE)[0]!)).toEqual({ url: 'example.com/blog' });
  });

  it('says so when you were already subscribed (200 with the subscription)', async () => {
    const existing = makeSubscription({ feed: { id: '1', title: 'Alpha' }, titleOverride: 'Mine' });
    const { app, server } = await openFeeds({ subscriptions: [existing] });
    server.routes[CREATE] = () => json(200, { subscription: existing });

    await submit(app, 'https://example.com/1.xml');

    expect(await screen.findByText("You're already subscribed to “Mine”.")).toBeVisible();
    expect(screen.queryByText(/^Added/)).not.toBeInTheDocument();
    expect(addressField()).toHaveValue('');
  });

  it('lets you choose when the website offers several feeds, then posts the chosen address anew', async () => {
    const added = makeSubscription({ feed: { id: '8', title: 'Main feed' } });
    const { app, server, state } = await openFeeds();
    server.routes[CREATE] = (request) => {
      const { url } = bodyOf(request) as { url: string };
      if (url === 'example.com') return json(200, { status: 'choose', candidates: CANDIDATES });
      state.subscriptions.push(added);
      return json(201, { subscription: added });
    };

    await submit(app, 'example.com');

    const chooser = await screen.findByRole('region', { name: 'Choose a feed' });
    expect(within(chooser).getByText('Main feed')).toBeVisible();
    expect(within(chooser).getByText('https://example.com/feed.xml')).toBeVisible();
    expect(within(chooser).getByText('rss')).toBeVisible();
    expect(within(chooser).getByText('https://example.com/comments.atom')).toBeVisible();
    expect(within(chooser).getByText('atom')).toBeVisible();
    expect(screen.queryByText(/^Added/)).not.toBeInTheDocument();
    expect(app.calls(CREATE)).toHaveLength(1);
    expect(app.calls(LIST)).toHaveLength(1);

    await app.user.click(within(chooser).getByRole('button', { name: 'Add Main feed' }));

    expect(await screen.findByText(/^Added “Main feed”\./)).toBeVisible();
    const posts = app.calls(CREATE);
    expect(posts).toHaveLength(2);
    expect(bodyOf(posts[1]!)).toEqual({ url: 'https://example.com/feed.xml' });
    const keys = posts.map((post) => post.headers.get('Idempotency-Key'));
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[1]).not.toBe(keys[0]);
    expect(screen.queryByRole('region', { name: 'Choose a feed' })).not.toBeInTheDocument();
    expect(addressField()).toHaveValue('');
    expect(addressField()).toHaveFocus();
    expect(await screen.findByRole('heading', { level: 3, name: 'Main feed' })).toBeVisible();
  });

  it('names a candidate without a title by its address', async () => {
    const { app, server } = await openFeeds();
    server.routes[CREATE] = (request) => {
      const { url } = bodyOf(request) as { url: string };
      return url === 'example.com'
        ? json(200, { status: 'choose', candidates: CANDIDATES })
        : json(201, { subscription: makeSubscription() });
    };

    await submit(app, 'example.com');
    const chooser = await screen.findByRole('region', { name: 'Choose a feed' });
    await app.user.click(
      within(chooser).getByRole('button', { name: 'Add https://example.com/comments.atom' }),
    );

    await waitFor(() => expect(app.calls(CREATE)).toHaveLength(2));
    expect(bodyOf(app.calls(CREATE)[1]!)).toEqual({ url: 'https://example.com/comments.atom' });
  });

  it('closes the chooser without subscribing when you cancel', async () => {
    const { app, server } = await openFeeds();
    server.routes[CREATE] = () => json(200, { status: 'choose', candidates: CANDIDATES });

    await submit(app, 'example.com');
    const chooser = await screen.findByRole('region', { name: 'Choose a feed' });
    await app.user.click(within(chooser).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('region', { name: 'Choose a feed' })).not.toBeInTheDocument();
    expect(app.calls(CREATE)).toHaveLength(1);
    expect(addressField()).toHaveValue('example.com');
    expect(addressField()).toHaveFocus();
  });

  it('moves the focus to the chooser when it appears', async () => {
    const { app, server } = await openFeeds();
    server.routes[CREATE] = () => json(200, { status: 'choose', candidates: CANDIDATES });

    await submit(app, 'example.com');

    expect(await screen.findByRole('heading', { name: 'Choose a feed' })).toHaveFocus();
  });

  it('forgets an earlier result when you add another feed', async () => {
    const { app, server } = await openFeeds();
    server.routes[CREATE] = () =>
      json(201, { subscription: makeSubscription({ feed: { id: '3', title: 'One' } }) });
    await submit(app, 'one.example');
    expect(await screen.findByText(/^Added “One”\./)).toBeVisible();

    server.routes[CREATE] = () => failure(422, 'FEED_NOT_A_FEED');
    await submit(app, 'two.example');

    expect(await screen.findByRole('alert')).toHaveTextContent("That address isn't a feed.");
    expect(screen.queryByText(/^Added/)).not.toBeInTheDocument();
  });

  describe('when it fails', () => {
    it.each([
      ['FEED_DNS_ERROR', "We couldn't find that website."],
      ['FEED_TIMEOUT', 'The website took too long to answer.'],
      ['FEED_NOT_A_FEED', "That address isn't a feed."],
      ['FEED_HTTP_404', 'The website answered with an error (404).'],
    ])('explains %s in words', async (code, message) => {
      const { app, server } = await openFeeds();
      server.routes[CREATE] = () => failure(422, code);

      await submit(app, 'nowhere.example');

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(addressField()).toHaveValue('nowhere.example');
      expect(addressField()).toBeEnabled();
    });

    it('shows how much of the plan is used when the feed limit is reached', async () => {
      const { app, server } = await openFeeds();
      server.routes[CREATE] = () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxFeeds', used: 200, max: 200 });

      await submit(app, 'one.example');

      expect(
        await screen.findByText("You've reached your plan's limit for feeds: 200 of 200."),
      ).toBeVisible();
      expect(screen.getByText('Plan limit reached')).toBeVisible();
    });

    it('explains a server error and lets you try again', async () => {
      const { app, server } = await openFeeds();
      server.routes[CREATE] = () => failure(500, 'INTERNAL');
      await submit(app, 'one.example');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on our side. Try again.',
      );

      server.routes[CREATE] = () =>
        json(201, { subscription: makeSubscription({ feed: { id: '2', title: 'Two' } }) });
      await app.user.click(screen.getByRole('button', { name: 'Add feed' }));

      expect(await screen.findByText(/^Added “Two”\./)).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('while it works', () => {
    it('sends one request even if the button is pressed again', async () => {
      const { app, server } = await openFeeds();
      let answer: (response: Response) => void = () => undefined;
      server.routes[CREATE] = () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        });

      await app.user.type(addressField(), 'slow.example');
      const button = screen.getByRole('button', { name: 'Add feed' });
      await app.user.click(button);
      await app.user.click(button);

      expect(button).toBeDisabled();
      expect(app.calls(CREATE)).toHaveLength(1);
      answer(json(201, { subscription: makeSubscription({ feed: { id: '4', title: 'Slow' } }) }));
      expect(await screen.findByText(/^Added “Slow”\./)).toBeVisible();
    });

    it('keeps an address typed while the request was on its way', async () => {
      const { app, server } = await openFeeds();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.routes[CREATE] = async () => {
        await held;
        return json(201, { subscription: makeSubscription({ feed: { id: '4', title: 'Slow' } }) });
      };

      await submit(app, 'slow.example');
      await waitFor(() => expect(app.calls(CREATE)).toHaveLength(1));
      await app.user.clear(addressField());
      await app.user.type(addressField(), 'next.example');
      release();

      expect(await screen.findByText(/^Added “Slow”\./)).toBeVisible();
      expect(addressField()).toHaveValue('next.example');
    });

    it('keeps an address typed while a chosen feed was on its way', async () => {
      const { app, server } = await openFeeds();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.routes[CREATE] = async (request) => {
        const { url } = bodyOf(request) as { url: string };
        if (url === 'example.com') return json(200, { status: 'choose', candidates: CANDIDATES });
        await held;
        return json(201, {
          subscription: makeSubscription({ feed: { id: '8', title: 'Main feed' } }),
        });
      };

      await submit(app, 'example.com');
      const chooser = await screen.findByRole('region', { name: 'Choose a feed' });
      await app.user.click(within(chooser).getByRole('button', { name: 'Add Main feed' }));
      await waitFor(() => expect(app.calls(CREATE)).toHaveLength(2));
      await app.user.clear(addressField());
      await app.user.type(addressField(), 'next.example');
      release();

      expect(await screen.findByText(/^Added “Main feed”\./)).toBeVisible();
      expect(addressField()).toHaveValue('next.example');
    });

    it('still refreshes the list when the answer comes after the page was left', async () => {
      const { app, server } = await openFeeds();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.routes[CREATE] = async () => {
        await held;
        return json(201, { subscription: makeSubscription({ feed: { id: '4', title: 'Slow' } }) });
      };

      await submit(app, 'slow.example');
      await waitFor(() => expect(app.calls(CREATE)).toHaveLength(1));
      server.routes['GET /labels'] = () => json(200, []);
      await act(async () => {
        await app.router.navigate({ to: '/labels' });
      });
      release();

      await waitFor(() => expect(app.queryClient.isMutating()).toBe(0));
      expect(app.queryClient.getQueryState(subscriptionsKey(USER_A_ID))?.isInvalidated).toBe(true);
    });
  });

  it('sends nothing for an empty or blank address', async () => {
    const { app } = await openFeeds();

    await app.user.click(screen.getByRole('button', { name: 'Add feed' }));
    await app.user.type(addressField(), '   ');
    await app.user.click(screen.getByRole('button', { name: 'Add feed' }));

    expect(app.calls(CREATE)).toHaveLength(0);
  });

  it('refreshes the list after adding, so the new feed shows with its folder-less group', async () => {
    const added: Subscription = makeSubscription({ feed: { id: '9', title: 'Fresh' } });
    const { app, server, state } = await openFeeds({
      subscriptions: [makeSubscription({ feed: { id: '1', title: 'Old' }, folder: 'News' })],
    });
    server.routes[CREATE] = () => {
      state.subscriptions.push(added);
      return json(201, { subscription: added });
    };

    await submit(app, 'fresh.example');

    const loose = await screen.findByRole('region', { name: 'No folder' });
    expect(within(loose).getByRole('heading', { level: 3, name: 'Fresh' })).toBeVisible();
  });
});
