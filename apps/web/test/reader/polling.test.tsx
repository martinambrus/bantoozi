import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { failure, json } from '../api/fake-fetch.js';
import { restoreVisibility, setVisibility } from '../article/harness.js';
import { createReaderHarness, item, page, rowTitles } from './support.js';

const { open } = createReaderHarness();

afterEach(() => {
  restoreVisibility();
});

type App = Awaited<ReturnType<typeof open>>['app'];

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const lists = (app: App) => app.calls('GET /articles').length;
const counts = (app: App) => app.calls('GET /articles/counts').length;

async function openReader(options: Parameters<typeof open>[0]) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const opened = await open(options);
  await screen.findByRole('article', { name: 'Article 1' });
  return opened;
}

describe('polling while the server works', () => {
  it('asks for the list and the counts every 5 seconds while the list is waiting for a ranking', async () => {
    const { app } = await openReader({
      path: '/read/for_you',
      list: () => json(200, page([item(1)], { rankingPending: true })),
    });
    const listed = lists(app);
    const counted = counts(app);

    await advance(5_500);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 1);
    expect(app.calls('GET /articles').at(-1)!.query.has('cursor')).toBe(false);

    await advance(5_000);

    expect(lists(app)).toBe(listed + 2);
    expect(counts(app)).toBe(counted + 2);
  });

  it('does the same while the counts are waiting for a ranking', async () => {
    const { app } = await openReader({
      path: '/read/for_you',
      items: [item(1)],
      counts: { rankingPending: true },
    });
    const listed = lists(app);
    const counted = counts(app);

    await advance(5_500);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 1);
  });

  it.each(['pending', 'running'] as const)(
    'does the same while a loaded article is %s analysis',
    async (status) => {
      const { app } = await openReader({
        path: '/read/for_you',
        items: [
          item(1, {
            analysis: { mode: 'active', status, requestId: '0192f7a0-0000-7000-8000-0000000000aa' },
          }),
        ],
      });
      const listed = lists(app);
      const counted = counts(app);

      await advance(5_500);

      expect(lists(app)).toBe(listed + 1);
      expect(counts(app)).toBe(counted + 1);
    },
  );

  it('keeps polling the list of a feed view and the counts of both scopes', async () => {
    const { app } = await openReader({
      path: '/read/feed/7',
      list: () => json(200, page([item(1)], { rankingPending: true })),
    });
    const listed = lists(app);
    const counted = counts(app);

    await advance(5_500);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 2);
  });

  it('asks again for every page that is loaded and keeps the rows', async () => {
    const { app } = await openReader({
      path: '/read/for_you',
      list: (request) =>
        request.query.get('cursor') === 'c1'
          ? json(200, page([item(3), item(4)], { rankingPending: true }))
          : json(200, page([item(1), item(2)], { nextCursor: 'c1', rankingPending: true })),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('article', { name: 'Article 4' });
    const listed = lists(app);

    await advance(5_500);

    expect(lists(app)).toBe(listed + 2);
    expect(
      app
        .calls('GET /articles')
        .slice(-2)
        .map((request) => request.query.get('cursor')),
    ).toEqual([null, 'c1']);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3', 'Article 4']);
  });

  it('leaves the rows as they are when a page of the chain is refused', async () => {
    let refuse = false;
    const { app } = await openReader({
      path: '/read/for_you',
      list: (request) => {
        if (request.query.get('cursor') !== 'c1') {
          return json(200, page([item(1), item(2)], { nextCursor: 'c1', rankingPending: true }));
        }
        return refuse
          ? failure(409, 'STALE_CURSOR')
          : json(200, page([item(3)], { rankingPending: true }));
      },
    });
    await app.user.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('article', { name: 'Article 3' });
    refuse = true;
    const listed = lists(app);

    await advance(5_500);

    expect(lists(app)).toBe(listed + 2);
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for the counts every 30 seconds when idle, and never for the list', async () => {
    const { app } = await openReader({ path: '/read/for_you', items: [item(1)] });
    const listed = lists(app);
    const counted = counts(app);

    await advance(25_000);

    expect(counts(app)).toBe(counted);
    expect(lists(app)).toBe(listed);

    await advance(10_000);

    expect(counts(app)).toBe(counted + 1);
    expect(lists(app)).toBe(listed);

    await advance(30_000);

    expect(counts(app)).toBe(counted + 2);
    expect(lists(app)).toBe(listed);
  });

  it('does not count an article that nobody asked to analyse as work in progress', async () => {
    const { app } = await openReader({
      path: '/read/for_you',
      items: [item(1, { analysis: { mode: 'off', status: 'not_requested', requestId: null } })],
    });
    const listed = lists(app);

    await advance(40_000);

    expect(lists(app)).toBe(listed);
  });

  it('slows down once the server has caught up', async () => {
    let pending = true;
    const { app } = await openReader({
      path: '/read/for_you',
      list: () => json(200, page([item(1)], { rankingPending: pending })),
      routes: {
        'GET /articles/counts': () =>
          json(200, {
            forYou: 3,
            maybe: 4,
            everything: 12,
            new: 5,
            bookmarks: 2,
            hidden: 1,
            scored: 19,
            total: 24,
            asOf: '2026-05-31T10:00:00.000Z',
            datasetVersion: 'd',
            rankingPending: pending,
          }),
      },
    });
    const listed = lists(app);
    const counted = counts(app);
    pending = false;

    await advance(5_500);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 1);

    await advance(20_000);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 1);

    await advance(15_000);

    expect(lists(app)).toBe(listed + 1);
    expect(counts(app)).toBe(counted + 2);
  });
});

describe('no polling while nobody looks', () => {
  const working = {
    path: '/read/for_you',
    list: () => json(200, page([item(1)], { rankingPending: true })),
  };

  it('stops while the page is hidden and goes on when it is shown again', async () => {
    const { app } = await openReader(working);
    setVisibility('hidden');
    const listed = lists(app);
    const counted = counts(app);

    await advance(60_000);

    expect(lists(app)).toBe(listed);
    expect(counts(app)).toBe(counted);

    setVisibility('visible');
    await advance(500);
    const resumed = lists(app);
    await advance(5_500);

    expect(lists(app)).toBeGreaterThan(resumed);
    expect(counts(app)).toBeGreaterThan(counted);
  });

  it('stops while the reader is offline and goes on when the connection is back', async () => {
    const { app } = await openReader(working);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const listed = lists(app);
    const counted = counts(app);

    await advance(60_000);

    expect(lists(app)).toBe(listed);
    expect(counts(app)).toBe(counted);

    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await advance(500);
    const resumed = lists(app);
    await advance(5_500);

    expect(lists(app)).toBeGreaterThan(resumed);
    expect(counts(app)).toBeGreaterThan(counted);
  });

  it('stops when the reader is left', async () => {
    const { app } = await openReader(working);
    app.unmount();
    const listed = lists(app);
    const counted = counts(app);

    await advance(60_000);

    expect(lists(app)).toBe(listed);
    expect(counts(app)).toBe(counted);
  });
});
