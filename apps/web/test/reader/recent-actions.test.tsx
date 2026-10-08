import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RecentAction } from '../../src/features/reader/actions/types.js';
import { createI18n, LANGUAGES } from '../../src/i18n/index.js';
import { failure, json } from '../api/fake-fetch.js';
import { deferred, findToast } from '../article/harness.js';
import { makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { createReaderHarness, countsQueries, item, listQueries, rowTitles } from './support.js';
import {
  VERGE,
  bookmarkOf,
  headerOf,
  likeOf,
  openMore,
  receipt,
  undoRoute,
  writeRoutes,
} from './surfaces.js';

const { open } = createReaderHarness();

const UNDO = 'POST /articles/undo';
const MARK_READ = 'POST /articles/mark-read';
const MINUTE = 60_000;

type App = Awaited<ReturnType<typeof open>>['app'];

/** Opens the sheet of recent actions from the More menu of the view called `title`. */
async function openRecent(app: App, title = 'For you') {
  await openMore(app, title);
  await app.user.click(screen.getByRole('menuitem', { name: 'Recent actions' }));
  return screen.findByRole('dialog', { name: 'Recent actions' });
}

const entriesOf = (sheet: HTMLElement) => within(sheet).queryAllByRole('listitem');

/** The entries of the sheet, once there are `count` of them. */
async function entries(sheet: HTMLElement, count: number) {
  await waitFor(() => expect(entriesOf(sheet)).toHaveLength(count));
  return entriesOf(sheet);
}

const undoOf = (entry: HTMLElement) => within(entry).getByRole('button', { name: 'Undo' });

describe('the Recent actions item of the More menu', () => {
  it('opens a sheet that names itself and says how long an action can be undone', async () => {
    const { app } = await open({ path: '/read/for_you' });

    const sheet = await openRecent(app);

    expect(sheet).toHaveAccessibleDescription('Each action can be undone for 10 minutes.');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('says so when there is nothing to undo', async () => {
    const { app } = await open({ path: '/read/for_you' });

    const sheet = await openRecent(app);

    expect(within(sheet).getByText('Nothing to undo')).toBeVisible();
    expect(
      within(sheet).getByText('What you do in the reader shows up here for 10 minutes.'),
    ).toBeVisible();
    expect(within(sheet).queryByRole('list')).toBeNull();
  });

  it('gives the focus back to the More button when the sheet closes', async () => {
    const { app } = await open({ path: '/read/for_you' });
    const more = within(await headerOf('For you')).getByRole('button', { name: 'More' });
    const sheet = await openRecent(app);

    await app.user.click(within(sheet).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(more).toHaveFocus();
  });
});

describe('the controls', () => {
  it('have an accessible name, a 44 px target and a focus ring', async () => {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: writes.routes,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    await openMore(app, 'For you');
    const menuItem = screen.getByRole('menuitem', { name: 'Recent actions' });
    await app.user.click(menuItem);
    const sheet = await screen.findByRole('dialog', { name: 'Recent actions' });
    const [entry] = await entries(sheet, 1);

    const controls = [
      menuItem,
      undoOf(entry!),
      within(sheet).getByRole('button', { name: 'Close' }),
    ];

    for (const control of controls) {
      expect(control).toHaveAccessibleName();
      expect(control.className).toMatch(/min-h-11|min-w-11/);
      expect(control.className).toMatch(/focus-visible:outline/);
    }
    expect(undoOf(entry!)).toHaveAccessibleDescription(/Bookmarked\s*Article 1/);
  });
});

describe('the entries', () => {
  it('word opening an article as marking it read, with its title', async () => {
    const { app } = await open({ path: '/read/for_you', items: [item(1), item(2)] });
    await app.user.click(await screen.findByRole('button', { name: 'Article 2' }));
    await waitFor(() => expect(app.calls('POST /articles/:id/read')).toHaveLength(1));

    const sheet = await openRecent(app);

    const [entry] = await entries(sheet, 1);
    expect(within(entry!).getByText('Marked as read')).toBeVisible();
    expect(within(entry!).getByText('Article 2')).toBeVisible();
  });

  it('list the latest action first, with the article titles and the counts of bulk actions', async () => {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/feed/7',
      subscriptions: [VERGE],
      items: [item(1), item(2), item(3)],
      routes: writes.routes,
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(likeOf('Article 1'));
    await findToast('Marked as liked');
    await app.user.click(bookmarkOf('Article 2'));
    await waitFor(() => expect(writes.issued).toHaveLength(2));
    await waitFor(() => expect(rowTitles()).toEqual(['Article 2', 'Article 3']), {
      timeout: 3000,
    });
    await openMore(app, 'Verge');
    await app.user.click(
      await screen.findByRole('menuitem', { name: 'Rate these 2 visible articles' }),
    );
    await app.user.click(
      within(
        await screen.findByRole('dialog', { name: 'Rate these 2 visible articles?' }),
      ).getByRole('button', { name: 'Like all' }),
    );
    await findToast('Rated 2 articles');

    const sheet = await openRecent(app, 'Verge');

    const [bulk, bookmark, rating] = await entries(sheet, 3);
    expect(within(bulk!).getByText('Rated')).toBeVisible();
    expect(within(bulk!).getByText('2 articles')).toBeVisible();
    expect(within(bookmark!).getByText('Bookmarked')).toBeVisible();
    expect(within(bookmark!).getByText('Article 2')).toBeVisible();
    expect(within(rating!).getByText('Rating changed')).toBeVisible();
    expect(within(rating!).getByText('Article 1')).toBeVisible();
    for (const entry of [bulk!, bookmark!, rating!]) {
      expect(within(entry).getByText('now')).toBeVisible();
      expect(undoOf(entry)).toBeEnabled();
    }
  });

  it('call an article that the list no longer has "1 article"', async () => {
    const writes = writeRoutes();
    const { app, state } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      routes: writes.routes,
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));

    state.items = [item(2)];
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Article 2']));
    const sheet = await openRecent(app);

    const [entry] = await entries(sheet, 1);
    expect(within(entry!).getByText('Bookmarked')).toBeVisible();
    expect(within(entry!).getByText('1 article')).toBeVisible();
    expect(within(entry!).queryByText('Article 1')).toBeNull();
  });

  it('word Mark all read without a count, because the rows that are loaded are not all it marked', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      routes: { [MARK_READ]: () => json(200, { count: 40, mutationId: receipt(7) }) },
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );
    await findToast('Marked 40 as read');

    const sheet = await openRecent(app);

    const [entry] = await entries(sheet, 1);
    expect(within(entry!).getByText('Marked everything in a view as read')).toBeVisible();
    expect(entry).not.toHaveTextContent(/\d+ articles?/);
  });
});

describe('Undo', () => {
  it('sends the receipt of the entry and drops the entry', async () => {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      routes: { ...writes.routes, ...undoRoute() },
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(likeOf('Article 1'));
    await findToast('Marked as liked');
    await app.user.click(bookmarkOf('Article 2'));
    await waitFor(() => expect(writes.issued).toHaveLength(2));
    const sheet = await openRecent(app);
    const [newest] = await entries(sheet, 2);
    expect(within(newest!).getByText('Bookmarked')).toBeVisible();

    await app.user.click(undoOf(newest!));

    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    expect(bodyOf(app.calls(UNDO)[0]!)).toEqual({ mutationId: writes.issued[1] });
    const [rest] = await entries(sheet, 1);
    expect(within(rest!).getByText('Rating changed')).toBeVisible();
    expect(within(sheet).queryByText('Bookmarked')).toBeNull();
    expect(app.calls(UNDO)).toHaveLength(1);
  });

  it('is busy while the request is out, so a second press sends nothing', async () => {
    const writes = writeRoutes();
    const answer = deferred<Response>();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { ...writes.routes, [UNDO]: () => answer.promise },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    const sheet = await openRecent(app);
    const [entry] = await entries(sheet, 1);

    await app.user.click(undoOf(entry!));
    await waitFor(() => expect(undoOf(entry!)).toBeDisabled());
    await app.user.click(undoOf(entry!));

    expect(app.calls(UNDO)).toHaveLength(1);
    answer.resolve(json(200, { count: 0, mutationId: receipt(900), items: [] }));
    await waitFor(() => expect(entriesOf(sheet)).toHaveLength(0));
  });

  it('shows why a refused undo cannot go through and drops the entry', async () => {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: {
        ...writes.routes,
        [UNDO]: () => failure(409, 'CONFLICT', { reason: 'expired' }),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    const sheet = await openRecent(app);
    const [entry] = await entries(sheet, 1);

    await app.user.click(undoOf(entry!));

    expect(await findToast('This can no longer be undone.')).toHaveAttribute('data-tone', 'info');
    await waitFor(() => expect(entriesOf(sheet)).toHaveLength(0));
    expect(within(sheet).getByText('Nothing to undo')).toBeVisible();
  });

  it('keeps the entry, enabled again, when the request failed', async () => {
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { ...writes.routes, [UNDO]: () => failure(403, 'FORBIDDEN') },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    const sheet = await openRecent(app);
    const [entry] = await entries(sheet, 1);

    await app.user.click(undoOf(entry!));

    expect(await findToast("You don't have permission to do that.")).toHaveAttribute(
      'data-tone',
      'error',
    );
    await waitFor(() => expect(undoOf(entry!)).toBeEnabled());
    expect(entriesOf(sheet)).toHaveLength(1);
  });

  it('keeps what Mark all read did to the list: Undo from the sheet loads it and the counts again', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      routes: {
        [MARK_READ]: () => json(200, { count: 3, mutationId: receipt(7) }),
        ...undoRoute(item(1), item(2), item(3)),
      },
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );
    await findToast('Marked 3 as read');
    await waitFor(() =>
      expect(listQueries(app).filter((query) => query['limit'] === '30')).toHaveLength(2),
    );
    const sheet = await openRecent(app);
    const [entry] = await entries(sheet, 1);
    const listed = listQueries(app).length;
    const counted = countsQueries(app).length;

    await app.user.click(undoOf(entry!));

    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    expect(bodyOf(app.calls(UNDO)[0]!)).toEqual({ mutationId: receipt(7) });
    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(listed));
    await waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(counted));
    await waitFor(() => expect(entriesOf(sheet)).toHaveLength(0));
  });

  it('still loads the list again when the Undo of the Mark all read toast finds newer changes', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      routes: {
        [MARK_READ]: () => json(200, { count: 2, mutationId: receipt(7) }),
        [UNDO]: () => failure(409, 'STALE_STATE', { items: [item(1), item(2)] }),
      },
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await app.user.click(
      within(await screen.findByRole('dialog', { name: 'Mark all as read?' })).getByRole('button', {
        name: 'Mark as read',
      }),
    );
    const toast = await findToast('Marked 2 as read');
    await waitFor(() =>
      expect(listQueries(app).filter((query) => query['limit'] === '30')).toHaveLength(2),
    );
    const listed = listQueries(app).length;

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await findToast('Newer changes were kept.');
    await waitFor(() => expect(listQueries(app).length).toBeGreaterThan(listed));
  });
});

describe('time', () => {
  it('drops an entry once it is ten minutes old, while the sheet is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1), item(2)],
      routes: writes.routes,
    });
    await screen.findByRole('article', { name: 'Article 2' });
    await app.user.click(likeOf('Article 1'));
    await findToast('Marked as liked');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * MINUTE);
    });
    await app.user.click(bookmarkOf('Article 2'));
    await waitFor(() => expect(writes.issued).toHaveLength(2));
    const sheet = await openRecent(app);
    const [newer, older] = await entries(sheet, 2);
    expect(within(newer!).getByText('Bookmarked')).toBeVisible();
    expect(within(newer!).getByText('now')).toBeVisible();
    expect(within(older!).getByText('Rating changed')).toBeVisible();
    expect(within(older!).getByText('6 minutes ago')).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
    });

    const [left] = await entries(sheet, 1);
    expect(within(left!).getByText('Bookmarked')).toBeVisible();
    expect(within(left!).getByText('5 minutes ago')).toBeVisible();
    expect(within(sheet).queryByText('Rating changed')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * MINUTE);
    });
    await entries(sheet, 0);
    expect(within(sheet).getByText('Nothing to undo')).toBeVisible();
  });

  it('still offers Undo up to the last minute of the ten', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writes = writeRoutes();
    const { app } = await open({
      path: '/read/for_you',
      items: [item(1)],
      routes: { ...writes.routes, ...undoRoute() },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(bookmarkOf('Article 1'));
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * MINUTE + 30_000);
    });

    const sheet = await openRecent(app);

    const [entry] = await entries(sheet, 1);
    expect(within(entry!).getByText('9 minutes ago')).toBeVisible();
    await app.user.click(undoOf(entry!));
    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
  });
});

describe('in Slovak', () => {
  it('names the item, the sheet and the empty state', async () => {
    const { app } = await open({ path: '/read/for_you', me: makeMe({ locale: 'sk' }) });

    await openMore(app, 'Pre vás', 'Viac');
    await app.user.click(screen.getByRole('menuitem', { name: 'Nedávne akcie' }));

    const sheet = await screen.findByRole('dialog', { name: 'Nedávne akcie' });
    expect(sheet).toHaveAccessibleDescription('Každú akciu môžete vrátiť späť do 10 minút.');
    expect(within(sheet).getByText('Nie je čo vrátiť späť')).toBeVisible();
    expect(
      within(sheet).getByText('To, čo v čítačke urobíte, sa tu zobrazí na 10 minút.'),
    ).toBeVisible();
  });

  it('words the entries and counts them in the right plural', async () => {
    const writes = writeRoutes();
    const rows = [item(1), item(2), item(3)];
    const { app } = await open({
      path: '/read/feed/7',
      me: makeMe({ locale: 'sk' }),
      subscriptions: [VERGE],
      items: rows,
      routes: writes.routes,
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(
      within(screen.getByRole('article', { name: 'Article 1' })).getByRole('button', {
        name: 'Záložka',
      }),
    );
    await waitFor(() => expect(writes.issued).toHaveLength(1));
    await openMore(app, 'Verge', 'Viac');
    await app.user.click(
      await screen.findByRole('menuitem', { name: 'Ohodnotiť tieto 3 viditeľné články' }),
    );
    await app.user.click(
      within(
        await screen.findByRole('dialog', { name: 'Ohodnotiť tieto 3 viditeľné články?' }),
      ).getByRole('button', { name: 'Označiť všetky ako „páči sa mi“' }),
    );
    await findToast('Ohodnotené: 3');

    await openMore(app, 'Verge', 'Viac');
    await app.user.click(screen.getByRole('menuitem', { name: 'Nedávne akcie' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nedávne akcie' });

    const [bulk, bookmark] = await entries(sheet, 2);
    expect(within(bulk!).getByText('Ohodnotené')).toBeVisible();
    expect(within(bulk!).getByText('3 články')).toBeVisible();
    expect(within(bulk!).getByText('teraz')).toBeVisible();
    expect(within(bookmark!).getByText('Pridané do záložiek')).toBeVisible();
    expect(within(bookmark!).getByText('Article 1')).toBeVisible();
    expect(within(bookmark!).getByRole('button', { name: 'Vrátiť späť' })).toBeVisible();
  });
});

/** The kinds of action that `recent()` can hold: the ones that can be undone, and the bulk actions. */
const KINDS: Record<Exclude<RecentAction['kind'], 'open' | 'dwell' | 'retryCapture'>, true> = {
  read: true,
  unread: true,
  unhide: true,
  rate: true,
  promptAnswer: true,
  bookmark: true,
  unbookmark: true,
  addLabel: true,
  removeLabel: true,
  markRead: true,
  markReadFilter: true,
  rateBulk: true,
};

describe('the words of an entry', () => {
  it.each(LANGUAGES)('exist in %s for every kind of action that can be listed', (language) => {
    const i18n = createI18n(language);
    for (const kind of Object.keys(KINDS)) {
      expect(i18n.getResource(language, 'reader', `recent.kind.${kind}`)).toEqual(
        expect.any(String),
      );
    }
    const t = i18n.getFixedT(language, 'reader');
    expect(t('recent.kind.other')).not.toBe('recent.kind.other');
    expect(t(['recent.kind.dwell', 'recent.kind.other'])).toBe(t('recent.kind.other'));
  });
});
