import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { articleKeys } from '../../src/features/article/query-keys.js';
import { articleListKey } from '../../src/features/reader/queries.js';
import { saveDetail, setOfflineEnabled } from '../../src/offline/cache.js';
import { json } from '../api/fake-fetch.js';
import { deferred, makeDetail } from '../article/harness.js';
import {
  item,
  listQueries,
  page,
  rowOf,
  rowTitles,
  type ReaderOptions,
} from '../reader/support.js';
import { makeMe } from '../session/fixtures.js';
import { recordsReach } from './replay-support.js';
import {
  FOR_YOU,
  connection,
  createSavedHarness,
  keepView,
  leave,
  storedDetail,
  storedView,
  viewReaches,
  type Connection,
} from './saved-support.js';
import { A, HOUR, T0, freshIndexedDb, setClock } from './support.js';

const idb = freshIndexedDb();
const harness = createSavedHarness();

const LINE = /^Offline\. Showing articles saved on this device at .+\.$/;
/** The time zone of the account the tests sign in as. */
const ZONE = makeMe().timezone;

const TWO: ReaderOptions = {
  path: '/read/for_you',
  list: () => json(200, page([item(1), item(2)], { nextCursor: 'c1' })),
};

/** A visit with a connection by an account that chose offline reading; the page is left afterwards. */
async function visit(
  net: Connection,
  options: ReaderOptions,
  ids: string[],
  { opened }: { opened?: string } = {},
) {
  await setOfflineEnabled(A, true);
  const { app } = await harness.open(net, options);
  await screen.findByRole('article', { name: `Article ${ids[0]}` });
  if (opened !== undefined) {
    await app.user.click(screen.getByRole('button', { name: opened }));
    await screen.findByText('The excerpt of the article.');
    await waitFor(async () => expect(await storedDetail(idb.factory, '1')).toBeDefined());
  }
  await viewReaches(idb.factory, ids);
  await leave(app);
}

describe('showing the saved list', () => {
  it('shows the rows saved for the view, and says so, when the page is opened offline', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();

    await harness.open(net, { path: '/read/for_you' });

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('shows the rows an earlier visit saved', async () => {
    const net = connection();
    await visit(net, TWO, ['1', '2']);
    net.lose();

    await harness.open(net, { path: '/read/for_you' });

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
  });

  it('shows the rows when the request fails although the browser says it is online', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.blackhole();

    const { app } = await harness.open(net, { path: '/read/for_you' });

    expect(await screen.findByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect(listQueries(app)).toHaveLength(1);
  });

  it('keeps the offline state when nothing was saved for the view', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();

    await harness.open(net, { path: '/read/maybe' });

    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('keeps the offline state when the saved copy of the view has no rows', async () => {
    const net = connection();
    await keepView([]);
    net.lose();

    await harness.open(net, { path: '/read/for_you' });

    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('says so in Slovak', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();

    await harness.open(net, { path: '/read/for_you', me: makeMe({ locale: 'sk' }) });

    const line = await screen.findByText(
      /^Offline\. Zobrazujú sa články uložené v tomto zariadení o .+\.$/,
    );
    expect(line).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
  });

  it('keeps the offline state when the account never chose offline reading', async () => {
    const net = connection();
    const { app } = await harness.open(net, TWO);
    await screen.findByRole('article', { name: 'Article 1' });
    await leave(app);
    net.lose();

    await harness.open(net, { path: '/read/for_you' });

    expect(await screen.findByText("You're offline")).toBeVisible();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('keeps the saved rows out of the query cache, the list and the opened article alike', async () => {
    const net = connection();
    await keepView([1, 2]);
    await saveDetail(A, makeDetail(item(1)));
    net.lose();
    const { app } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));
    await screen.findByText('The excerpt of the article.');

    const cache = app.queryClient;
    expect(cache.getQueryData(articleListKey(A, FOR_YOU, 1, 'score'))).toBeUndefined();
    expect(cache.getQueryData(articleKeys.detail(A, '1', {}))).toBeUndefined();
    for (const query of cache.getQueryCache().getAll()) {
      const data = JSON.stringify(query.state.data ?? null);
      expect(data).not.toContain('Article 1');
      expect(data).not.toContain('The excerpt of the article.');
    }
    expect(screen.getByText(LINE)).toBeVisible();
  });

  it('shows an article that an earlier visit opened', async () => {
    const net = connection();
    await visit(net, TWO, ['1', '2'], { opened: 'Article 1' });
    net.lose();
    const { app } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByText(LINE);

    await app.user.click(screen.getByRole('button', { name: 'Article 1' }));

    expect(await screen.findByText('The excerpt of the article.')).toBeVisible();
    expect(screen.queryByText('Connect to load this article')).toBeNull();
  });

  it('says to connect for an article that was not opened before', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();
    const { app } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByText(LINE);

    await app.user.click(screen.getByRole('button', { name: 'Article 2' }));

    const pane = await screen.findByRole('complementary', { name: 'Article' });
    expect(await within(pane).findByText('Connect to load this article')).toBeVisible();
    expect(within(pane).queryByRole('status', { name: 'Loading…' })).toBeNull();
  });

  it('puts the row actions in the queue as they are put there offline', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();
    const { app } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByText(LINE);

    const like = within(rowOf('Article 1')).getByRole('button', { name: 'Like' });
    await app.user.click(like);

    expect(like).toHaveAttribute('aria-pressed', 'true');
    const [record] = await recordsReach(idb.factory, 1);
    expect(record).toMatchObject({ articleId: '1', action: { type: 'rate', rating: 1 } });
    expect(app.calls('POST /articles/:id/rating')).toEqual([]);
  });
});

describe('saying when the copy was saved', () => {
  it('gives the time of the day for a copy saved today', async () => {
    const net = connection();
    setClock(T0);
    await keepView([1, 2]);
    net.lose();
    setClock(T0 + 60_000);

    await harness.open(net, { path: '/read/for_you' });

    const line = await screen.findByText(LINE);
    const time = new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: ZONE }).format(T0);
    expect(line.textContent).toBe(`Offline. Showing articles saved on this device at ${time}.`);
  });

  it('adds the date for a copy saved on an earlier day', async () => {
    const net = connection();
    setClock(T0);
    await keepView([1, 2]);
    net.lose();
    setClock(T0 + 23 * HOUR);

    await harness.open(net, { path: '/read/for_you' });

    const line = await screen.findByText(LINE);
    const when = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: ZONE,
    }).format(T0);
    expect(line.textContent).toBe(`Offline. Showing articles saved on this device at ${when}.`);
  });
});

describe('when the connection is back', () => {
  it('loads the list again and drops the line once live rows are there', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();
    const { app, state } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByText(LINE);
    const before = listQueries(app).length;
    state.items = [item(7), item(1)];

    net.restore();

    expect(await screen.findByRole('article', { name: 'Article 7' })).toBeVisible();
    expect(rowTitles()).toEqual(['Article 7', 'Article 1']);
    expect(screen.queryByText(LINE)).toBeNull();
    expect(listQueries(app)).toHaveLength(before + 1);
    expect(app.queryClient.getQueryData(articleListKey(A, FOR_YOU, 1, 'score'))).toBeDefined();
  });

  it('keeps the saved rows and the line until the live rows have arrived', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.lose();
    const live = deferred<Response>();
    const { app } = await harness.open(net, { path: '/read/for_you', list: () => live.promise });
    await screen.findByText(LINE);

    net.restore();

    await waitFor(() => expect(listQueries(app)).toHaveLength(2));
    expect(screen.getByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();

    await act(async () => {
      live.resolve(json(200, page([item(7)])));
      await live.promise;
    });

    expect(await screen.findByRole('article', { name: 'Article 7' })).toBeVisible();
    expect(rowTitles()).toEqual(['Article 7']);
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('loads a list that the device has no copy of', async () => {
    const net = connection();
    net.lose();
    const { app, state } = await harness.open(net, { path: '/read/for_you' });
    expect(await screen.findByText("You're offline")).toBeVisible();
    const before = listQueries(app).length;
    state.items = [item(7)];

    net.restore();

    expect(await screen.findByRole('article', { name: 'Article 7' })).toBeVisible();
    expect(screen.queryByText("You're offline")).toBeNull();
    expect(listQueries(app)).toHaveLength(before + 1);
  });

  it('keeps the saved rows when the server still cannot be reached', async () => {
    const net = connection();
    await keepView([1, 2]);
    net.blackhole();
    const { app } = await harness.open(net, { path: '/read/for_you' });
    await screen.findByText(LINE);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    await waitFor(() => expect(listQueries(app)).toHaveLength(2));
    expect(screen.getByText(LINE)).toBeVisible();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2']);
    expect((await storedView(idb.factory, FOR_YOU))?.itemIds).toEqual(['1', '2']);
  });
});
