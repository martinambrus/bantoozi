import type { ArticleListItem, BookmarkCapture } from '@bantoozi/shared';
import { onlineManager } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArticleDetail } from '../../src/features/article/article-detail.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { useObserveItems } from '../../src/features/reader/actions/provider.js';
import { setOfflineEnabled } from '../../src/offline/cache.js';
import { connection } from '../offline/saved-support.js';
import { A, freshIndexedDb } from '../offline/support.js';
import { acked } from '../reader/actions/fake-transport.js';
import { rowOf } from '../reader/support.js';
import type { ApiRouteHandler } from '../support/app.js';
import {
  actionResponse,
  detailRoute,
  makeItem,
  ratingResponse,
  renderReader,
  type ReaderHarnessOptions,
} from './harness.js';

freshIndexedDb();

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

const WAITING = 'Waiting to sync';
const STAMP = '2026-10-08T08:00:00.000Z';
const FIRST = makeItem({ id: '101', title: 'First article' });
const SECOND = makeItem({ id: '102', title: 'Second article' });
const ROWS = [FIRST, SECOND];

function Rows() {
  useObserveItems(ROWS);
  return (
    <ul>
      {ROWS.map((row) => (
        <li key={row.id}>
          <ArticleRow item={row} expanded={false} onToggleExpand={() => {}} simple={false} />
        </li>
      ))}
    </ul>
  );
}

function capture(status: BookmarkCapture['status']): BookmarkCapture {
  return {
    status,
    generation: '1',
    snapshotId: status === 'pending' ? null : '9',
    capturedAt: status === 'pending' ? null : STAMP,
    errorCode: null,
  };
}

/** What the server answers to the changes that wait, once they are sent. */
function accepting(item: ArticleListItem): Record<string, ApiRouteHandler> {
  return {
    'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: 1, readAt: STAMP })),
    'POST /articles/:id/bookmark': () =>
      actionResponse(acked(item, { bookmarkedAt: STAMP, bookmarkCapture: capture('pending') })),
  };
}

/** The account chose offline reading and the device has no connection. */
async function offline() {
  await setOfflineEnabled(A, true);
  const net = connection();
  net.lose();
  return net;
}

describe('a row whose article has a change waiting to be sent', () => {
  it('says so, in the row and in the description of its title, and only in that row', async () => {
    await offline();
    const { user } = renderReader(<Rows />, { routes: accepting(FIRST) });

    await user.click(within(rowOf('First article')).getByRole('button', { name: 'Like' }));

    const row = rowOf('First article');
    expect(within(row).getByText(WAITING)).toBeVisible();
    expect(within(row).getByRole('button', { name: 'First article' })).toHaveAccessibleDescription(
      WAITING,
    );
    const other = rowOf('Second article');
    expect(within(other).queryByText(WAITING)).toBeNull();
    expect(
      within(other).getByRole('button', { name: 'Second article' }),
    ).not.toHaveAccessibleDescription();
  });

  it('says so in Slovak', async () => {
    await offline();
    const { user } = renderReader(<Rows />, { language: 'sk', routes: accepting(FIRST) });

    await user.click(within(rowOf('First article')).getByRole('button', { name: 'Páči sa mi' }));

    expect(within(rowOf('First article')).getByText('Čaká na synchronizáciu')).toBeVisible();
  });

  it('says nothing about a change that was sent at once', async () => {
    await setOfflineEnabled(A, true);
    connection();
    const { user, calls } = renderReader(<Rows />, { routes: accepting(FIRST) });

    await user.click(within(rowOf('First article')).getByRole('button', { name: 'Like' }));

    await waitFor(() => expect(calls('POST', '/articles/101/rating')).toHaveLength(1));
    await waitFor(() =>
      expect(within(rowOf('First article')).getByRole('button', { name: 'Like' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it('stops saying so once the change has been sent', async () => {
    const net = await offline();
    const { user, calls } = renderReader(<Rows />, { routes: accepting(FIRST) });
    await user.click(within(rowOf('First article')).getByRole('button', { name: 'Like' }));
    expect(within(rowOf('First article')).getByText(WAITING)).toBeVisible();

    net.restore();

    await waitFor(() => expect(within(rowOf('First article')).queryByText(WAITING)).toBeNull());
    await waitFor(() => expect(calls('POST', '/articles/101/rating')).toHaveLength(1));
    expect(within(rowOf('First article')).getByRole('button', { name: 'Like' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('the opened article whose change is waiting to be sent', () => {
  it('says so once', async () => {
    const net = connection();
    await setOfflineEnabled(A, true);
    const { user } = renderReader(<ArticleDetail item={FIRST} />, {
      routes: { ...detailRoute(FIRST), ...accepting(FIRST) },
    });
    await screen.findByText('The excerpt of the article.');
    net.lose();

    await user.click(screen.getByRole('button', { name: 'Like' }));

    expect(screen.getAllByText(WAITING)).toHaveLength(1);
  });

  it('stops saying so once the change has been sent', async () => {
    const net = connection();
    await setOfflineEnabled(A, true);
    const { user } = renderReader(<ArticleDetail item={FIRST} />, {
      routes: { ...detailRoute(FIRST), ...accepting(FIRST) },
    });
    await screen.findByText('The excerpt of the article.');
    net.lose();
    await user.click(screen.getByRole('button', { name: 'Like' }));
    expect(screen.getAllByText(WAITING)).toHaveLength(1);

    net.restore();

    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
  });
});

describe('a bookmark whose change is waiting to be sent', () => {
  async function bookmarkOffline(item: ArticleListItem, options: ReaderHarnessOptions = {}) {
    const net = connection();
    await setOfflineEnabled(A, true);
    const view = renderReader(<ArticleDetail item={item} />, {
      ...options,
      routes: { ...detailRoute(item), ...accepting(item), ...options.routes },
    });
    await screen.findByText('The excerpt of the article.');
    net.lose();
    await view.user.click(screen.getByRole('button', { name: 'Bookmark' }));
    return { ...view, net };
  }

  it('shows "Waiting to sync" and no capture status for a bookmark that was never captured', async () => {
    await bookmarkOffline(FIRST);

    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getAllByText(WAITING)).toHaveLength(1);
    expect(screen.queryByText(/Saving article|text saved|Could not capture/)).toBeNull();
  });

  it('never shows the old capture status of an earlier bookmark', async () => {
    const earlier = makeItem({
      id: '101',
      title: 'First article',
      bookmarkCapture: capture('saved'),
    });

    await bookmarkOffline(earlier);

    expect(screen.getAllByText(WAITING)).toHaveLength(1);
    expect(screen.queryByText('Full text saved')).toBeNull();
    expect(screen.queryByText(/Text and formatting saved/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry capture' })).toBeNull();
  });

  it('shows "Waiting to sync" for the removal of a bookmark too', async () => {
    const bookmarked = makeItem({
      id: '101',
      title: 'First article',
      bookmarkedAt: STAMP,
      bookmarkCapture: capture('saved'),
    });

    await bookmarkOffline(bookmarked);

    expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getAllByText(WAITING)).toHaveLength(1);
    expect(screen.queryByText('Full text saved')).toBeNull();
  });

  it('shows the capture status of the bookmark once it was sent', async () => {
    const { net } = await bookmarkOffline(FIRST);
    expect(screen.getAllByText(WAITING)).toHaveLength(1);

    net.restore();

    expect(await screen.findByText('Saving article')).toBeVisible();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it('keeps the capture status of a bookmark when another change is the one that waits', async () => {
    const bookmarked = makeItem({
      id: '101',
      title: 'First article',
      bookmarkedAt: STAMP,
      bookmarkCapture: capture('saved'),
    });
    const net = connection();
    await setOfflineEnabled(A, true);
    const { user } = renderReader(<ArticleDetail item={bookmarked} />, {
      routes: { ...detailRoute(bookmarked), ...accepting(bookmarked) },
    });
    await screen.findByText('Full text saved');
    net.lose();

    await user.click(screen.getByRole('button', { name: 'Like' }));

    expect(screen.getAllByText(WAITING)).toHaveLength(1);
    expect(screen.getByText('Full text saved')).toBeVisible();
  });
});
