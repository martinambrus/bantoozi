import type { ArticleDetail as ArticleDetailDto } from '@bantoozi/shared';
import { onlineManager } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { ArticleDetail } from '../../src/features/article/article-detail.js';
import { saveDetail, setOfflineEnabled } from '../../src/offline/cache.js';
import { failure, json } from '../api/fake-fetch.js';
import { makeDetail, makeItem, renderReader } from '../article/harness.js';
import { connection } from './saved-support.js';
import { A, freshIndexedDb } from './support.js';

freshIndexedDb();

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

const ITEM = makeItem();
const MESSAGE = 'Connect to load this article';
const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));

/** The detail of the article as the API sent it, kept by an account that chose offline reading. */
async function keep(overrides: Partial<ArticleDetailDto>, item = ITEM) {
  await setOfflineEnabled(A, true);
  await saveDetail(A, makeDetail(item, overrides));
}

describe('an opened article offline that was opened before', () => {
  it('shows its excerpt as it does online', async () => {
    await keep({ excerptHtml: '<p>The saved excerpt.</p>' });
    connection().lose();

    renderReader(<ArticleDetail item={ITEM} />, { routes: { 'GET /articles/:id': unreachable } });

    expect(await screen.findByText('The saved excerpt.')).toBeVisible();
    expect(screen.queryByText(MESSAGE)).toBeNull();
    expect(screen.queryByText("You're offline")).toBeNull();
    expect(screen.getByRole('button', { name: 'Like' })).toBeVisible();
  });

  it('shows the lead of the body when there is no excerpt', async () => {
    await keep({ excerptHtml: null, bodyLead: 'The saved lead.\n\nThe second paragraph.' });
    connection().lose();

    renderReader(<ArticleDetail item={ITEM} />, { routes: { 'GET /articles/:id': unreachable } });

    expect(await screen.findByText('The saved lead.')).toBeVisible();
    expect(screen.getByText('The second paragraph.')).toBeVisible();
  });

  it('offers the saved translation', async () => {
    await keep({
      translation: {
        title: 'English title',
        excerpt: 'English excerpt',
        engine: 'x',
        quality: 'ok',
      },
    });
    connection().lose();

    const { user } = renderReader(<ArticleDetail item={ITEM} />, {
      routes: { 'GET /articles/:id': unreachable },
    });
    await user.click(await screen.findByRole('button', { name: 'Show English translation' }));

    expect(screen.getByText('English title')).toBeVisible();
    expect(screen.getByText('English excerpt')).toBeVisible();
  });

  it('shows the saved copy of a bookmark in the Bookmarks view', async () => {
    const bookmarked = makeItem({ bookmarkedAt: '2026-10-07T09:00:00.000Z' });
    await keep(
      {
        bookmarkSnapshot: {
          id: '9',
          sourceUrl: 'https://example.test/articles/101',
          title: bookmarked.title,
          author: null,
          publishedAt: null,
          capturedAt: '2026-10-07T09:05:00.000Z',
          contentRevision: '2',
          completeness: 'complete',
          text: 'The text as it was saved.',
          html: null,
          mediaPolicyFeedId: null,
          effectiveImagesAllowed: false,
        },
      },
      bookmarked,
    );
    connection().lose();

    renderReader(<ArticleDetail item={bookmarked} saved />, {
      routes: { 'GET /articles/:id': unreachable },
    });

    expect(await screen.findByRole('heading', { name: 'Saved copy' })).toBeVisible();
    expect(screen.getByText('The text as it was saved.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Like' })).toBeVisible();
  });

  it('shows what was saved when the request fails although the browser says it is online', async () => {
    await keep({ excerptHtml: '<p>The saved excerpt.</p>' });
    const net = connection();
    net.blackhole();

    renderReader(<ArticleDetail item={ITEM} />, { routes: { 'GET /articles/:id': unreachable } });

    expect(await screen.findByText('The saved excerpt.')).toBeVisible();
  });

  it('follows the image setting of the feed it is opened from, not of the feed its copy came through', async () => {
    // Opened online through feed 5, which shows images.
    const throughFeed5 = makeItem({
      feed: { id: '5', title: 'Pictures Daily', iconUrl: null },
      mediaPolicyFeedId: '5',
      effectiveImagesAllowed: true,
    });
    await keep(
      {
        excerptHtml:
          '<p>The saved excerpt.</p><p><img src="https://images.example.test/chart.png" alt="A chart"></p>',
      },
      throughFeed5,
    );
    connection().lose();

    // Opened now from feed 7, which blocks them.
    const row = makeItem({ mediaPolicyFeedId: '7', effectiveImagesAllowed: false });
    renderReader(<ArticleDetail item={row} sourceFeedId="7" />, {
      routes: { 'GET /articles/:id': unreachable },
    });

    expect(await screen.findByText('The saved excerpt.')).toBeVisible();
    expect(screen.getByText('A chart')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText("Images from this feed aren't loaded.")).toBeVisible();
  });
});

describe('an opened article offline that was never opened', () => {
  it.each([
    ['en', MESSAGE],
    ['sk', 'Pripojte sa a načítajte tento článok'],
  ] as const)('says to connect, in %s, and never shows a spinner', async (language, message) => {
    await setOfflineEnabled(A, true);
    connection().lose();

    renderReader(<ArticleDetail item={ITEM} />, {
      language,
      routes: { 'GET /articles/:id': unreachable },
    });

    expect(screen.queryByRole('status', { name: /…$/ })).toBeNull();
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole('status', { name: /…$/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('says to connect when the account never chose offline reading', async () => {
    connection().lose();

    renderReader(<ArticleDetail item={ITEM} />, { routes: { 'GET /articles/:id': unreachable } });

    expect(await screen.findByText(MESSAGE)).toBeVisible();
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('says to connect when the request fails although the browser says it is online', async () => {
    await setOfflineEnabled(A, true);
    connection().blackhole();

    renderReader(<ArticleDetail item={ITEM} />, { routes: { 'GET /articles/:id': unreachable } });

    expect(await screen.findByText(MESSAGE)).toBeVisible();
  });

  it('loads the article when the connection is back', async () => {
    await setOfflineEnabled(A, true);
    const net = connection();
    net.lose();
    renderReader(<ArticleDetail item={ITEM} />, {
      routes: {
        'GET /articles/:id': () => (net.reaches() ? json(200, makeDetail(ITEM)) : unreachable()),
      },
    });
    await screen.findByText(MESSAGE);

    net.restore();

    expect(await screen.findByText('The excerpt of the article.')).toBeVisible();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('offers a Retry for a server that cannot be reached, without a spinner while it tries', async () => {
    await setOfflineEnabled(A, true);
    const net = connection();
    net.blackhole();
    const { user } = renderReader(<ArticleDetail item={ITEM} />, {
      routes: {
        'GET /articles/:id': () => (net.reaches() ? json(200, makeDetail(ITEM)) : unreachable()),
      },
    });
    await screen.findByText(MESSAGE);
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry.className).toContain('min-h-11');
    for (const token of FOCUS_RING.split(' ')) expect(retry.className).toContain(token);
    net.heal();

    await user.click(retry);

    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(await screen.findByText('The excerpt of the article.')).toBeVisible();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it('keeps the other failures as they were', async () => {
    renderReader(<ArticleDetail item={ITEM} />, {
      routes: {
        'GET /articles/:id': () => failure(500, 'INTERNAL'),
      },
    });

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });
});
