import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import { deferred, makeLabel } from '../article/harness.js';
import { makeSubscription } from '../feeds/support.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import {
  createReaderHarness,
  detailCalls,
  item,
  listQueries,
  page,
  rowOf,
  rowTitles,
  sidebar as sidebarNav,
  type ReaderOptions,
} from './support.js';

const { open } = createReaderHarness();

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const READ = 'POST /articles/:id/read';
const RATE = 'POST /articles/:id/rating';

async function expand(app: Awaited<ReturnType<typeof open>>['app'], title: string) {
  await app.user.click(await screen.findByRole('button', { name: title }));
}

describe('the requests of the list', () => {
  it.each<[string, string, Record<string, string>]>([
    ['For you', '/read/for_you', { lane: 'for_you', minTier: '1', sort: 'score', limit: '30' }],
    ['Maybe', '/read/maybe', { lane: 'maybe', minTier: '1', limit: '30' }],
    ['Everything else', '/read/everything', { lane: 'everything', limit: '30' }],
    ['New', '/read/new', { lane: 'new', limit: '30' }],
    ['Bookmarks', '/read/bookmarks', { lane: 'bookmarks', limit: '30' }],
    ['Hidden', '/read/hidden', { lane: 'hidden', limit: '30' }],
    ['a feed', '/read/feed/7', { lane: 'all', feedId: '7', minTier: '1', limit: '30' }],
    [
      'a feed in its Maybe lane',
      '/read/feed/7?lane=maybe',
      { lane: 'maybe', feedId: '7', minTier: '1', limit: '30' },
    ],
    ['a feed in its New lane', '/read/feed/7?lane=new', { lane: 'new', feedId: '7', limit: '30' }],
    [
      'a feed with a lane nobody knows',
      '/read/feed/7?lane=bogus',
      { lane: 'all', feedId: '7', minTier: '1', limit: '30' },
    ],
    [
      'a folder',
      '/read/folder/Tech%20News',
      { lane: 'all', folder: 'Tech News', minTier: '1', limit: '30' },
    ],
    ['a label', '/read/label/12', { lane: 'all', labelId: '12', minTier: '1', limit: '30' }],
  ])('asks for %s with exactly its parameters', async (_name, path, expected) => {
    const { app } = await open({ path });

    await waitFor(() => expect(listQueries(app)).toHaveLength(1));
    expect(listQueries(app)[0]).toEqual(expected);
  });

  it('uses the tier and the sort of the preferences', async () => {
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { defaultTier: 3, sort: 'date' } }),
    });

    await waitFor(() => expect(listQueries(app)).toHaveLength(1));
    expect(listQueries(app)[0]).toEqual({
      lane: 'for_you',
      minTier: '3',
      sort: 'date',
      limit: '30',
    });
  });

  it('asks for the maybe lane at the tier of the preferences, without a sort', async () => {
    const { app } = await open({
      path: '/read/maybe',
      me: makeMe({ preferences: { defaultTier: 4, sort: 'date' } }),
    });

    await waitFor(() => expect(listQueries(app)).toHaveLength(1));
    expect(listQueries(app)[0]).toEqual({ lane: 'maybe', minTier: '4', limit: '30' });
  });

  it('cancels the request of a view the reader has left', async () => {
    const never = deferred<Response>();
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('lane') === 'for_you' ? never.promise : json(200, page([item(1)])),
    });
    await waitFor(() => expect(listQueries(app)).toHaveLength(1));
    const [first] = app.calls('GET /articles');

    await act(async () => {
      await app.router.navigate({ to: '/read/$lane', params: { lane: 'new' } });
    });

    await waitFor(() => expect(first!.signal?.aborted).toBe(true));
    expect(await screen.findByRole('button', { name: 'Article 1' })).toBeInTheDocument();
  });
});

describe('the rows of the list', () => {
  it('renders an article row for each article', async () => {
    await open({ path: '/read/for_you', items: [item(1), item(2), item(3)] });

    await screen.findByRole('article', { name: 'Article 1' });
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(within(rowOf('Article 1')).getByText('Excerpt of article 1')).toBeVisible();
  });

  it('hides the excerpts in Simple mode', async () => {
    await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { simpleMode: true } }),
      items: [item(1)],
    });

    await screen.findByRole('article', { name: 'Article 1' });
    expect(screen.queryByText('Excerpt of article 1')).toBeNull();
  });
});

describe('a new tier', () => {
  it('keeps the rows on screen until the list for the new tier is there', async () => {
    const next = deferred<Response>();
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('minTier') === '4'
          ? next.promise
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });
    await screen.findByRole('article', { name: 'Article 2' });

    fireEvent.change(await screen.findByRole('slider', { name: 'Minimum tier' }), {
      target: { value: '4' },
    });

    await waitFor(() => expect(listQueries(app).at(-1)).toMatchObject({ minTier: '4' }));
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    next.resolve(json(200, page([item(2)])));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 2']));
  });

  it('starts from an empty list in another view', async () => {
    const never = deferred<Response>();
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('lane') === 'new' ? never.promise : json(200, page([item(1)])),
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(within(sidebarNav()).getByRole('link', { name: /^New/ }));

    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeVisible();
    expect(rowTitles()).toEqual([]);
  });
});

describe('paging', () => {
  it('loads the next page with the cursor of the last one and appends it', async () => {
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(3), item(4)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 4' });
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3', 'Article 4']);
    expect(listQueries(app).map((query) => query['cursor'])).toEqual([undefined, 'c1']);
    expect(listQueries(app)[1]).toEqual({
      lane: 'for_you',
      minTier: '1',
      sort: 'score',
      limit: '30',
      cursor: 'c1',
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows each article once when the next page repeats one', async () => {
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(2), item(3)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });

    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 3' });
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
  });

  it('loads the next page when the end of the list scrolls into view', async () => {
    const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
    class FakeObserver {
      target: Element | null = null;
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { app } = await open({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(3)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });
    await screen.findByRole('article', { name: 'Article 2' });
    const watcher = observers.find((candidate) => candidate.target !== null)!;

    act(() => {
      watcher.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        watcher as unknown as IntersectionObserver,
      );
    });
    expect(listQueries(app)).toHaveLength(1);
    act(() => {
      watcher.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        watcher as unknown as IntersectionObserver,
      );
    });

    await screen.findByRole('article', { name: 'Article 3' });
    expect(listQueries(app).map((query) => query['cursor'])).toEqual([undefined, 'c1']);
  });

  it.each([
    ['409 STALE_CURSOR', () => failure(409, 'STALE_CURSOR')],
    ['400 on a cursor that expired', () => failure(400, 'VALIDATION_FAILED')],
  ])('starts again from page one on %s, without duplicates', async (_name, reject) => {
    let fresh = false;
    const { app } = await open({
      path: '/read/for_you',
      list: (request) => {
        if (request.query.get('cursor') === 'c1') {
          fresh = true;
          return reject();
        }
        return fresh
          ? json(200, page([item(9), item(1), item(2), item(3)], { datasetVersion: 'd2' }))
          : json(200, page([item(1), item(2), item(3)], { nextCursor: 'c1' }));
      },
    });
    await screen.findByRole('article', { name: 'Article 3' });

    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 9' });
    expect(rowTitles()).toEqual(['Article 9', 'Article 1', 'Article 2', 'Article 3']);
    expect(listQueries(app).map((query) => query['cursor'])).toEqual([undefined, 'c1', undefined]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the expanded article expanded when the list starts again from page one', async () => {
    let fresh = false;
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      list: (request) => {
        if (request.query.get('cursor') === 'c1') {
          fresh = true;
          return failure(409, 'STALE_CURSOR');
        }
        return fresh
          ? json(200, page([item(9), item(1), item(2), item(3)]))
          : json(200, page([item(1), item(2), item(3)], { nextCursor: 'c1' }));
      },
    });
    await expand(app, 'Article 2');
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 9' });
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const pane = screen.getByRole('complementary', { name: 'Article' });
    expect(within(pane).getByRole('heading', { level: 2, name: 'Article 2' })).toBeVisible();
  });

  it('keeps showing an article that the reloaded list no longer has while it is open', async () => {
    let fresh = false;
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      list: (request) => {
        if (request.query.get('cursor') === 'c1') {
          fresh = true;
          return failure(409, 'STALE_CURSOR');
        }
        return fresh
          ? json(200, page([item(1), item(5)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' }));
      },
    });
    await expand(app, 'Article 2');

    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 5' });
    expect(rowTitles()).toEqual(['Article 1', 'Article 5']);
    const pane = screen.getByRole('complementary', { name: 'Article' });
    expect(within(pane).getByRole('heading', { level: 2, name: 'Article 2' })).toBeVisible();
  });

  it('does not start over when the first page itself is refused', async () => {
    const { app } = await open({
      path: '/read/for_you',
      list: () => failure(400, 'VALIDATION_FAILED'),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(listQueries(app)).toHaveLength(1);
  });
});

describe('opening an article', () => {
  it('marks an unread article read once, with the expand trigger', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1)] });
    const title = await screen.findByRole('button', { name: 'Article 1' });

    await app.user.click(title);

    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    expect(app.calls(READ)[0]!.pathname).toBe('/api/v1/articles/1/read');
    expect(bodyOf(app.calls(READ)[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      trigger: 'expand',
    });
    await app.user.click(title);
    await app.user.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(app.calls(READ)).toHaveLength(1);
  });

  it('does not mark an article that is already read', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1, { readAt: '2026-05-31T09:00:00.000Z' })],
    });

    await expand(app, 'Article 1');

    await screen.findByRole('button', { name: 'Read original' });
    expect(app.calls(READ)).toHaveLength(0);
  });

  it('marks nothing read when the preference is off', async () => {
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { markReadOnExpand: false } }),
      items: [item(1)],
    });

    await expand(app, 'Article 1');

    await screen.findByRole('button', { name: 'Read original' });
    expect(within(rowOf('Article 1')).getByText('Unread')).toBeVisible();
    expect(app.calls(READ)).toHaveLength(0);
  });

  it('expands one article at a time', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1), item(2)] });

    await expand(app, 'Article 1');
    await expand(app, 'Article 2');

    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('asks for the detail the way the feed view shows the article', async () => {
    const { app } = await open({ path: '/read/feed/7', items: [item(1)] });

    await expand(app, 'Article 1');

    await waitFor(() => expect(detailCalls(app)).toHaveLength(1));
    expect(Object.fromEntries(detailCalls(app)[0]!.query)).toEqual({
      sourceFeedId: '7',
    });
  });

  it('asks for the saved copy of an article of the Bookmarks view', async () => {
    const { app } = await open({
      path: '/read/bookmarks',
      items: [item(1, { bookmarkedAt: '2026-05-30T09:00:00.000Z' })],
    });

    await expand(app, 'Article 1');

    await waitFor(() => expect(detailCalls(app)).toHaveLength(1));
    expect(Object.fromEntries(detailCalls(app)[0]!.query)).toEqual({ view: 'saved' });
  });
});

describe('the detail of the expanded article', () => {
  it('shows in a pane beside the list on a wide screen', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1)] });
    const pane = await screen.findByRole('complementary', { name: 'Article' });
    expect(within(pane).getByText('Select an article to read it here.')).toBeVisible();

    await expand(app, 'Article 1');

    expect(within(pane).getByRole('heading', { level: 2, name: 'Article 1' })).toBeVisible();
    expect(await within(pane).findByRole('button', { name: 'Read original' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();

    await app.user.click(within(pane).getByRole('button', { name: 'Close' }));

    expect(within(pane).getByText('Select an article to read it here.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('shows in a sheet from the bottom on a narrow screen', async () => {
    const { app } = await open({ path: '/read/for_you', desktop: false, items: [item(1)] });
    await screen.findByRole('article', { name: 'Article 1' });
    expect(screen.queryByRole('complementary', { name: 'Article' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    await expand(app, 'Article 1');

    const sheet = await screen.findByRole('dialog', { name: 'Article 1' });
    expect(await within(sheet).findByRole('button', { name: 'Read original' })).toBeVisible();

    await app.user.click(within(sheet).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('closing the expanded article', () => {
  it('closes the sheet of a narrow screen with Escape', async () => {
    const { app } = await open({ path: '/read/for_you', desktop: false, items: [item(1)] });
    await expand(app, 'Article 1');
    await screen.findByRole('dialog', { name: 'Article 1' });

    await app.user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('closes it when the reader moves to another lane of the feed', async () => {
    const { app } = await open({ path: '/read/feed/7', items: [item(1)] });
    await expand(app, 'Article 1');
    const pane = screen.getByRole('complementary', { name: 'Article' });
    expect(within(pane).getByRole('heading', { level: 2, name: 'Article 1' })).toBeVisible();

    await app.user.selectOptions(await screen.findByRole('combobox', { name: 'Show' }), 'Maybe');

    await waitFor(() => expect(app.router.state.location.href).toBe('/read/feed/7?lane=maybe'));
    expect(await screen.findByText('Select an article to read it here.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('leaving the list', () => {
  it('moves a rated article out of an unread list after 400 ms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ path: '/read/for_you', items: [item(1), item(2)] });
    const like = within(await screen.findByRole('article', { name: 'Article 1' })).getByRole(
      'button',
      { name: 'Like' },
    );

    fireEvent.click(like);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(rowTitles()).toEqual(['Article 2']);
  });

  it('moves a disliked article out too, and keeps one the reader only read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { app } = await open({ path: '/read/for_you', items: [item(1), item(2), item(3)] });
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'Article 1' })).getByRole('button', {
        name: 'Dislike',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(rowTitles()).toEqual(['Article 2', 'Article 3']);
    expect(within(rowOf('Article 2')).getByText('Read')).toBeVisible();
    expect(app.calls(READ)).toHaveLength(1);
  });

  it('keeps an article whose rating the reader took back in time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ path: '/read/for_you', items: [item(1)] });
    const like = within(await screen.findByRole('article', { name: 'Article 1' })).getByRole(
      'button',
      { name: 'Like' },
    );

    fireEvent.click(like);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.click(like);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(rowTitles()).toEqual(['Article 1']);
  });

  it('keeps a rated article in a list that shows every article, such as Bookmarks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { app } = await open({
      path: '/read/bookmarks',
      items: [item(1, { bookmarkedAt: '2026-05-30T09:00:00.000Z' })],
    });
    const like = within(await screen.findByRole('article', { name: 'Article 1' })).getByRole(
      'button',
      { name: 'Like' },
    );

    fireEvent.click(like);
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(rowTitles()).toEqual(['Article 1']);
  });

  it('hands the focus to the next article when the focused one leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ path: '/read/for_you', items: [item(1), item(2)] });
    const like = within(await screen.findByRole('article', { name: 'Article 1' })).getByRole(
      'button',
      { name: 'Like' },
    );
    like.focus();

    fireEvent.click(like);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(rowTitles()).toEqual(['Article 2']);
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveFocus();
  });
});

describe('the view of a feed', () => {
  const FAILED_AT = '2026-10-01T08:00:00.000Z';
  const dead = makeSubscription({
    feed: {
      id: '9',
      title: 'Dead Blog',
      status: 'dead',
      lastErrorCode: 'FEED_DNS_ERROR',
      lastErrorAt: FAILED_AT,
    },
    inferenceMode: 'training',
  });

  it('shows the title and the classification of the feed, and the banner of a dead one', async () => {
    await open({
      path: '/read/feed/9',
      subscriptions: [dead, makeSubscription({ feed: { id: '3' } })],
    });

    await screen.findByRole('heading', { level: 1, name: 'Dead Blog' });
    const header = screen.getByRole('group', { name: 'Dead Blog' });
    expect(within(header).getByText('Training: selected articles')).toBeVisible();
    expect(
      await screen.findByText(
        "This feed stopped working on Oct 1, 2026: We couldn't find that website.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText(/stopped working/)).toHaveLength(1);
  });

  it('names the feed by the title override', async () => {
    await open({
      path: '/read/feed/9',
      subscriptions: [
        makeSubscription({ feed: { id: '9', title: 'Dead Blog' }, titleOverride: 'Mine' }),
      ],
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Mine' })).toBeVisible();
  });

  it('shows no banner for a working feed and none in the lanes', async () => {
    const working = makeSubscription({ feed: { id: '9', title: 'Fine Blog' } });
    await open({ path: '/read/feed/9', subscriptions: [working] });

    await screen.findByRole('heading', { level: 1, name: 'Fine Blog' });
    expect(screen.queryByText(/stopped working/)).toBeNull();
  });

  it('shows the banner of a dead feed only in its own view', async () => {
    await open({ path: '/read/for_you', subscriptions: [dead] });

    await screen.findByRole('link', { name: 'Dead Blog' });
    expect(screen.queryByText(/stopped working/)).toBeNull();
  });

  it('shows the name of a folder as the title', async () => {
    await open({ path: '/read/folder/Tech%20News' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Tech News' })).toBeVisible();
  });

  it('shows the name of a label as the title', async () => {
    await open({ path: '/read/label/12', labels: [makeLabel('12', 'Climate')] });

    expect(await screen.findByRole('heading', { level: 1, name: 'Climate' })).toBeVisible();
  });

  it('switches between the lanes of the feed', async () => {
    const { app } = await open({ path: '/read/feed/7', items: [item(1)] });
    const select = await screen.findByRole('combobox', { name: 'Show' });
    expect(select).toHaveValue('all');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All', 'For you', 'Maybe', 'Everything else', 'New']);

    await app.user.selectOptions(select, 'Maybe');

    await waitFor(() => expect(app.router.state.location.href).toBe('/read/feed/7?lane=maybe'));
    await waitFor(() =>
      expect(listQueries(app).at(-1)).toEqual({
        lane: 'maybe',
        feedId: '7',
        minTier: '1',
        limit: '30',
      }),
    );
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('maybe');
  });

  it('has no lane selector in a lane of its own', async () => {
    await open({ path: '/read/maybe' });

    await screen.findByRole('heading', { level: 1, name: 'Maybe' });
    expect(screen.queryByRole('combobox', { name: 'Show' })).toBeNull();
  });
});

describe('the states of the list', () => {
  it.each<[string, string, string, string]>([
    ['for_you', '/read/for_you', "You're all caught up", 'New articles that match your interests'],
    ['maybe', '/read/maybe', 'Nothing to decide', 'Articles Bantoozi is unsure about'],
    ['everything', '/read/everything', 'Nothing else to read', "Articles that don't match"],
    ['new', '/read/new', 'No new articles', "Articles that haven't been scored yet"],
    ['bookmarks', '/read/bookmarks', 'No bookmarks yet', 'Bookmark an article'],
    ['hidden', '/read/hidden', 'Nothing is hidden', 'Articles you hide'],
    ['a feed', '/read/feed/7', 'No unread articles', 'Everything in this view has been read'],
  ])('says what an empty %s lane means', async (_name, path, title, body) => {
    await open({ path, items: [] });

    expect(await screen.findByText(title)).toBeVisible();
    expect(screen.getByText(new RegExp(body))).toBeVisible();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows a loading state before the first page', async () => {
    const never = deferred<Response>();
    await open({ path: '/read/for_you', list: () => never.promise });

    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeVisible();
  });

  it('shows the error with a Retry that asks again', async () => {
    let failing = true;
    const options: ReaderOptions = {
      path: '/read/for_you',
      list: () => (failing ? failure(500, 'INTERNAL') : json(200, page([item(1)]))),
    };
    const { app } = await open(options);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    failing = false;
    await app.user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('article', { name: 'Article 1' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the reader is offline and nothing has loaded', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    await open({ path: '/read/for_you', list: () => new Promise<Response>(() => {}) });

    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('keeps showing the articles when loading more fails, and offers to try again', async () => {
    let failing = true;
    const { app } = await open({
      path: '/read/for_you',
      list: (request) => {
        if (request.query.get('cursor') !== 'c1') {
          return json(200, page([item(1)], { nextCursor: 'c1' }));
        }
        return failing ? failure(500, 'INTERNAL') : json(200, page([item(2)]));
      },
    });

    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(rowTitles()).toEqual(['Article 1']);
    failing = false;
    await app.user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByRole('article', { name: 'Article 2' });
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
  });
});
