import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import {
  LEARNING,
  learningRoute,
  makeAgreement,
  makeLearning,
  readyAgreement,
} from '../learning/fixtures.js';
import { bodyOf } from '../support/app.js';
import { findToast, makeLabel, ratingResponse, undoResponse } from '../article/harness.js';
import { cardDraftRoutes } from '../interests/support.js';
import {
  DELETE_FEED,
  UPDATE_FEED,
  makeSubscription,
  type SubscriptionOverrides,
} from '../feeds/support.js';
import { SIDEBAR_COLLAPSED_KEY } from '../../src/features/reader/sidebar-collapsed.js';
import { makeMe } from '../session/fixtures.js';
import { acked } from './actions/fake-transport.js';
import { createReaderHarness, item, rowOf, sidebar } from './support.js';

const { open } = createReaderHarness();

afterEach(() => {
  localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
});

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

  it('puts a long classification below the full name, ends that feed with a line, and titles every name', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'A feed with a rather long name', 'Tech', { inferenceMode: 'training' }),
        feed('2', 'Quiet', null, { inferenceMode: 'off' }),
      ],
    });

    const learner = await screen.findByRole('link', { name: 'A feed with a rather long name' });
    expect(learner).toHaveAttribute('title', 'A feed with a rather long name');
    const badge = within(learner.closest('li')!).getByText('Training: selected articles');
    expect(learner.parentElement).not.toContainElement(badge);
    expect(learner.closest('li')).toHaveClass('border-b');

    const quiet = screen.getByRole('link', { name: 'Quiet' });
    expect(quiet).toHaveAttribute('title', 'Quiet');
    expect(quiet.parentElement).toContainElement(within(quiet.closest('li')!).getByText('Off'));
    expect(quiet.closest('li')).not.toHaveClass('border-b');
    expect(screen.getByRole('link', { name: 'Tech' })).toHaveAttribute('title', 'Tech');
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

  it('holds the words only a screen reader reads inside the scrolling list of lanes', async () => {
    await open({ path: '/read/maybe', desktop: false });

    const lanesBar = await screen.findByRole('navigation', { name: 'Lane switcher' });
    const list = within(lanesBar).getByRole('list', { name: 'Lanes' });
    const [unread] = await within(list).findAllByText('Unread:');

    // Such a word is positioned absolutely, and out of a list that is not positioned it sticks
    // into the page beyond the screen, which then scrolls sideways.
    expect(unread).toHaveClass('sr-only');
    expect(list).toHaveClass('overflow-x-auto');
    expect(list).toHaveClass('relative');
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

describe('the reader sidebar without a connection', () => {
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));
  const pending = () => new Promise<Response>(() => {});
  const goOffline = () => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  /** Everything the sidebar says, as one text. */
  const said = (name = 'Reader navigation') =>
    screen.getByRole('navigation', { name }).textContent ?? '';

  it('says the feeds and the labels load once the device is back online, and keeps Retry', async () => {
    goOffline();

    await open({
      path: '/read/for_you',
      routes: { 'GET /subscriptions': unreachable, 'GET /labels': unreachable },
    });

    await waitFor(() => {
      expect(said()).toContain('The feeds load once the device is back online.');
      expect(said()).toContain('The labels load once the device is back online.');
    });
    expect(said()).not.toContain("couldn't be loaded");
    const nav = within(sidebar());
    expect(nav.getByRole('button', { name: 'Retry loading feeds' })).toBeVisible();
    expect(nav.getByRole('button', { name: 'Retry loading labels' })).toBeVisible();
  });

  it('says it in Slovak', async () => {
    goOffline();

    await open({
      path: '/read/for_you',
      me: makeMe({ locale: 'sk' }),
      routes: { 'GET /subscriptions': unreachable, 'GET /labels': unreachable },
    });

    await waitFor(() => {
      expect(said('Navigácia čítačky')).toContain(
        'Zdroje sa načítajú, keď bude zariadenie znova online.',
      );
      expect(said('Navigácia čítačky')).toContain(
        'Štítky sa načítajú, keď bude zariadenie znova online.',
      );
    });
    expect(said('Navigácia čítačky')).not.toContain('nepodarilo načítať');
    const nav = within(screen.getByRole('navigation', { name: 'Navigácia čítačky' }));
    expect(nav.getByRole('button', { name: 'Znova načítať zdroje' })).toBeVisible();
    expect(nav.getByRole('button', { name: 'Znova načítať štítky' })).toBeVisible();
  });

  it('says so instead of loading while the requests have not been answered', async () => {
    goOffline();

    await open({
      path: '/read/for_you',
      routes: { 'GET /subscriptions': pending, 'GET /labels': pending },
    });

    await waitFor(() => {
      expect(said()).toContain('The feeds load once the device is back online.');
      expect(said()).toContain('The labels load once the device is back online.');
    });
    expect(said()).not.toContain('Loading…');
  });

  it('loads the feeds and the labels when Retry is pressed and they can be reached', async () => {
    goOffline();
    let reachable = false;
    const answer = (body: unknown) => () => (reachable ? json(200, body) : unreachable());
    const { app } = await open({
      path: '/read/for_you',
      routes: {
        'GET /subscriptions': answer([feed('2', 'Verge', null)]),
        'GET /labels': answer([makeLabel('11', 'Climate')]),
      },
    });
    await waitFor(() => {
      expect(said()).toContain('The feeds load once the device is back online.');
      expect(said()).toContain('The labels load once the device is back online.');
    });
    reachable = true;

    await app.user.click(within(sidebar()).getByRole('button', { name: 'Retry loading feeds' }));
    await app.user.click(within(sidebar()).getByRole('button', { name: 'Retry loading labels' }));

    expect(await screen.findByRole('link', { name: 'Verge' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Climate' })).toBeVisible();
  });

  it('loads the feeds and the labels once the device is back online, without Retry', async () => {
    const online = goOffline();
    let reachable = false;
    const answer = (body: unknown) => () => (reachable ? json(200, body) : unreachable());
    await open({
      path: '/read/for_you',
      routes: {
        'GET /subscriptions': answer([feed('2', 'Verge', null)]),
        'GET /labels': answer([makeLabel('11', 'Climate')]),
      },
    });
    await waitFor(() => {
      expect(said()).toContain('The feeds load once the device is back online.');
      expect(said()).toContain('The labels load once the device is back online.');
    });

    reachable = true;
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(await screen.findByRole('link', { name: 'Verge' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Climate' })).toBeVisible();
  });

  it('keeps the words for a failure when the browser says it is online', async () => {
    await open({
      path: '/read/for_you',
      routes: {
        'GET /subscriptions': () => failure(500, 'INTERNAL'),
        'GET /labels': () => failure(500, 'INTERNAL'),
      },
    });

    const nav = within(sidebar());
    expect(await nav.findByText("The feeds couldn't be loaded.")).toBeVisible();
    expect(nav.getByText("The labels couldn't be loaded.")).toBeVisible();
    expect(nav.queryByText(/back online/)).toBeNull();
  });
});

describe('the collapsed sidebar', () => {
  const subscriptions = [
    feed('1', 'verge', 'Tech', {
      inferenceMode: 'training',
      unread: { forYou: 2, maybe: 0, everything: 0, new: 0 },
    }),
    feed('2', 'Flaky', null, { feed: { status: 'quarantined' } }),
  ];

  it('folds to icons and first letters with full names, and stays folded on this device', async () => {
    const { app } = await open({
      path: '/read/for_you',
      counts: { forYou: 3, bookmarks: 2 },
      subscriptions,
      labels: [makeLabel('11', 'Batteries', '#0ea5e9')],
    });
    await screen.findByRole('link', { name: /^verge/ });
    const collapse = screen.getByRole('button', { name: 'Collapse the sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(collapse).toHaveAttribute('aria-controls', sidebar().id);

    await app.user.click(collapse);

    const expand = screen.getByRole('button', { name: 'Expand the sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
    expect(within(lanes()).getByRole('link', { name: 'For you, Unread: 3' })).toHaveAttribute(
      'href',
      '/read/for_you',
    );
    expect(within(lanes()).getByRole('link', { name: 'Bookmarks, Saved: 2' })).toBeVisible();
    const feeds = within(screen.getByRole('list', { name: 'Feeds' }));
    const verge = feeds.getByRole('link', {
      name: 'verge, Training: selected articles, Unread: 2',
    });
    expect(verge).toHaveAttribute('title', 'verge, Training: selected articles, Unread: 2');
    expect(verge).toHaveTextContent('V');
    expect(feeds.getByRole('link', { name: 'Flaky, Having problems' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Batteries' })).toHaveAttribute(
      'href',
      '/read/label/11',
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens folded when this device folded it, and unfolds again', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    const { app } = await open({ path: '/read/for_you', subscriptions });

    await app.user.click(await screen.findByRole('button', { name: 'Expand the sidebar' }));

    expect(await screen.findByRole('heading', { name: 'Feeds' })).toBeVisible();
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse the sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('is not offered on a narrow screen', async () => {
    await open({ path: '/read/for_you', desktop: false });

    await screen.findByRole('navigation', { name: 'Lane switcher' });
    expect(screen.queryByRole('button', { name: 'Collapse the sidebar' })).toBeNull();
  });
});

describe('ready for automatic classification', () => {
  const SET_INFERENCE = 'POST /subscriptions/:feedId/inference';
  const training = (id: string, title: string) =>
    feed(id, title, null, { inferenceMode: 'training', inferenceVersion: '3' });

  it('offers Enable under the badge of a training feed whose analysis agrees with the ratings', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge'), training('2', 'Wired')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [readyAgreement('1'), makeAgreement('2', 'collecting', { likes: 2 })]),
        ),
      },
    });

    const verge = (await screen.findByRole('link', { name: 'Verge' })).closest('li')!;
    expect(await within(verge).findByText('Ready for automatic')).toBeVisible();
    expect(
      within(verge).getByRole('button', { name: 'Enable automatic classification for Verge' }),
    ).toHaveTextContent('Enable');
    const wired = screen.getByRole('link', { name: 'Wired' }).closest('li')!;
    expect(within(wired).queryByText('Ready for automatic')).toBeNull();
    expect(within(wired).queryByRole('button', { name: /^Enable/ })).toBeNull();
  });

  it('asks nothing when no feed is in training', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [
        feed('1', 'Quiet', null),
        feed('2', 'Auto', null, { inferenceMode: 'active' }),
      ],
    });

    await screen.findByRole('link', { name: 'Quiet' });
    expect(app.calls(LEARNING)).toHaveLength(0);
  });

  it('switches the feed to active only after the confirmation', async () => {
    const sub = training('1', 'Verge');
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [sub],
      routes: {
        [LEARNING]: learningRoute(() => makeLearning({}, [readyAgreement('1')])),
        [SET_INFERENCE]: () =>
          json(200, { subscription: { ...sub, inferenceMode: 'active', inferenceVersion: '4' } }),
      },
    });
    await app.user.click(
      await screen.findByRole('button', { name: 'Enable automatic classification for Verge' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Enable automatic classification for Verge?',
    });
    expect(app.calls(SET_INFERENCE)).toHaveLength(0);

    await app.user.click(
      within(dialog).getByRole('button', { name: 'Enable automatic classification' }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(SET_INFERENCE).map((request) => bodyOf(request))).toEqual([
      { mode: 'active', expectedVersion: '3' },
    ]);
    expect(screen.queryByText('Ready for automatic')).toBeNull();
  });

  it('asks again after a rating is settled', async () => {
    const story = item(1, { feed: { id: '1', title: 'Verge', iconUrl: null } });
    const liked = acked(story, { rating: 1 });
    let agreement = makeAgreement('1', 'collecting');
    const { app } = await open({
      path: '/read/feed/1',
      items: [story],
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() => makeLearning({}, [agreement])),
        'POST /articles/:id/rating': () => ratingResponse(liked),
      },
    });
    await screen.findByRole('link', { name: 'Verge' });
    await waitFor(() => expect(app.calls(LEARNING)).toHaveLength(1));
    agreement = readyAgreement('1');

    await app.user.click(within(rowOf('Article 1')).getByRole('button', { name: 'Like' }));

    expect(await screen.findByText('Ready for automatic')).toBeVisible();
    expect(app.calls(LEARNING)).toHaveLength(2);
  });

  it('names the ready feed in the collapsed strip', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: { [LEARNING]: learningRoute(() => makeLearning({}, [readyAgreement('1')])) },
    });

    const strip = within(await screen.findByRole('list', { name: 'Feeds' }));
    expect(
      await strip.findByRole('link', {
        name: 'Verge, Training: selected articles, ready for automatic classification',
      }),
    ).toBeVisible();
  });
});

describe('feed settings from the sidebar', () => {
  const subscriptions = [feed('1', 'Verge', 'Tech'), feed('2', 'Wired', null)];

  it('opens the settings of a feed with the folders to choose from', async () => {
    const { app } = await open({ path: '/read/for_you', subscriptions });

    await app.user.click(await screen.findByRole('button', { name: 'Settings for Verge' }));

    const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
    expect(sheet).toHaveAccessibleDescription('Verge');
    expect(within(sheet).getByRole('option', { name: 'Tech' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Unsubscribe' })).toBeVisible();
    expect(app.router.state.location.pathname).toBe('/read/for_you');
  });

  it('hides a feed from the sidebar', async () => {
    const { app, state } = await open({
      path: '/read/for_you',
      subscriptions,
      routes: {
        [UPDATE_FEED]: (request, params) => {
          const saved = {
            ...state.subscriptions.find((row) => row.feed.id === params['feedId'])!,
            ...(bodyOf(request) as object),
          };
          state.subscriptions = state.subscriptions.map((row) =>
            row.feed.id === saved.feed.id ? saved : row,
          );
          return json(200, { subscription: saved });
        },
      },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Settings for Wired' }));
    const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
    await app.user.click(within(sheet).getByRole('switch', { name: /Hide from sidebar/ }));
    await app.user.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Wired' })).toBeNull());
    expect(app.calls(UPDATE_FEED).map(bodyOf)).toEqual([{ hidden: true }]);
    expect(screen.queryByRole('dialog', { name: 'Feed settings' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Verge' })).toBeVisible();
  });

  it('unsubscribes after the confirmation', async () => {
    const { app, state } = await open({
      path: '/read/for_you',
      subscriptions,
      routes: {
        [DELETE_FEED]: (_request, params) => {
          state.subscriptions = state.subscriptions.filter(
            (row) => row.feed.id !== params['feedId'],
          );
          return new Response(null, { status: 204 });
        },
      },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Settings for Wired' }));
    const sheet = await screen.findByRole('dialog', { name: 'Feed settings' });
    await app.user.click(within(sheet).getByRole('button', { name: 'Unsubscribe' }));
    const confirm = await screen.findByRole('dialog', { name: 'Unsubscribe from “Wired”?' });
    await app.user.click(within(confirm).getByRole('button', { name: 'Unsubscribe' }));

    expect(await findToast('Unsubscribed from “Wired”.')).toBeVisible();
    expect(app.calls(DELETE_FEED)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Wired' })).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the hint to add interests', () => {
  const training = (id: string, title: string) =>
    feed(id, title, null, { inferenceMode: 'training', inferenceVersion: '3' });
  const uncovered = (suggest: boolean, count = 4) => ({
    count,
    suggest,
    articles: [{ id: 'a1', title: 'Liked' }],
  });
  const HINT = 'Make an interest from what you like in Verge';
  const TEXT =
    'Your interests miss much of what you like in this feed: every card rated 4 articles you liked low. Click to make an interest from them.';

  it('marks a feed whose likes the cards miss, and no other', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge'), training('2', 'Wired')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [
            makeAgreement('1', 'collecting', { uncovered: uncovered(true) }),
            makeAgreement('2', 'collecting', { uncovered: uncovered(false) }),
          ]),
        ),
      },
    });

    const verge = (await screen.findByRole('link', { name: 'Verge' })).closest('li')!;
    expect(await within(verge).findByRole('button', { name: HINT })).toBeVisible();
    const wired = screen.getByRole('link', { name: 'Wired' }).closest('li')!;
    expect(within(wired).queryByRole('button', { name: /^Make an interest/ })).toBeNull();
  });

  it('explains itself as the description of the icon when it has the focus', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [makeAgreement('1', 'collecting', { uncovered: uncovered(true) })]),
        ),
      },
    });
    const hint = await screen.findByRole('button', { name: HINT });
    expect(hint).toHaveAccessibleDescription(TEXT);
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();

    await app.user.tab();
    hint.focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(TEXT);
  });

  it('opens the card editor drafted from those articles, after the gear', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge'), training('2', 'Wired')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [makeAgreement('1', 'collecting', { uncovered: uncovered(true) })]),
        ),
        ...cardDraftRoutes(),
      },
    });
    const hint = await screen.findByRole('button', { name: HINT });
    const row = hint.closest('li')!;
    const buttons = within(row).getAllByRole('button');
    expect(buttons.at(-1)).toBe(hint);
    expect(buttons.at(-2)).toHaveAccessibleName('Settings for Verge');

    await app.user.click(hint);

    expect(await screen.findByRole('dialog', { name: 'New card from this article' })).toBeVisible();
    await waitFor(() =>
      expect(app.calls('POST /cards/drafts').map(bodyOf)).toEqual([{ articleIds: ['a1'] }]),
    );
    expect(screen.queryByRole('dialog', { name: 'Feed settings' })).toBeNull();
  });

  it('names the feed in the collapsed strip', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [makeAgreement('1', 'collecting', { uncovered: uncovered(true) })]),
        ),
      },
    });

    const strip = within(await screen.findByRole('list', { name: 'Feeds' }));
    expect(
      await strip.findByRole('link', {
        name: 'Verge, Training: selected articles, interests to add',
      }),
    ).toBeVisible();
  });
});

describe('the hint to avoid topics', () => {
  const training = (id: string, title: string) =>
    feed(id, title, null, { inferenceMode: 'training', inferenceVersion: '3' });
  const unwanted = (suggest: boolean, count = 4) => ({
    count,
    suggest,
    articles: [{ id: 'd1', title: 'Disliked' }],
  });
  const NEVER_HINT = 'Make a Never card from what you dislike in Verge';
  const TEXT =
    'You often dislike articles in this feed that none of your Never cards hides: 4 of them. Click to make a Never card from them.';

  it('marks a feed whose dislikes no Never card hides, and no other', async () => {
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge'), training('2', 'Wired')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [
            makeAgreement('1', 'collecting', { unwanted: unwanted(true) }),
            makeAgreement('2', 'collecting', { unwanted: unwanted(false) }),
          ]),
        ),
      },
    });

    const verge = (await screen.findByRole('link', { name: 'Verge' })).closest('li')!;
    expect(await within(verge).findByRole('button', { name: NEVER_HINT })).toBeVisible();
    const wired = screen.getByRole('link', { name: 'Wired' }).closest('li')!;
    expect(within(wired).queryByRole('button', { name: /^Make a Never card/ })).toBeNull();
  });

  it('explains itself as the description of the icon when it has the focus', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [makeAgreement('1', 'collecting', { unwanted: unwanted(true) })]),
        ),
      },
    });
    const hint = await screen.findByRole('button', { name: NEVER_HINT });
    expect(hint).toHaveAccessibleDescription(TEXT);

    await app.user.tab();
    hint.focus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent(TEXT);
  });

  it('opens the card editor on Never, after the gear and the bulb', async () => {
    const { app } = await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [
            makeAgreement('1', 'collecting', {
              unwanted: unwanted(true),
              uncovered: { count: 2, suggest: true, articles: [{ id: 'a1', title: 'Liked' }] },
            }),
          ]),
        ),
        ...cardDraftRoutes(),
      },
    });
    const hint = await screen.findByRole('button', { name: NEVER_HINT });
    const buttons = within(hint.closest('li')!).getAllByRole('button');
    expect(buttons.at(-1)).toBe(hint);
    expect(buttons.at(-2)).toHaveAccessibleName('Make an interest from what you like in Verge');
    expect(buttons.at(-3)).toHaveAccessibleName('Settings for Verge');

    await app.user.click(hint);

    const editor = await screen.findByRole('dialog', { name: 'New card from this article' });
    expect(within(editor).getByRole('radio', { name: 'Never' })).toBeChecked();
    // A Never card names what to hide, and its texts say so.
    expect(within(editor).getByLabelText("I don't want to read about…")).toBeInTheDocument();
    await waitFor(() =>
      expect(app.calls('POST /cards/drafts').map(bodyOf)).toEqual([{ articleIds: ['d1'] }]),
    );
  });

  it('names the topics to avoid in the collapsed strip', async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    await open({
      path: '/read/for_you',
      subscriptions: [training('1', 'Verge')],
      routes: {
        [LEARNING]: learningRoute(() =>
          makeLearning({}, [makeAgreement('1', 'collecting', { unwanted: unwanted(true) })]),
        ),
      },
    });

    const strip = within(await screen.findByRole('list', { name: 'Feeds' }));
    expect(
      await strip.findByRole('link', {
        name: 'Verge, Training: selected articles, topics to avoid',
      }),
    ).toBeVisible();
  });
});
