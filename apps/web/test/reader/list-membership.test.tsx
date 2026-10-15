import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { actionResponse, deferred, findToast, ratingResponse } from '../article/harness.js';
import { makeMe } from '../session/fixtures.js';
import { acked } from './actions/fake-transport.js';
import { createReaderHarness, item, page, rowTitles } from './support.js';
import { likeOf, receipt } from './surfaces.js';

const { open } = createReaderHarness();

const READ_AT = '2026-05-31T10:00:00.000Z';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

type Opened = Awaited<ReturnType<typeof open>>;
const lists = (opened: Opened) => opened.app.calls('GET /articles').length;

/** The articles the server still lists: the ones nobody has read. */
function unreadServer(rows: ReturnType<typeof item>[], pending: () => boolean) {
  const read = new Set<string>();
  let loads = 0;
  return {
    read,
    /** Every answer differs from the one before, as a page that was ranked again does. */
    list: () => {
      loads += 1;
      return json(
        200,
        page(
          rows.filter((row) => !read.has(row.id)),
          { rankingPending: pending(), datasetVersion: `d-${loads}` },
        ),
      );
    },
    readRoute: {
      'POST /articles/:id/read': (_request: unknown, params: Record<string, string>) => {
        read.add(params['id']!);
        return actionResponse(
          acked(
            rows.find((row) => row.id === params['id'])!,
            { readAt: READ_AT },
          ),
        );
      },
    },
  };
}

describe('rows the reader rated keep their place across background reloads', () => {
  it('keeps a rated row gone when a poll lands before its rating is committed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    let busy = true;
    const server = unreadServer(rows, () => busy);
    const slow = deferred<Response>();
    await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: {
        'POST /articles/:id/rating': async (_request, params) => {
          const id = params['id']!;
          if (id === '2') await slow.promise;
          server.read.add(id);
          return ratingResponse(
            acked(
              rows.find((row) => row.id === id)!,
              { rating: 1, readAt: READ_AT },
            ),
          );
        },
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    for (const n of [1, 2]) fireEvent.click(likeOf(`Article ${n}`));
    await advance(600);
    expect(rowTitles()).toEqual(['Article 3']);

    // The poll that lands before the rating of Article 2 does is the last one.
    busy = false;
    await advance(5_000);
    slow.resolve(new Response());
    await advance(31_000);

    expect(rowTitles()).toEqual(['Article 3']);
  });

  it('keeps a rated row gone when a poll lands during its exit animation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    const slow = deferred<Response>();
    const opened = await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: {
        'POST /articles/:id/rating': async (_request, params) => {
          await slow.promise;
          server.read.add(params['id']!);
          return ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1, readAt: READ_AT },
            ),
          );
        },
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    const polled = lists(opened);
    while (lists(opened) === polled) await advance(100);
    await advance(4_650);
    fireEvent.click(likeOf('Article 1'));
    const before = lists(opened);
    // The poll lands within the 400 ms the row takes to leave.
    for (let step = 0; step < 7 && lists(opened) === before; step += 1) await advance(50);
    expect(lists(opened)).toBeGreaterThan(before);
    await advance(600);

    expect(rowTitles()).toEqual(['Article 2', 'Article 3']);
    slow.resolve(new Response());
    await advance(1_000);
    expect(rowTitles()).toEqual(['Article 2', 'Article 3']);
  });

  it('brings a row back when its rating is undone', async () => {
    const rows = [item(1), item(2), item(3)];
    const { app } = await open({
      path: '/read/for_you',
      items: rows,
      routes: {
        'POST /articles/:id/rating': (_request, params) =>
          ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1, readAt: READ_AT },
            ),
          ),
        'POST /articles/undo': () =>
          json(200, {
            count: 1,
            mutationId: receipt(900),
            items: [item(2, { stateVersion: '6' })],
          }),
      },
    });
    await screen.findByRole('article', { name: 'Article 3' });
    await app.user.click(likeOf('Article 2'));
    const toast = await findToast('Marked as liked');
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 3']), { timeout: 3000 });

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
  });

  it('brings a row back on Undo after a poll landed between the rating and the Undo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    const opened = await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: {
        'POST /articles/:id/rating': (_request, params) => {
          server.read.add(params['id']!);
          return ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1, readAt: READ_AT },
            ),
          );
        },
        'POST /articles/undo': () =>
          json(200, {
            count: 1,
            mutationId: receipt(900),
            items: [item(2, { stateVersion: '6' })],
          }),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    const polled = lists(opened);
    while (lists(opened) === polled) await advance(100);
    await advance(3_000);
    fireEvent.click(likeOf('Article 2'));
    await advance(600);
    expect(rowTitles()).toEqual(['Article 1', 'Article 3']);
    // The poll lands while the Undo toast is still up.
    const before = lists(opened);
    for (let step = 0; step < 30 && lists(opened) === before; step += 1) await advance(100);
    expect(lists(opened)).toBeGreaterThan(before);
    await advance(200);
    expect(rowTitles()).toEqual(['Article 1', 'Article 3']);

    const toast = await findToast('Marked as liked');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await advance(100);

    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
  });

  it('keeps a row the explicit reload returns visible when its exit timer fires after the reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    let rated = false;
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { markReadOnRate: false } }),
      list: () =>
        json(
          200,
          page(
            rows.map((row) => (rated && row.id === rows[1]!.id ? { ...row, rating: 1 } : row)),
            { rankingPending: true },
          ),
        ),
      routes: {
        'POST /articles/:id/rating': (_request, params) => {
          rated = true;
          return ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1 },
            ),
          );
        },
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(likeOf('Article 2'));
    await advance(100);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await advance(1_000);

    expect(app.calls('GET /articles').length).toBeGreaterThan(1);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
  });

  it('brings rated rows that are still unread back when the reader refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { markReadOnRate: false } }),
      list: () => json(200, page(rows, { rankingPending: true })),
      routes: {
        'POST /articles/:id/rating': (_request, params) =>
          ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1 },
            ),
          ),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(likeOf('Article 2'));
    await advance(600);
    await advance(5_500);
    expect(rowTitles()).toEqual(['Article 1', 'Article 3']);

    vi.useRealTimers();
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
  });
  it('brings rated rows that are still unread back when another tier replaces the list', async () => {
    const rows = [item(1), item(2), item(3)];
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { markReadOnRate: false } }),
      list: () => json(200, page(rows)),
      routes: {
        'POST /articles/:id/rating': (_request, params) =>
          ratingResponse(
            acked(
              rows.find((row) => row.id === params['id'])!,
              { rating: 1 },
            ),
          ),
      },
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(likeOf('Article 2'));
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 3']));

    fireEvent.change(screen.getByRole('slider', { name: 'Minimum tier' }), {
      target: { value: '3' },
    });

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));
  });
});

describe('rows the reader read keep their place across background reloads', () => {
  it('keeps an opened article in the list after a poll no longer returns it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: server.readRoute,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));

    await advance(5_500);

    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(screen.getByRole('button', { name: 'Article 2' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('drops the read rows when the reader refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    const { app } = await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: server.readRoute,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));
    await advance(5_500);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);

    vi.useRealTimers();
    await app.user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 3']));
  });

  it('drops the read rows when the reader turns Show read off', async () => {
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => false);
    const { app } = await open({
      path: '/read/for_you',
      me: makeMe({ preferences: { showRead: true } }),
      items: rows,
      list: (request) =>
        request.query.get('status') === 'all' ? json(200, page(rows)) : server.list(),
      routes: server.readRoute,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    await app.user.click(screen.getByRole('button', { name: 'Article 2' }));
    await waitFor(() => expect(server.read.has(item(2).id)).toBe(true));

    await app.user.click(screen.getByRole('switch', { name: 'Show read' }));

    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 3']));
  });

  it('drops the read rows when the counts of a Refresh come back first with new articles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    let held: ReturnType<typeof deferred<Response>> | null = null;
    let requested = 0;
    const opened = await open({
      path: '/read/for_you',
      items: rows,
      list: () => {
        if (held === null) return server.list();
        requested += 1;
        return held.promise.then(() => server.list());
      },
      routes: server.readRoute,
    });
    const { state } = opened;
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));
    await advance(5_500);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    // Collapsed again, so a rise of the counts may reload the list by itself.
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));

    // The counts of the Refresh come back with new articles while its own list is still on the way.
    const hold = deferred<Response>();
    held = hold;
    state.counts = { ...state.counts, forYou: state.counts.forYou + 2 };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await advance(1_000);
    // The Refresh's own list request, then the one the risen count started, which cancels it.
    expect(requested).toBe(2);
    held = null;
    hold.resolve(new Response());
    await advance(1_000);

    expect(rowTitles()).toEqual(['Article 1', 'Article 3']);
  });

  it('does not keep polling for a kept row whose analysis was pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [
      item(1),
      item(2, {
        analysis: {
          mode: 'active',
          status: 'pending',
          requestId: '0192f7a0-0000-7000-8000-0000000000aa',
        },
      }),
      item(3),
    ];
    const server = unreadServer(rows, () => false);
    const opened = await open({
      path: '/read/for_you',
      items: rows,
      list: server.list,
      routes: server.readRoute,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));
    await advance(5_500);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    const listed = lists(opened);

    await advance(21_000);

    expect(lists(opened)).toBe(listed);
  });

  it('does not show a kept row twice when Load more returns it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rows = [item(1), item(2), item(3)];
    const server = unreadServer(rows, () => true);
    await open({
      path: '/read/for_you',
      items: rows,
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(2), item(4)]))
          : json(
              200,
              page(
                rows.filter((row) => !server.read.has(row.id)),
                { rankingPending: true, nextCursor: 'c1' },
              ),
            ),
      routes: server.readRoute,
    });
    await screen.findByRole('article', { name: 'Article 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Article 2' }));
    await advance(5_500);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await advance(100);

    const titles = rowTitles();
    expect(titles).toContain('Article 4');
    expect(new Set(titles).size).toBe(titles.length);
  });
});
