import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { makeDetail, makeLabel, restoreVisibility, setVisibility } from '../article/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { drawerRoutes, makeExplain } from '../why/support.js';
import {
  BOOKMARK,
  DWELL,
  LABEL,
  MUTE,
  OPEN,
  RATE,
  READ,
  ROWS,
  UNBOOKMARK,
  UNREAD,
  UPDATE_ME,
  createKeysHarness,
  pane,
  title,
  type KeysOptions,
} from './key-support.js';
import { VERGE, likeOf } from './surfaces.js';
import { COUNTS, item, listQueries, page } from './support.js';

const { open } = createKeysHarness();

async function openReader(options: Partial<KeysOptions> = {}) {
  const opened = await open({ path: '/read/for_you', items: ROWS, ...options });
  await screen.findAllByRole('article');
  return opened.app;
}

const BAR = 'Reason for the dislike';
const bar = () => screen.queryByRole('group', { name: BAR });
const dialogs = () => screen.queryAllByRole('dialog');

/** The row of the key table whose label is `label`, and the keys it shows. */
function keysOfRow(dialog: HTMLElement, label: string): string[] {
  const row = within(dialog).getByText(label).closest('div');
  if (row === null) throw new Error(`no row for ${label}`);
  return Array.from(row.querySelectorAll('kbd')).map((key) => key.textContent ?? '');
}

/** Records, for each key pressed, whether the page had it prevented by the time it was done. */
function recordKeys() {
  const seen: { key: string; prevented: boolean }[] = [];
  const record = (event: KeyboardEvent) => {
    seen.push({ key: event.key, prevented: event.defaultPrevented });
  };
  window.addEventListener('keydown', record);
  return {
    seen,
    prevented: (key: string) => seen.filter((entry) => entry.key === key).map((e) => e.prevented),
    stop: () => window.removeEventListener('keydown', record),
  };
}

afterEach(() => {
  vi.useRealTimers();
  restoreVisibility();
});

describe('j and k', () => {
  it('j with nothing current starts at the first row: it takes the focus, opens and is read', async () => {
    const app = await openReader();

    await app.user.keyboard('j');

    expect(title(1)).toHaveFocus();
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
    expect(within(pane()).getByRole('heading', { level: 2, name: 'Article 1' })).toBeVisible();
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    expect(app.calls(READ)[0]!.pathname).toBe('/api/v1/articles/1/read');
    expect(bodyOf(app.calls(READ)[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      trigger: 'expand',
    });
  });

  it('k with nothing current starts at the last row', async () => {
    const app = await openReader();

    await app.user.keyboard('k');

    expect(title(3)).toHaveFocus();
    expect(title(3)).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    expect(app.calls(READ)[0]!.pathname).toBe('/api/v1/articles/3/read');
  });

  it('walk the rows and stop at the ends; an article already read is not read again', async () => {
    const app = await openReader();

    await app.user.keyboard('jj');
    expect(title(2)).toHaveFocus();
    expect(title(2)).toHaveAttribute('aria-expanded', 'true');
    expect(title(1)).toHaveAttribute('aria-expanded', 'false');
    expect(within(pane()).getByRole('heading', { level: 2, name: 'Article 2' })).toBeVisible();

    await app.user.keyboard('k');
    expect(title(1)).toHaveFocus();
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
    await app.user.keyboard('k');
    expect(title(1)).toHaveFocus();

    await app.user.keyboard('jjjj');
    expect(title(3)).toHaveFocus();
    await waitFor(() => expect(app.calls(READ)).toHaveLength(3));
    expect(app.calls(READ).map((request) => request.pathname)).toEqual([
      '/api/v1/articles/1/read',
      '/api/v1/articles/2/read',
      '/api/v1/articles/3/read',
    ]);
  });

  it('only move the focus, with no opening and no read request, when markReadOnExpand is off', async () => {
    const app = await openReader({ me: makeMe({ preferences: { markReadOnExpand: false } }) });

    await app.user.keyboard('jj');

    expect(title(2)).toHaveFocus();
    expect(title(2)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Select an article to read it here.')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.calls(READ)).toHaveLength(0);
  });

  it('j past the last loaded row loads more when there is more, then goes on into it', async () => {
    const app = await openReader({
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(3)]))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
    });

    await app.user.keyboard('jj');
    expect(title(2)).toHaveFocus();
    expect(listQueries(app)).toHaveLength(1);

    await app.user.keyboard('j');

    await screen.findByRole('article', { name: 'Article 3' });
    expect(listQueries(app).map((query) => query['cursor'])).toEqual([undefined, 'c1']);
    expect(title(2)).toHaveFocus();
    await app.user.keyboard('j');
    expect(title(3)).toHaveFocus();
  });

  it('skip a row that is on its way out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();

    fireEvent.click(likeOf('Article 2'));
    await app.user.keyboard('j');

    expect(title(3)).toHaveFocus();
    expect(title(3)).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the current article', () => {
  it('is the expanded one when the focus is not in a row', async () => {
    const app = await openReader();
    await app.user.click(title(2));
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.body).toHaveFocus();

    await app.user.keyboard('b');

    await waitFor(() => expect(app.calls(BOOKMARK)).toHaveLength(1));
    expect(app.calls(BOOKMARK)[0]!.pathname).toBe('/api/v1/articles/2/bookmark');
  });

  it('is the row that holds the focus, even when another one is expanded', async () => {
    const app = await openReader();
    await app.user.click(title(1));
    act(() => title(3).focus());

    await app.user.keyboard('b');

    await waitFor(() => expect(app.calls(BOOKMARK)).toHaveLength(1));
    expect(app.calls(BOOKMARK)[0]!.pathname).toBe('/api/v1/articles/3/bookmark');
    await app.user.keyboard('k');
    expect(title(2)).toHaveFocus();
  });

  it('is the row of a button inside it', async () => {
    const app = await openReader();
    await app.user.click(title(1));
    act(() => likeOf('Article 2').focus());

    await app.user.keyboard('b');

    await waitFor(() => expect(app.calls(BOOKMARK)).toHaveLength(1));
    expect(app.calls(BOOKMARK)[0]!.pathname).toBe('/api/v1/articles/2/bookmark');
  });

  it('is none before the reader has chosen one: the keys that act on an article do nothing', async () => {
    const app = await openReader();
    const before = app.requests.length;

    await app.user.keyboard('xbowlm+-={Enter}');
    await app.user.keyboard('1');

    expect(app.requests.length).toBe(before);
    expect(dialogs()).toHaveLength(0);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(bar()).toBeNull();

    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
  });
});

describe('o and Enter', () => {
  let opener: MockInstance<typeof window.open>;
  beforeEach(() => {
    opener = vi.spyOn(window, 'open').mockReturnValue(null);
  });

  it('o opens the original in a new tab, then reports the open', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    const requestsWhenOpened: number[] = [];
    opener.mockImplementation(() => {
      requestsWhenOpened.push(app.calls(OPEN).length);
      return null;
    });

    await app.user.keyboard('o');

    expect(opener).toHaveBeenCalledExactlyOnceWith(
      'https://example.test/articles/1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(requestsWhenOpened).toEqual([0]);
    await waitFor(() => expect(app.calls(OPEN)).toHaveLength(1));
    expect(app.calls(OPEN)[0]!.pathname).toBe('/api/v1/articles/1/open');
  });

  it('Enter does the same when the focus is not on a control', async () => {
    const app = await openReader();
    await app.user.click(title(2));
    act(() => (document.activeElement as HTMLElement).blur());

    await app.user.keyboard('{Enter}');

    expect(opener).toHaveBeenCalledExactlyOnceWith(
      'https://example.test/articles/2',
      '_blank',
      'noopener,noreferrer',
    );
    await waitFor(() => expect(app.calls(OPEN)).toHaveLength(1));
    expect(app.calls(OPEN)[0]!.pathname).toBe('/api/v1/articles/2/open');
  });

  it('Enter on a control keeps its usual meaning', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
    const keys = recordKeys();

    await app.user.keyboard('{Enter}');

    keys.stop();
    expect(opener).not.toHaveBeenCalled();
    expect(title(1)).toHaveAttribute('aria-expanded', 'false');
    expect(keys.prevented('Enter')).toEqual([false]);
    expect(app.calls(OPEN)).toHaveLength(0);
  });

  it('Enter on a link follows it', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
    act(() =>
      within(screen.getByRole('list', { name: 'Lanes' }))
        .getByRole('link', { name: /^New/ })
        .focus(),
    );

    await app.user.keyboard('{Enter}');

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
    expect(opener).not.toHaveBeenCalled();
    expect(app.calls(OPEN)).toHaveLength(0);
  });

  it('does nothing for an article without a usable link', async () => {
    const app = await openReader({ items: [item(1, { url: null }), item(2)] });
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
    const before = app.requests.length;

    await app.user.keyboard('o');
    act(() => (document.activeElement as HTMLElement).blur());
    await app.user.keyboard('{Enter}');

    expect(opener).not.toHaveBeenCalled();
    expect(app.requests.length).toBe(before);
  });

  it('counts the time away like the button does, once the page is visible again', async () => {
    const app = await openReader({ me: makeMe({ preferences: { implicitFeedback: true } }) });
    await app.user.keyboard('j');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-31T10:00:00.000Z'));
    await app.user.keyboard('o');
    await waitFor(() => expect(app.calls(OPEN)).toHaveLength(1));

    setVisibility('hidden');
    vi.setSystemTime(new Date('2026-05-31T10:01:30.000Z'));
    setVisibility('visible');

    await waitFor(() => expect(app.calls(DWELL)).toHaveLength(1));
    expect(bodyOf(app.calls(DWELL)[0]!)).toMatchObject({ ms: 90_000 });
  });
});

describe('+ = and - with Shift', () => {
  it.each([['+'], ['=']])('%s likes the current article', async (key) => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard(key);

    expect(likeOf('Article 1')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(app.calls(RATE)[0]!.pathname).toBe('/api/v1/articles/1/rating');
    expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({ rating: 1 });
    expect(bodyOf(app.calls(RATE)[0]!)).not.toHaveProperty('hide');
  });

  it('+ again takes the like back, as the button does', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    await app.user.keyboard('+');
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));

    await app.user.keyboard('+');

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(2));
    expect(bodyOf(app.calls(RATE)[1]!)).toMatchObject({ rating: null });
  });

  it('- holds a dislike for the reason bar, and a digit picks the reason', async () => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('-');

    expect(bar()).toBeInTheDocument();
    expect(app.calls(RATE)).toHaveLength(0);
    await app.user.keyboard('3');
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(app.calls(RATE)[0]!.pathname).toBe('/api/v1/articles/1/rating');
    expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({ rating: -1, reason: 'seen' });
    expect(bar()).toBeNull();
  });

  it.each([['+'], ['=']])('Shift with %s rates and hides', async (key) => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard(`{Shift>}${key}{/Shift}`);

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({ rating: 1, hide: true });
  });

  it.each([['-'], ['_']])(
    'Shift with %s holds a dislike that hides, and the reason goes with it',
    async (key) => {
      const app = await openReader();
      await app.user.keyboard('j');

      await app.user.keyboard(`{Shift>}${key}{/Shift}`);
      expect(bar()).toBeInTheDocument();
      await app.user.keyboard('1');

      await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
      expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({
        rating: -1,
        hide: true,
        reason: 'off_topic',
      });
    },
  );

  it('leaves 1 to 6 to the reason bar while it is open, and does not start a mute with m', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    await app.user.keyboard('-');
    expect(bar()).toBeInTheDocument();

    await app.user.keyboard('m');
    expect(screen.queryByText(/^m pressed/)).toBeNull();
    await app.user.keyboard('2');

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(bodyOf(app.calls(RATE)[0]!)).toMatchObject({ rating: -1, reason: 'clickbait' });
    expect(app.calls(MUTE)).toHaveLength(0);
  });
});

describe('b, l, w, m and x', () => {
  it('b bookmarks the current article and, pressed again, removes the bookmark', async () => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('b');

    expect(screen.getAllByRole('button', { name: 'Bookmark' })[0]).toBeVisible();
    await waitFor(() => expect(app.calls(BOOKMARK)).toHaveLength(1));
    expect(app.calls(BOOKMARK)[0]!.pathname).toBe('/api/v1/articles/1/bookmark');
    expect(bodyOf(app.calls(BOOKMARK)[0]!)).toMatchObject({
      contentRevision: '2',
      mediaPolicyFeedId: '7',
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: 'Article 1' })).getByRole('button', {
          name: 'Bookmark',
        }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );

    await app.user.keyboard('b');

    await waitFor(() => expect(app.calls(UNBOOKMARK)).toHaveLength(1));
    expect(app.calls(UNBOOKMARK)[0]!.pathname).toBe('/api/v1/articles/1/bookmark');
  });

  it('l opens the label picker of the current article, with the focus on its first label', async () => {
    const app = await openReader({
      labels: [makeLabel('11', 'Climate'), makeLabel('12', 'Tech')],
    });
    await screen.findByRole('link', { name: 'Climate' });
    await app.user.keyboard('j');

    await app.user.keyboard('l');

    const menu = await screen.findByRole('menu', { name: 'Labels' });
    expect(within(menu).getByRole('menuitem', { name: 'Add label Climate' })).toHaveFocus();
    expect(pane()).toContainElement(menu);
  });

  it('l opens the article first when its row only holds the focus', async () => {
    const app = await openReader({
      me: makeMe({ preferences: { markReadOnExpand: false } }),
      labels: [makeLabel('11', 'Climate')],
    });
    await screen.findByRole('link', { name: 'Climate' });
    await app.user.keyboard('jj');
    expect(title(2)).toHaveAttribute('aria-expanded', 'false');

    await app.user.keyboard('l');

    expect(await screen.findByRole('menu', { name: 'Labels' })).toBeVisible();
    expect(title(2)).toHaveAttribute('aria-expanded', 'true');
    expect(within(pane()).getByRole('heading', { level: 2, name: 'Article 2' })).toBeVisible();
  });

  it('l picks a label like the menu does, and opens again after Escape', async () => {
    const app = await openReader({ labels: [makeLabel('11', 'Climate')] });
    await screen.findByRole('link', { name: 'Climate' });
    await app.user.keyboard('j');
    await app.user.keyboard('l');
    await screen.findByRole('menu', { name: 'Labels' });

    await app.user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(within(pane()).getByRole('button', { name: 'Labels' })).toHaveFocus();

    await app.user.keyboard('l');
    await screen.findByRole('menu', { name: 'Labels' });
    await app.user.keyboard('{Enter}');

    await waitFor(() => expect(app.calls(LABEL)).toHaveLength(1));
    expect(app.calls(LABEL)[0]!.pathname).toBe('/api/v1/articles/1/labels');
    expect(bodyOf(app.calls(LABEL)[0]!)).toMatchObject({ labelId: '11' });
  });

  it('l asked of an article whose actions are not there yet is dropped when another one opens', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saved = [
      item(1, { bookmarkedAt: '2026-05-30T09:00:00.000Z' }),
      item(2, { bookmarkedAt: '2026-05-30T09:00:00.000Z' }),
    ];
    const app = await openReader({
      path: '/read/bookmarks',
      items: saved,
      labels: [makeLabel('11', 'Climate')],
      routes: {
        'GET /articles/:id': async (_request, params) => {
          if (params['id'] === '1') await gate;
          return json(200, makeDetail(saved.find((row) => row.id === params['id']) ?? saved[0]!));
        },
      },
    });
    await screen.findByRole('link', { name: 'Climate' });
    await app.user.keyboard('j');
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');

    await app.user.keyboard('l');
    expect(within(pane()).queryByRole('button', { name: 'Labels' })).toBeNull();
    await app.user.keyboard('j');
    await within(pane()).findByRole('button', { name: 'Labels' });
    release();
    await app.user.keyboard('k');

    expect(await within(pane()).findByRole('button', { name: 'Labels' })).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('w opens Why this? for the current article, and gives the focus back when it closes', async () => {
    const reads = drawerRoutes();
    const app = await openReader({
      routes: {
        'GET /cards': reads['GET /cards']!,
        'GET /topics': reads['GET /topics']!,
        'GET /articles/:id': (_request, params) =>
          json(
            200,
            makeDetail(ROWS.find((row) => row.id === params['id']) ?? ROWS[0]!, {
              explain: makeExplain(),
            }),
          ),
      },
    });
    await app.user.keyboard('jj');

    await app.user.keyboard('w');

    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    expect(drawer).toHaveAccessibleDescription('Article 2');
    await app.user.keyboard('{Escape}');
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(title(2)).toHaveFocus();
  });

  it.each([
    ['1', 1, 'Story muted for 1 day'],
    ['3', 3, 'Story muted for 3 days'],
    ['7', 7, 'Story muted for 7 days'],
    ['0', 30, 'Story muted for 30 days'],
  ])('m then %s mutes the story for %s days', async (key, days, message) => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('m');
    expect(await screen.findByText(/^m pressed\./)).toBeInTheDocument();
    expect(app.calls(MUTE)).toHaveLength(0);
    await app.user.keyboard(key);

    await waitFor(() => expect(app.calls(MUTE)).toHaveLength(1));
    expect(app.calls(MUTE)[0]!.pathname).toBe('/api/v1/articles/1/mute-story');
    expect(bodyOf(app.calls(MUTE)[0]!)).toEqual({ days });
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText(/^m pressed\./)).toBeNull();
  });

  it('m takes a digit typed with Shift, as on the Slovak layout, and Caps Lock letters', async () => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('M');
    await app.user.keyboard('{Shift>}7{/Shift}');

    await waitFor(() => expect(app.calls(MUTE)).toHaveLength(1));
    expect(bodyOf(app.calls(MUTE)[0]!)).toEqual({ days: 7 });
  });

  it('x marks the current article as read, and as unread when it is read', async () => {
    const app = await openReader({ me: makeMe({ preferences: { markReadOnExpand: false } }) });
    await app.user.keyboard('j');
    const row = () => screen.getByRole('article', { name: 'Article 1' });
    expect(within(row()).getByText('Unread')).toBeVisible();

    await app.user.keyboard('x');

    expect(within(row()).getByText('Read')).toBeVisible();
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    expect(app.calls(READ)[0]!.pathname).toBe('/api/v1/articles/1/read');
    expect(bodyOf(app.calls(READ)[0]!)).not.toHaveProperty('trigger');

    await app.user.keyboard('x');

    expect(within(row()).getByText('Unread')).toBeVisible();
    await waitFor(() => expect(app.calls(UNREAD)).toHaveLength(1));
    expect(app.calls(UNREAD)[0]!.pathname).toBe('/api/v1/articles/1/unread');
    await app.user.keyboard('x');
    await waitFor(() => expect(app.calls(READ)).toHaveLength(2));
  });
});

describe('Shift+A', () => {
  const PROBE_AS_OF = '2026-05-31T10:05:00.000Z';
  const list: ApiRouteHandler = (request) =>
    json(
      200,
      request.query.get('limit') === '1'
        ? page([item(1)], { asOf: PROBE_AS_OF, datasetVersion: 'd-lane' })
        : page(ROWS),
    );

  it('opens the confirmation of Mark all read, which Escape closes', async () => {
    const app = await openReader({ list });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled(),
    );

    await app.user.keyboard('{Shift>}A{/Shift}');

    const dialog = await screen.findByRole('dialog', { name: 'Mark all as read?' });
    expect(
      within(dialog).getByText('3 unread articles in “For you” will be marked as read.'),
    ).toBeVisible();
    expect(app.calls('POST /articles/mark-read')).toHaveLength(0);
    await app.user.keyboard('{Escape}');
    await waitFor(() => expect(dialogs()).toHaveLength(0));
  });

  it('is not the plain letter a', async () => {
    const app = await openReader({ list });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled(),
    );

    await app.user.keyboard('aA');
    expect(dialogs()).toHaveLength(0);

    await app.user.keyboard('{Shift>}a{/Shift}');

    expect(await screen.findByRole('dialog', { name: 'Mark all as read?' })).toBeVisible();
  });

  it('is not offered where the button is not', async () => {
    const app = await openReader({ path: '/read/bookmarks', list });
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
    const before = app.requests.length;
    const keys = recordKeys();

    await app.user.keyboard('{Shift>}A{/Shift}');

    keys.stop();
    expect(dialogs()).toHaveLength(0);
    expect(app.requests.length).toBe(before);
    expect(keys.prevented('A')).toEqual([false]);
  });

  it('does nothing while the button is disabled because nothing is unread', async () => {
    const app = await openReader({ list, counts: { forYou: 0 } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled(),
    );

    await app.user.keyboard('{Shift>}A{/Shift}');

    expect(dialogs()).toHaveLength(0);
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
  });
});

describe('g then a letter', () => {
  it.each([
    ['f', '/read/for_you'],
    ['m', '/read/maybe'],
    ['e', '/read/everything'],
    ['n', '/read/new'],
    ['b', '/read/bookmarks'],
  ])('g then %s goes to %s', async (key, path) => {
    const app = await openReader({ path: '/read/hidden', items: [item(1)] });

    await app.user.keyboard('g');
    expect(await screen.findByText(/^g pressed\./)).toBeInTheDocument();
    await app.user.keyboard(key);

    await waitFor(() => expect(app.router.state.location.pathname).toBe(path));
    expect(await screen.findByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.queryByText(/^g pressed\./)).toBeNull();
  });

  it('takes a letter typed with Caps Lock too', async () => {
    const app = await openReader({ path: '/read/hidden', items: [item(1)] });

    await app.user.keyboard('G');
    await app.user.keyboard('N');

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/new'));
  });
});

describe('s and Ctrl+M', () => {
  it('s switches Simple mode on and off, and saves it', async () => {
    const app = await openReader();
    expect(screen.getByText('Excerpt of article 1')).toBeVisible();

    await app.user.keyboard('s');

    expect(screen.getByRole('switch', { name: 'Simple mode' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.queryByText('Excerpt of article 1')).toBeNull();
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(bodyOf(app.calls(UPDATE_ME)[0]!)).toEqual({ preferences: { simpleMode: true } });

    await app.user.keyboard('s');

    expect(await screen.findByText('Excerpt of article 1')).toBeVisible();
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(2));
    expect(bodyOf(app.calls(UPDATE_ME)[1]!)).toEqual({ preferences: { simpleMode: false } });
  });

  it('Ctrl+M does the same, and keeps the browser from taking it', async () => {
    const app = await openReader();
    const keys = recordKeys();

    await app.user.keyboard('{Control>}m{/Control}');

    keys.stop();
    expect(screen.getByRole('switch', { name: 'Simple mode' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));
    expect(bodyOf(app.calls(UPDATE_ME)[0]!)).toEqual({ preferences: { simpleMode: true } });
    expect(keys.prevented('m')).toEqual([true]);
  });

  it('Ctrl+M is left alone where typing, a dialog or a menu has the keyboard', async () => {
    const app = await openReader({ subscriptions: [VERGE] });
    await app.user.keyboard('{Control>}m{/Control}');
    await waitFor(() => expect(app.calls(UPDATE_ME)).toHaveLength(1));

    await app.user.keyboard('/');
    expect(screen.getByRole('textbox', { name: 'Filter feeds' })).toHaveFocus();
    await app.user.keyboard('{Control>}m{/Control}');
    await app.user.keyboard('?');
    await app.user.keyboard('{Control>}m{/Control}');

    expect(app.calls(UPDATE_ME)).toHaveLength(1);
  });
});

describe('/', () => {
  it('focuses the feed filter, and keeps the browser from taking the key', async () => {
    const app = await openReader({ subscriptions: [VERGE] });
    const keys = recordKeys();

    await app.user.keyboard('/');

    keys.stop();
    expect(screen.getByRole('textbox', { name: 'Filter feeds' })).toHaveFocus();
    expect(keys.prevented('/')).toEqual([true]);
  });
});

describe('?', () => {
  const TABLE: [string, string[]][] = [
    ['Next article', ['j']],
    ['Previous article', ['k']],
    ['Filter the feeds', ['/']],
    ['For you', ['g', 'f']],
    ['Maybe', ['g', 'm']],
    ['Everything else', ['g', 'e']],
    ['New', ['g', 'n']],
    ['Bookmarks', ['g', 'b']],
    ['Open the original in a new tab', ['o', 'Enter']],
    ['Like', ['+', '=']],
    ['Dislike, then pick a reason', ['-', '1', '6']],
    ['Rate and hide', ['Shift']],
    ['Bookmark or remove the bookmark', ['b']],
    ['Choose labels', ['l']],
    ['Why this?', ['w']],
    ['Mute the story: 1, 3 or 7 days, or 0 for 30 days', ['m', '1', '3', '7', '0']],
    ['Mark as read or unread', ['x']],
    ['Mark all as read', ['Shift', 'A']],
    ['Switch Simple mode on or off', ['s', 'Ctrl', 'M']],
    ['Show this list', ['?']],
  ];

  it('opens a modal that lists every shortcut of the table in groups, with the keys in kbd', async () => {
    const app = await openReader();

    await app.user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const group of ['Moving around', 'Go to a lane', 'The current article', 'The reader']) {
      expect(within(dialog).getByRole('heading', { level: 3, name: group })).toBeVisible();
    }
    for (const [label, keys] of TABLE)
      expect({ label, keys: keysOfRow(dialog, label) }).toEqual({ label, keys });
    expect(within(dialog).getAllByRole('term')).toHaveLength(TABLE.length);
    expect(
      within(dialog).getByText(/where \+ needs Shift, press = to like without hiding/),
    ).toBeVisible();
  });

  it('closes with Escape and gives the focus back to the row it was opened from', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();

    await app.user.keyboard('?');
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await app.user.keyboard('{Escape}');

    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(title(1)).toHaveFocus();
  });

  it('closes with its close button and gives the focus back', async () => {
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(title(1)).toHaveFocus();
  });

  it('is in Slovak for a Slovak reader', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: ROWS,
      language: 'sk',
      me: makeMe({ locale: 'sk' }),
    });
    await screen.findAllByRole('article');

    await app.user.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Klávesové skratky' });
    expect(
      within(dialog).getByRole('heading', { level: 3, name: 'Aktuálny článok' }),
    ).toBeVisible();
    expect(keysOfRow(dialog, 'Nasledujúci článok')).toEqual(['j']);
  });
});

describe('where the keys do not work', () => {
  it('not while the reader types in a field', async () => {
    const app = await openReader({ subscriptions: [VERGE] });
    await app.user.keyboard('j');
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    await app.user.keyboard('/');
    const filter = screen.getByRole('textbox', { name: 'Filter feeds' });
    expect(filter).toHaveFocus();
    const before = app.requests.length;

    await app.user.keyboard('jkxb+-=oswlmg?/n1');

    expect(filter).toHaveValue('jkxb+-=oswlmg?/n1');
    expect(app.requests.length).toBe(before);
    expect(dialogs()).toHaveLength(0);
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
    expect(app.router.state.location.pathname).toBe('/read/for_you');
  });

  it('not in an editable region', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    editor.tabIndex = 0;
    document.body.append(editor);
    act(() => editor.focus());
    const before = app.requests.length;

    fireEvent.keyDown(editor, { key: 'x' });
    fireEvent.keyDown(editor, { key: 'k' });

    editor.remove();
    expect(app.requests.length).toBe(before);
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
    await app.user.keyboard('x');
    await waitFor(() => expect(app.calls(UNREAD)).toHaveLength(1));
  });

  it('not while a dialog is open', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    await app.user.keyboard('?');
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const before = app.requests.length;

    await app.user.keyboard('jkxb+-=oswlmg?/');

    expect(app.requests.length).toBe(before);
    expect(dialogs()).toHaveLength(1);
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
  });

  it('not while a menu is open', async () => {
    const app = await openReader({ labels: [makeLabel('11', 'Climate')] });
    await screen.findByRole('link', { name: 'Climate' });
    await app.user.keyboard('j');
    await app.user.click(within(pane()).getByRole('button', { name: 'Labels' }));
    const menu = await screen.findByRole('menu', { name: 'Labels' });
    expect(within(menu).getByRole('menuitem', { name: 'Add label Climate' })).toHaveFocus();
    const before = app.requests.length;

    await app.user.keyboard('xb+-=owsjk?/');

    expect(app.requests.length).toBe(before);
    expect(screen.getByRole('menu', { name: 'Labels' })).toBeVisible();
    expect(dialogs()).toHaveLength(0);
    await app.user.keyboard('{Escape}');
    await app.user.keyboard('x');
    await waitFor(() => expect(app.calls(UNREAD)).toHaveLength(1));
  });

  it('not during input composition', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();

    expect(fireEvent.keyDown(title(1), { key: 'j', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(title(1), { key: 'j', keyCode: 229 })).toBe(true);
    expect(fireEvent.keyDown(title(1), { key: 'x', isComposing: true })).toBe(true);

    expect(title(1)).toHaveFocus();
    expect(app.calls(UNREAD)).toHaveLength(0);
    await app.user.keyboard('j');
    expect(title(2)).toHaveFocus();
  });

  it('not with Ctrl, Meta or Alt, which leaves zoom and navigation to the browser', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    await app.user.keyboard('=');
    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    const before = app.requests.length;

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const key of ['+', '=', '-', 'j', 'x', 'g', 'b']) {
        expect(fireEvent.keyDown(document.body, { key, [modifier]: true })).toBe(true);
      }
    }

    expect(app.requests.length).toBe(before);
    expect(title(1)).toHaveFocus();
    expect(bar()).toBeNull();
  });

  it('leaves the keys it does not use to the browser, and takes the ones it uses', async () => {
    const app = await openReader();
    const keys = recordKeys();

    await app.user.keyboard('qQ1[Tab]{ArrowDown}{Escape}');
    await app.user.keyboard('j');

    keys.stop();
    expect(keys.seen.filter((entry) => entry.key !== 'j').every((entry) => !entry.prevented)).toBe(
      true,
    );
    expect(keys.seen.length).toBeGreaterThanOrEqual(6);
    expect(keys.prevented('j')).toEqual([true]);
  });

  it('a key that is held acts once', async () => {
    const app = await openReader({ me: makeMe({ preferences: { markReadOnExpand: false } }) });
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();

    expect(fireEvent.keyDown(document.body, { key: 'x' })).toBe(false);
    for (let times = 0; times < 3; times += 1) {
      expect(fireEvent.keyDown(document.body, { key: 'x', repeat: true })).toBe(true);
    }
    fireEvent.keyDown(document.body, { key: 'j', repeat: true });

    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(app.calls(READ)).toHaveLength(1);
    expect(title(1)).toHaveFocus();
  });

  it('a key event that has no key, as the autofill of a browser sends, is left alone', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    expect(title(1)).toHaveFocus();
    const keyless = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(keyless, 'key', { value: undefined });
    const thrown: unknown[] = [];
    const catchIt = (event: ErrorEvent) => {
      thrown.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', catchIt);

    const taken = !document.body.dispatchEvent(keyless);

    window.removeEventListener('error', catchIt);
    expect({ taken, thrown }).toEqual({ taken: false, thrown: [] });
    await app.user.keyboard('j');
    expect(title(2)).toHaveFocus();
  });

  it('not on a narrow screen, where the detail is a sheet; wide again, they work', async () => {
    const { app, setDesktop } = await open({ path: '/read/for_you', items: ROWS, desktop: false });
    await screen.findAllByRole('article');
    const before = app.requests.length;

    await app.user.keyboard('jkxb+-=?/');

    expect(app.requests.length).toBe(before);
    expect(dialogs()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Article 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(document.body).toHaveFocus();

    setDesktop(true);
    await screen.findByRole('complementary', { name: 'Article' });
    await screen.findAllByRole('article');
    await app.user.keyboard('j');

    expect(title(1)).toHaveFocus();
    expect(title(1)).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('sequences', () => {
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('g waits one second, saying in a polite live region and in view which keys it takes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await openReader({ path: '/read/new' });
    expect(screen.queryByText(/^g pressed\./)).toBeNull();

    await app.user.keyboard('g');

    const announcement = await screen.findByText(
      'g pressed. Next: f – For you, m – Maybe, e – Everything else, n – New, b – Bookmarks.',
    );
    expect(announcement.closest('[aria-live="polite"]')).not.toBeNull();
    for (const key of ['f', 'm', 'e', 'n', 'b']) {
      expect(screen.getAllByText(key, { selector: 'kbd' })).toHaveLength(1);
    }
    await advance(500);
    expect(screen.getByText(/^g pressed\./)).toBeInTheDocument();
    expect(screen.getAllByText('f', { selector: 'kbd' })).toHaveLength(1);

    await advance(600);

    expect(screen.queryByText(/^g pressed\./)).toBeNull();
    expect(screen.queryAllByText('f', { selector: 'kbd' })).toHaveLength(0);
    await app.user.keyboard('f');
    expect(app.router.state.location.pathname).toBe('/read/new');
  });

  it('m waits one second too, and names the days', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await openReader();
    await app.user.keyboard('j');

    await app.user.keyboard('m');

    expect(
      await screen.findByText(
        'm pressed. Mute the story for: 1 – 1 day, 3 – 3 days, 7 – 7 days, 0 – 30 days.',
      ),
    ).toBeInTheDocument();
    await advance(1100);
    expect(screen.queryByText(/^m pressed\./)).toBeNull();
    await app.user.keyboard('7');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.calls(MUTE)).toHaveLength(0);
  });

  it('is taken in time: the next key within the second completes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await openReader({ path: '/read/new' });

    await app.user.keyboard('g');
    await advance(500);
    await app.user.keyboard('m');

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/read/maybe'));
  });

  it('is ended by a key it does not take, which is not taken as a shortcut either', async () => {
    const app = await openReader({ path: '/read/new' });
    await app.user.keyboard('j');
    await waitFor(() => expect(app.calls(READ)).toHaveLength(1));
    await app.user.keyboard('g');
    await screen.findByText(/^g pressed\./);

    await app.user.keyboard('x');

    expect(screen.queryByText(/^g pressed\./)).toBeNull();
    await app.user.keyboard('f');
    expect(app.calls(UNREAD)).toHaveLength(0);
    expect(app.router.state.location.pathname).toBe('/read/new');
  });

  it('is not ended by a modifier key, which Shift-typed digits need', async () => {
    const app = await openReader();
    await app.user.keyboard('j');
    await app.user.keyboard('m');
    await screen.findByText(/^m pressed\./);

    await app.user.keyboard('{Shift>}');
    expect(screen.getByText(/^m pressed\./)).toBeInTheDocument();
    await app.user.keyboard('3{/Shift}');

    await waitFor(() => expect(app.calls(MUTE)).toHaveLength(1));
    expect(bodyOf(app.calls(MUTE)[0]!)).toEqual({ days: 3 });
  });

  it('is announced in Slovak for a Slovak reader', async () => {
    const { app } = await open({
      path: '/read/new',
      items: ROWS,
      language: 'sk',
      me: makeMe({ locale: 'sk' }),
    });
    await screen.findAllByRole('article');

    await app.user.keyboard('g');

    expect(
      await screen.findByText(
        'Stlačené g. Ďalej: f – Pre vás, m – Možno, e – Všetko ostatné, n – Nové, b – Záložky.',
      ),
    ).toBeInTheDocument();
  });
});

describe('the wide reader as a whole', () => {
  it('keeps a feed view and the counts of the lanes working while the keys are used', async () => {
    const app = await openReader({
      path: '/read/feed/7',
      subscriptions: [VERGE],
      counts: { ...COUNTS, total: 3 },
    });

    await app.user.keyboard('j');
    await app.user.keyboard('+');

    await waitFor(() => expect(app.calls(RATE)).toHaveLength(1));
    expect(app.calls(RATE)[0]!.pathname).toBe('/api/v1/articles/1/rating');
  });
});
