import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { findToast, makeLabel, ratingResponse, undoResponse } from '../article/harness.js';
import { makeSubscription, type SubscriptionOverrides } from '../feeds/support.js';
import { makeMe } from '../session/fixtures.js';
import { acked } from './actions/fake-transport.js';
import { createReaderHarness, item, rowOf, sidebar } from './support.js';

const { open } = createReaderHarness();

const lanes = () => screen.getByRole('list', { name: 'Lanes' });
const laneNames = () =>
  within(lanes())
    .getAllByRole('link')
    .map((link) => link.textContent);

function feed(
  id: string,
  title: string,
  folder: string | null,
  overrides: SubscriptionOverrides = {},
) {
  return makeSubscription({ ...overrides, feed: { id, title, ...overrides.feed }, folder });
}

describe('the reader sidebar lanes', () => {
  it('lists the lanes in order with the unread counts of the global counts', async () => {
    await open({
      path: '/read/for_you',
      counts: { forYou: 3, maybe: 4, everything: 12, new: 5, bookmarks: 2 },
    });

    expect(screen.getByRole('navigation', { name: 'Reader navigation' })).toBeInTheDocument();
    await within(lanes()).findByRole('link', { name: 'For you Unread: 3' });
    expect(laneNames()).toEqual([
      'For you Unread: 3',
      'Maybe help me learn Unread: 4',
      'Everything else Unread: 12',
      'New Unread: 5',
      'Bookmarks Saved: 2',
    ]);
    expect(within(lanes()).getByRole('link', { name: 'For you Unread: 3' })).toHaveAttribute(
      'href',
      '/read/for_you',
    );
    expect(within(lanes()).getByRole('link', { name: 'Bookmarks Saved: 2' })).toHaveAttribute(
      'href',
      '/read/bookmarks',
    );
  });

  it('shows no number for a lane with nothing unread', async () => {
    await open({ path: '/read/for_you', counts: { forYou: 0, maybe: 1 } });

    await within(lanes()).findByRole('link', { name: 'Maybe help me learn Unread: 1' });
    expect(within(lanes()).getByRole('link', { name: 'For you' })).toBeInTheDocument();
  });

  it('asks for the counts of the whole account at the tier of the reader', async () => {
    const { app } = await open({
      path: '/read/maybe',
      me: makeMe({ preferences: { defaultTier: 3 } }),
    });

    await within(lanes()).findByRole('link', { name: 'For you Unread: 3' });
    expect(app.calls('GET /articles/counts').map((call) => Object.fromEntries(call.query))).toEqual(
      [{ minTier: '3' }],
    );
  });

  it('leaves Everything else out when the preference hides it', async () => {
    await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { hideEverything: true } }),
    });

    await within(lanes()).findByRole('link', { name: 'For you Unread: 3' });
    expect(laneNames()).toEqual([
      'For you Unread: 3',
      'Maybe help me learn Unread: 4',
      'New Unread: 5',
      'Bookmarks Saved: 2',
    ]);
    expect(screen.queryByRole('button', { name: 'Everything else lane' })).toBeNull();
  });

  it('folds Everything else away and back', async () => {
    const { app } = await open({ path: '/read/for_you' });
    const toggle = await screen.findByRole('button', { name: 'Everything else lane' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      await within(lanes()).findByRole('link', { name: 'Everything else Unread: 12' }),
    ).toBeVisible();

    await app.user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(lanes()).queryByRole('link', { name: /^Everything else/ })).toBeNull();
    expect(within(lanes()).getByRole('link', { name: /^New/ })).toBeVisible();

    await app.user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(lanes()).getByRole('link', { name: 'Everything else Unread: 12' })).toBeVisible();
  });

  it('keeps Everything else folded when the reader moves from a lane to a feed', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [feed('2', 'Verge', null)],
    });
    await app.user.click(await screen.findByRole('button', { name: 'Everything else lane' }));

    await app.user.click(await screen.findByRole('link', { name: 'Verge' }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/feed/2'));
    expect(screen.getByRole('button', { name: 'Everything else lane' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('the reader sidebar feeds and folders', () => {
  it('orders the folders as saved, then unknown ones alphabetically, then feeds without a folder', async () => {
    await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { folderOrder: ['Tech', 'News', 'Gone'] } }),
      subscriptions: [
        feed('1', 'BBC', 'News'),
        feed('2', 'Verge', 'Tech'),
        feed('3', 'Zed', 'Zeta'),
        feed('4', 'Aye', 'Alpha'),
        feed('5', 'Loose', null),
        feed('6', 'Another', 'Tech'),
      ],
    });

    await screen.findByRole('link', { name: 'Verge' });
    const feeds = screen.getByRole('list', { name: 'Feeds' });
    expect(
      within(feeds)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Tech', 'Another', 'Verge', 'News', 'BBC', 'Alpha', 'Aye', 'Zeta', 'Zed', 'Loose']);
    expect(within(feeds).getByRole('link', { name: 'Tech' })).toHaveAttribute(
      'href',
      '/read/folder/Tech',
    );
    expect(within(feeds).getByRole('link', { name: 'Verge' })).toHaveAttribute(
      'href',
      '/read/feed/2',
    );
  });

  it('encodes a folder name in its link', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [feed('1', 'Dnes', 'Správy / SK')],
    });

    const link = await screen.findByRole('link', { name: 'Správy / SK' });

    expect(link).toHaveAttribute('href', '/read/folder/Spr%C3%A1vy%20%2F%20SK');
  });

  it('leaves out hidden subscriptions, and a folder with nothing else in it', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'Visible', 'Tech'),
        feed('2', 'Secret', 'Tech', { hidden: true }),
        feed('3', 'Only hidden', 'Private', { hidden: true }),
      ],
    });

    await screen.findByRole('link', { name: 'Visible' });
    expect(screen.queryByRole('link', { name: 'Secret' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Only hidden' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Private' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Tech' })).toBeInTheDocument();
  });

  it('names a feed by its title override and counts the unread articles of all its lanes', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'Verge', 'Tech', {
          titleOverride: 'My Verge',
          unread: { forYou: 1, maybe: 2, everything: 3, new: 4 },
        }),
        feed('2', 'Wired', 'Tech', { unread: { forYou: 5, maybe: 0, everything: 0, new: 0 } }),
        feed('3', 'Quiet', 'Tech'),
      ],
    });

    expect(await screen.findByRole('link', { name: 'My Verge Unread: 10' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Verge/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Wired Unread: 5' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quiet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tech Unread: 15' })).toBeInTheDocument();
  });

  it('marks a feed that has problems with a named warning, and no other', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'Flaky', null, { feed: { status: 'quarantined' } }),
        feed('2', 'Steady', null),
      ],
    });

    const flaky = (await screen.findByRole('link', { name: 'Flaky' })).closest('li')!;
    const steady = screen.getByRole('link', { name: 'Steady' }).closest('li')!;

    expect(within(flaky).getByRole('img', { name: 'Feed status: Having problems' })).toBeVisible();
    expect(within(steady).queryByRole('img')).toBeNull();
    expect(screen.getAllByRole('img', { name: /Feed status/ })).toHaveLength(1);
  });

  it('says in words whether a feed is classified', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'Quiet', null, { inferenceMode: 'off' }),
        feed('2', 'Learner', null, { inferenceMode: 'training' }),
        feed('3', 'Auto', null, { inferenceMode: 'active' }),
      ],
    });

    const rowOf = async (title: string) =>
      (await screen.findByRole('link', { name: title })).closest('li')!;

    expect(within(await rowOf('Quiet')).getByText('Off')).toBeVisible();
    expect(within(await rowOf('Learner')).getByText('Training: selected articles')).toBeVisible();
    expect(within(await rowOf('Auto')).getByText('Active: new articles')).toBeVisible();
  });

  it('says when there are no feeds', async () => {
    await open({ path: '/read/for_you', subscriptions: [] });

    expect(await within(sidebar()).findByText('No feeds yet.')).toBeVisible();
  });
});

describe('the reader sidebar labels', () => {
  it('lists the labels with their colour and links them to their view', async () => {
    await open({
      path: '/read/for_you',
      labels: [makeLabel('11', 'Climate', '#0ea5e9'), makeLabel('12', 'Chips', '#f97316')],
    });

    const climate = await screen.findByRole('link', { name: 'Climate' });
    const chips = screen.getByRole('link', { name: 'Chips' });

    expect(climate).toHaveAttribute('href', '/read/label/11');
    expect(chips).toHaveAttribute('href', '/read/label/12');
    expect(climate.querySelector('[aria-hidden="true"]')).toHaveStyle({
      backgroundColor: '#0ea5e9',
    });
    expect(chips.querySelector('[aria-hidden="true"]')).toHaveStyle({
      backgroundColor: '#f97316',
    });
    const labels = screen.getByRole('list', { name: 'Labels' });
    expect(
      within(labels)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Climate', 'Chips']);
  });

  it('says when there are no labels', async () => {
    await open({ path: '/read/for_you', labels: [] });

    expect(await within(sidebar()).findByText('No labels yet.')).toBeVisible();
  });
});

describe('the current view in the sidebar', () => {
  const subscriptions = [feed('2', 'Verge', 'Tech')];
  const labels = [makeLabel('11', 'Climate')];

  it.each([
    ['a lane', '/read/maybe', () => within(lanes()).getByRole('link', { name: /^Maybe/ })],
    [
      'the bookmarks lane',
      '/read/bookmarks',
      () => within(lanes()).getByRole('link', { name: /^Bookmarks/ }),
    ],
    ['a feed', '/read/feed/2', () => screen.getByRole('link', { name: 'Verge' })],
    [
      'a feed in another lane of it',
      '/read/feed/2?lane=maybe',
      () => screen.getByRole('link', { name: 'Verge' }),
    ],
    ['a folder', '/read/folder/Tech', () => screen.getByRole('link', { name: 'Tech' })],
    ['a label', '/read/label/11', () => screen.getByRole('link', { name: 'Climate' })],
  ])('marks %s with aria-current', async (_name, path, current) => {
    await open({ path, subscriptions, labels });
    await screen.findByRole('link', { name: 'Climate' });

    const link = current();

    expect(link).toHaveAttribute('aria-current', 'page');
    const marked = within(sidebar())
      .getAllByRole('link')
      .filter((candidate) => candidate.getAttribute('aria-current') === 'page');
    expect(marked).toEqual([link]);
  });
});

describe('the hidden view in the sidebar', () => {
  it('is not a lane of the sidebar, so no link is current there', async () => {
    await open({ path: '/read/hidden', subscriptions: [feed('2', 'Verge', 'Tech')] });

    await screen.findByRole('link', { name: 'Verge' });
    expect(
      within(sidebar())
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toEqual([]);
  });
});

describe('the reader sidebar on a narrow screen', () => {
  it('moves the lanes to a top bar and the rest behind a menu button', async () => {
    const { app } = await open({
      path: '/read/maybe',
      desktop: false,
      subscriptions: [feed('2', 'Verge', 'Tech')],
    });

    expect(screen.queryByRole('navigation', { name: 'Reader navigation' })).toBeNull();
    const lanesBar = await screen.findByRole('navigation', { name: 'Lane switcher' });
    expect(await within(lanesBar).findByRole('link', { name: 'For you Unread: 3' })).toBeVisible();
    expect(within(lanesBar).getByRole('link', { name: /^Maybe/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await app.user.click(screen.getByRole('button', { name: 'Browse feeds and labels' }));

    const sheet = screen.getByRole('dialog', { name: 'Feeds and labels' });
    const link = await within(sheet).findByRole('link', { name: 'Verge' });
    await app.user.click(link);

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/feed/2'));
    expect(screen.queryByRole('dialog', { name: 'Feeds and labels' })).toBeNull();
  });
});

describe('the unread numbers of the feeds', () => {
  const verge = (unread: number) =>
    feed('7', 'Verge', null, { unread: { forYou: 0, maybe: 0, everything: 0, new: unread } });
  const story = item(1, { feed: { id: '7', title: 'Verge', iconUrl: null } });
  const liked = acked(story, { rating: 1 });

  async function openFeed() {
    const opened = await open({
      path: '/read/feed/7',
      items: [story],
      subscriptions: [verge(2)],
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(liked),
        'POST /articles/undo': () => undoResponse(acked(liked, { rating: null })),
      },
    });
    expect(await screen.findByRole('link', { name: 'Verge Unread: 2' })).toBeInTheDocument();
    return opened;
  }

  it('follow a rating the person makes, without a reload', async () => {
    const { app, state } = await openFeed();
    state.subscriptions = [verge(1)];

    await app.user.click(within(rowOf('Article 1')).getByRole('button', { name: 'Like' }));

    expect(await screen.findByRole('link', { name: 'Verge Unread: 1' })).toBeInTheDocument();
  });

  it('follow the undo of a rating', async () => {
    const { app, state } = await openFeed();
    state.subscriptions = [verge(1)];
    await app.user.click(within(rowOf('Article 1')).getByRole('button', { name: 'Like' }));
    await screen.findByRole('link', { name: 'Verge Unread: 1' });
    state.subscriptions = [verge(2)];

    await app.user.click(
      within(await findToast('Marked as liked')).getByRole('button', { name: 'Undo' }),
    );

    expect(await screen.findByRole('link', { name: 'Verge Unread: 2' })).toBeInTheDocument();
  });
});
