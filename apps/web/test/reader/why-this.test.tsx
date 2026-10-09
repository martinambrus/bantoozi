import type { ArticleListItem } from '@bantoozi/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { makeDetail } from '../article/harness.js';
import type { ApiRouteHandler } from '../support/app.js';
import { drawerRoutes, makeExplain } from '../why/support.js';
import { createReaderHarness, detailCalls, item } from './support.js';
import { VERGE } from './surfaces.js';

const { open } = createReaderHarness();

const CHIP = 'EV battery tech · 0.82, Why this?';
const ROWS = [item(1), item(2)];

/** What the drawer reads: the detail of the article asked for, the cards and the taxonomy. */
function drawerReads(rows: readonly ArticleListItem[] = ROWS): Record<string, ApiRouteHandler> {
  const reads = drawerRoutes();
  return {
    'GET /cards': reads['GET /cards']!,
    'GET /topics': reads['GET /topics']!,
    'GET /articles/:id': (_request, params) =>
      json(
        200,
        makeDetail(rows.find((row) => row.id === params['id']) ?? rows[0]!, {
          explain: makeExplain(),
        }),
      ),
  };
}

const chipOf = (title: string) =>
  within(screen.getByRole('article', { name: title })).getByRole('button', { name: CHIP });

const queryOf = (request: { query: URLSearchParams }) => Object.fromEntries(request.query);

describe('Why this? from a row', () => {
  it('opens the drawer for the article of the row whose reason chip was pressed', async () => {
    const { app } = await open({ path: '/read/for_you', items: ROWS, routes: drawerReads() });
    await screen.findByRole('article', { name: 'Article 2' });

    await app.user.click(chipOf('Article 2'));

    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    expect(drawer).toHaveAccessibleDescription('Article 2');
    expect(await within(drawer).findByRole('heading', { name: 'Your interests' })).toBeVisible();
    expect(detailCalls(app)).toHaveLength(1);
    expect(detailCalls(app)[0]!.pathname).toBe('/api/v1/articles/2');
    expect(queryOf(detailCalls(app)[0]!)).toEqual({});
  });

  it('opens one drawer at a time, each for the row it came from', async () => {
    const { app } = await open({ path: '/read/for_you', items: ROWS, routes: drawerReads() });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(chipOf('Article 1'));
    expect(await screen.findByRole('dialog', { name: 'Why this?' })).toHaveAccessibleDescription(
      'Article 1',
    );
    await app.user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await app.user.click(chipOf('Article 2'));

    expect(await screen.findByRole('dialog', { name: 'Why this?' })).toHaveAccessibleDescription(
      'Article 2',
    );
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('asks for the article as the feed view projects it', async () => {
    const { app } = await open({
      path: '/read/feed/7',
      items: ROWS,
      subscriptions: [VERGE],
      routes: drawerReads(),
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(chipOf('Article 1'));

    await screen.findByRole('dialog', { name: 'Why this?' });
    expect(detailCalls(app)).toHaveLength(1);
    expect(queryOf(detailCalls(app)[0]!)).toEqual({ sourceFeedId: '7' });
  });

  it('asks for the article through the feed a folder shows it from', async () => {
    const rows = [item(1, { feed: { id: '9', title: 'Tech Daily', iconUrl: null } })];
    const { app } = await open({
      path: '/read/folder/Tech',
      items: rows,
      routes: drawerReads(rows),
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(chipOf('Article 1'));

    await screen.findByRole('dialog', { name: 'Why this?' });
    expect(detailCalls(app)).toHaveLength(1);
    expect(queryOf(detailCalls(app)[0]!)).toEqual({ sourceFeedId: '9' });
  });

  it('asks for the saved copy from the Bookmarks view', async () => {
    const saved = [item(1, { bookmarkedAt: '2026-05-30T09:00:00.000Z' })];
    const { app } = await open({
      path: '/read/bookmarks',
      items: saved,
      routes: drawerReads(saved),
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(chipOf('Article 1'));

    await screen.findByRole('dialog', { name: 'Why this?' });
    expect(detailCalls(app)).toHaveLength(1);
    expect(queryOf(detailCalls(app)[0]!)).toEqual({ view: 'saved' });
  });

  it('opens from a row of the Hidden view, whose chip names the rule that hides the article', async () => {
    const hidden = [
      item(1, {
        lane: 'hidden',
        tier: null,
        pLike: null,
        topReason: { kind: 'rule', code: 'block_domain', ruleId: '12' },
      }),
    ];
    const { app } = await open({
      path: '/read/hidden',
      items: hidden,
      routes: drawerReads(hidden),
    });
    await screen.findByRole('article', { name: 'Article 1' });

    await app.user.click(
      within(screen.getByRole('article', { name: 'Article 1' })).getByRole('button', {
        name: 'Blocked website, Why this?',
      }),
    );

    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    expect(drawer).toHaveAccessibleDescription('Article 1');
    expect(await within(drawer).findByRole('heading', { name: 'Your interests' })).toBeVisible();
    expect(detailCalls(app)).toHaveLength(1);
    expect(queryOf(detailCalls(app)[0]!)).toEqual({});
  });

  it('gives the focus back to the chip when it closes', async () => {
    const { app } = await open({ path: '/read/for_you', items: ROWS, routes: drawerReads() });
    await screen.findByRole('article', { name: 'Article 2' });
    const chip = chipOf('Article 2');

    await app.user.click(chip);
    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    await app.user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(chip).toHaveFocus();
  });
});

describe('Why this? from the open article', () => {
  it('opens the drawer for the article of the pane, as the feed view projects it', async () => {
    const { app } = await open({
      path: '/read/feed/7',
      items: ROWS,
      subscriptions: [VERGE],
      routes: drawerReads(),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Article 2' }));
    const pane = await screen.findByRole('complementary', { name: 'Article' });

    await app.user.click(await within(pane).findByRole('button', { name: 'Why this?' }));

    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    expect(drawer).toHaveAccessibleDescription('Article 2');
    expect(await within(drawer).findByRole('heading', { name: 'Your interests' })).toBeVisible();
    expect(detailCalls(app).length).toBeGreaterThan(0);
    for (const request of detailCalls(app)) {
      expect(request.pathname).toBe('/api/v1/articles/2');
      expect(queryOf(request)).toEqual({ sourceFeedId: '7' });
    }
  });

  it('asks for the saved copy when the pane shows one', async () => {
    const saved = [item(1, { bookmarkedAt: '2026-05-30T09:00:00.000Z' })];
    const { app } = await open({
      path: '/read/bookmarks',
      items: saved,
      routes: drawerReads(saved),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Article 1' }));
    const pane = await screen.findByRole('complementary', { name: 'Article' });

    await app.user.click(await within(pane).findByRole('button', { name: 'Why this?' }));

    await screen.findByRole('dialog', { name: 'Why this?' });
    expect(detailCalls(app).length).toBeGreaterThan(0);
    for (const request of detailCalls(app)) expect(queryOf(request)).toEqual({ view: 'saved' });
  });

  it('gives the focus back to the button when it closes', async () => {
    const { app } = await open({ path: '/read/for_you', items: ROWS, routes: drawerReads() });
    await app.user.click(await screen.findByRole('button', { name: 'Article 1' }));
    const pane = await screen.findByRole('complementary', { name: 'Article' });
    const button = await within(pane).findByRole('button', { name: 'Why this?' });

    await app.user.click(button);
    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });
    await app.user.click(within(drawer).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
    expect(screen.getByRole('complementary', { name: 'Article' })).toBeVisible();
  });

  it('opens over the sheet of the article on a narrow screen and leaves that sheet open', async () => {
    const { app } = await open({
      path: '/read/for_you',
      items: ROWS,
      desktop: false,
      routes: drawerReads(),
    });
    await app.user.click(await screen.findByRole('button', { name: 'Article 1' }));
    const sheet = await screen.findByRole('dialog', { name: 'Article 1' });
    const button = await within(sheet).findByRole('button', { name: 'Why this?' });

    await app.user.click(button);
    const drawer = await screen.findByRole('dialog', { name: 'Why this?' });

    expect(drawer).toHaveAccessibleDescription('Article 1');
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await app.user.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Why this?' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Article 1' })).toBeVisible();
    expect(button).toHaveFocus();
  });
});
