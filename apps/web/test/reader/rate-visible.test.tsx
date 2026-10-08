import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { articleKeys } from '../../src/features/article/query-keys.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import { deferred, findToast } from '../article/harness.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { bodyOf } from '../support/app.js';
import { acked } from './actions/fake-transport.js';
import {
  AS_OF,
  countsQueries,
  createReaderHarness,
  item,
  listQueries,
  rowTitles,
  type ReaderOptions,
} from './support.js';
import { VERGE, likeOf, openMore, receipt, undoRoute, writeRoutes } from './surfaces.js';

const { open } = createReaderHarness();

const RATE_BULK = 'POST /articles/rate-bulk';
const UNDO = 'POST /articles/undo';
const REQUEST_ID = '8f14e45f-ceea-467a-a5c1-6f3c8d7e9a10';
const AI_WORDS = /\bAI\b|artificial|train|analy|classif|infer|learn|model/i;

const THREE = [item(1), item(2), item(3)];

type App = Awaited<ReturnType<typeof open>>['app'];

const feed = (rows: readonly ArticleListItem[] = THREE, extra: Partial<ReaderOptions> = {}) =>
  open({ path: '/read/feed/7', subscriptions: [VERGE], items: [...rows], ...extra });

const offered = () => screen.queryByRole('menuitem', { name: /^Rate (this|these)/ });

/** Opens the question from the More menu, once the menu offers to rate `count` articles. */
async function ask(app: App, count = 3) {
  await openMore(app, 'Verge');
  await app.user.click(
    await screen.findByRole('menuitem', { name: `Rate these ${count} visible articles` }),
  );
  return screen.findByRole('dialog', { name: `Rate these ${count} visible articles?` });
}

/** The ids the requests of `rate-bulk` carry, in order. */
const targetsOf = (app: App) =>
  (bodyOf(app.calls(RATE_BULK)[0]!) as { targets: { id: string }[] }).targets;

const numbered = (count: number) => Array.from({ length: count }, (_, index) => item(index + 1));

describe('the menu item', () => {
  it('is offered in a feed view and in no other view', async () => {
    const { app } = await feed();
    await openMore(app, 'Verge');
    expect(
      await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' }),
    ).toBeVisible();

    const others = [
      { to: '/read/$lane', params: { lane: 'for_you' }, title: 'For you' },
      { to: '/read/$lane', params: { lane: 'everything' }, title: 'Everything else' },
      { to: '/read/$lane', params: { lane: 'hidden' }, title: 'Hidden' },
      { to: '/read/$lane', params: { lane: 'bookmarks' }, title: 'Bookmarks' },
      { to: '/read/folder/$name', params: { name: 'News' }, title: 'News' },
      { to: '/read/label/$labelId', params: { labelId: '12' }, title: 'Label' },
    ] as const;
    for (const { to, params, title } of others) {
      await act(async () => {
        await app.router.navigate({ to, params } as never);
      });
      await screen.findByRole('article', { name: 'Article 1' });
      await openMore(app, title);
      expect(await screen.findByRole('menuitem', { name: 'Recent actions' })).toBeVisible();
      expect(offered()).toBeNull();
    }
  });

  it('is offered in the lanes of a feed too', async () => {
    const { app } = await open({
      path: '/read/feed/7?lane=maybe',
      subscriptions: [VERGE],
      items: THREE,
    });

    await openMore(app, 'Verge');

    expect(
      await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' }),
    ).toBeVisible();
  });

  it('counts the unread rows that are loaded, and not the read ones', async () => {
    const { app } = await feed([...THREE, item(4, { readAt: AS_OF }), item(5, { readAt: AS_OF })]);

    await openMore(app, 'Verge');

    expect(
      await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' }),
    ).toBeVisible();
  });

  it('says "this article" when there is one', async () => {
    const { app } = await feed([item(1)]);

    await openMore(app, 'Verge');

    expect(
      await screen.findByRole('menuitem', { name: 'Rate this visible article' }),
    ).toBeVisible();
  });

  it.each([true, false])(
    'counts only what the list still shows after the reader rated an article (mark read on rate: %s)',
    async (markReadOnRate) => {
      const { app } = await feed(THREE, {
        me: makeMe({ preferences: { markReadOnRate } }),
        routes: {
          'POST /articles/:id/rating': (request, params) => {
            const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
            return json(200, {
              item: acked(item(params['id'] ?? ''), {
                rating,
                ...(markReadOnRate ? { readAt: AS_OF } : {}),
              }),
              mutationId: receipt(1),
              exampleSuggestion: null,
            });
          },
        },
      });
      await screen.findByRole('article', { name: 'Article 3' });
      await app.user.click(likeOf('Article 1'));
      await waitFor(() => expect(rowTitles()).toEqual(['Article 2', 'Article 3']), {
        timeout: 3000,
      });

      await openMore(app, 'Verge');

      expect(
        await screen.findByRole('menuitem', { name: 'Rate these 2 visible articles' }),
      ).toBeVisible();
    },
  );

  it('counts at most the first 200 rows', async () => {
    const { app } = await feed(numbered(205));

    await openMore(app, 'Verge');

    expect(
      await screen.findByRole('menuitem', { name: 'Rate these 200 visible articles' }),
    ).toBeVisible();
  });

  it('has an accessible name, a 44 px target and a focus ring', async () => {
    const { app } = await feed();
    await openMore(app, 'Verge');

    const entry = await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' });

    expect(entry).toHaveAccessibleName();
    expect(entry).toHaveClass('min-h-11');
    expect(entry.className).toMatch(/focus-visible:outline/);
  });

  it('is disabled, and says why, when no unread article is loaded', async () => {
    const { app } = await feed([item(1, { readAt: AS_OF })]);
    await screen.findByRole('article', { name: 'Article 1' });

    await openMore(app, 'Verge');

    const entry = await screen.findByRole('menuitem', { name: /^Rate these visible articles/ });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry).toHaveTextContent('No unread articles are loaded in this view.');
    expect(entry).toHaveAccessibleName(
      'Rate these visible articles No unread articles are loaded in this view.',
    );
    await app.user.click(entry);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.calls(RATE_BULK)).toHaveLength(0);
  });
});

describe('the question', () => {
  it('gives the exact number and what is rated, and offers Like all, Dislike all and Cancel', async () => {
    const { app } = await feed([...THREE, item(4, { readAt: AS_OF })]);

    const dialog = await ask(app);

    expect(
      within(dialog).getByText(
        /^Your rating will be saved for the 3 unread articles that are listed in “Verge” right now\./,
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/Articles that haven't been loaded are not included\.$/),
    ).toBeVisible();
    for (const name of ['Like all', 'Dislike all', 'Cancel']) {
      const button = within(dialog).getByRole('button', { name });
      expect(button).toBeEnabled();
      expect(button).toHaveClass('min-h-11');
      expect(button.className).toMatch(/focus-visible:outline/);
    }
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(app.calls(RATE_BULK)).toHaveLength(0);
  });

  it('never says or suggests that the AI is turned on, that the feed is trained or that more is rated', async () => {
    const { app } = await feed();
    await openMore(app, 'Verge');
    const menuItem = await screen.findByRole('menuitem', { name: 'Rate these 3 visible articles' });
    const menuText = menuItem.textContent ?? '';
    await app.user.click(menuItem);

    const dialog = await screen.findByRole('dialog', { name: 'Rate these 3 visible articles?' });

    expect(menuText).toBe('Rate these 3 visible articles');
    const said = [menuText, dialog.textContent ?? ''].join(' ');
    expect(said).not.toMatch(AI_WORDS);
    expect(said).not.toMatch(/whole|entire|every/i);
    expect(said).toMatch(/not included/);
  });

  it('keeps the articles it was opened with, whatever the list does meanwhile', async () => {
    const writes = writeRoutes();
    const { app, state } = await feed(THREE, { routes: writes.routes });
    const dialog = await ask(app);

    state.items = [...THREE, item(4), item(5)];
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: articleKeys.all(USER_A_ID) });
    });
    await waitFor(() => expect(listQueries(app)).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByRole('article', { hidden: true })).toHaveLength(5));

    expect(dialog).toHaveAccessibleName('Rate these 3 visible articles?');
    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    await waitFor(() => expect(app.calls(RATE_BULK)).toHaveLength(1));
    expect(targetsOf(app).map((target) => target.id)).toEqual(['1', '2', '3']);
  });

  it('says that only the first 200 are rated when the list shows more, and sends only those', async () => {
    const writes = writeRoutes();
    const { app } = await feed(numbered(205), { routes: writes.routes });

    const dialog = await ask(app, 200);

    expect(
      within(dialog).getByText('The list shows 205 unread articles. Only the first 200 are rated.'),
    ).toBeVisible();
    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));
    await waitFor(() => expect(app.calls(RATE_BULK)).toHaveLength(1));
    expect(targetsOf(app).map((target) => target.id)).toEqual(numbered(200).map((row) => row.id));
  });

  it('sends nothing on Cancel and gives the focus back to the More button', async () => {
    const { app } = await feed();
    const more = within(await screen.findByRole('group', { name: 'Verge' })).getByRole('button', {
      name: 'More',
    });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(RATE_BULK)).toHaveLength(0);
    expect(more).toHaveFocus();
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
  });

  it('closes on Escape without sending anything', async () => {
    const { app } = await feed();
    await ask(app);

    await app.user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(RATE_BULK)).toHaveLength(0);
  });
});

describe('Like all and Dislike all', () => {
  it('send one request with exactly the articles of the question, the rating and no analysis request', async () => {
    const writes = writeRoutes();
    const rows = [
      item(1),
      item(2, { analysis: { mode: 'training', status: 'complete', requestId: REQUEST_ID } }),
      item(3, { stateVersion: '9', contentRevision: '5' }),
    ];
    const { app } = await feed(rows, { routes: writes.routes });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    await waitFor(() => expect(app.calls(RATE_BULK)).toHaveLength(1));
    const [request] = app.calls(RATE_BULK);
    expect(request!.pathname).toBe('/api/v1/articles/rate-bulk');
    expect(bodyOf(request!)).toEqual({
      targets: [
        { id: '1', stateVersion: '4', contentRevision: '2' },
        { id: '2', stateVersion: '4', contentRevision: '2' },
        { id: '3', stateVersion: '9', contentRevision: '5' },
      ],
      rating: 1,
    });
    expect(request!.body).not.toMatch(/analysisRequestId/);
    expect(request!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(RATE_BULK)).toHaveLength(1);
    expect(app.calls('POST /articles/:id/rating')).toHaveLength(0);
  });

  it('send the rating -1 for Dislike all', async () => {
    const writes = writeRoutes();
    const { app } = await feed(THREE, { routes: writes.routes });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Dislike all' }));

    await waitFor(() => expect(app.calls(RATE_BULK)).toHaveLength(1));
    expect(bodyOf(app.calls(RATE_BULK)[0]!)).toMatchObject({ rating: -1 });
    expect(targetsOf(app).map((target) => target.id)).toEqual(['1', '2', '3']);
    await findToast('Rated 3 articles');
  });

  it('take the rated articles out of the list and load the counts again', async () => {
    const writes = writeRoutes();
    const { app } = await feed(THREE, { routes: writes.routes });
    const dialog = await ask(app);
    const counted = countsQueries(app).length;

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    await findToast('Rated 3 articles');
    await waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(counted));
    await waitFor(() => expect(rowTitles()).toEqual([]), { timeout: 3000 });
    await openMore(app, 'Verge');
    expect(
      await screen.findByRole('menuitem', { name: /^Rate these visible articles/ }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('load the unread numbers of the feeds again', async () => {
    const writes = writeRoutes();
    const { app } = await feed(THREE, { routes: writes.routes });
    const dialog = await ask(app);
    const asked = app.calls('GET /subscriptions').length;

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    await findToast('Rated 3 articles');
    await waitFor(() => expect(app.calls('GET /subscriptions').length).toBeGreaterThan(asked));
  });

  it('say how many were rated in a toast that stays for 5 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writes = writeRoutes();
    const { app } = await feed(THREE, { routes: writes.routes });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    const toast = await findToast('Rated 3 articles');
    expect(toast).toHaveAttribute('data-tone', 'success');
    expect(within(toast).getByRole('button', { name: 'Undo' })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(screen.getByText('Rated 3 articles')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText('Rated 3 articles')).toBeNull();
  });

  it('count what the server rated, in the singular too', async () => {
    const { app } = await feed(THREE, {
      routes: {
        [RATE_BULK]: () =>
          json(200, {
            count: 1,
            mutationId: receipt(1),
            items: [acked(item(1), { rating: 1, readAt: AS_OF })],
          }),
      },
    });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    await findToast('Rated 1 article');
  });

  it('are undone by the receipt from the toast', async () => {
    const writes = writeRoutes();
    const { app } = await feed(THREE, { routes: { ...writes.routes, ...undoRoute() } });
    const dialog = await ask(app);
    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));
    const toast = await findToast('Rated 3 articles');
    await waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(1));
    const counted = countsQueries(app).length;

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(app.calls(UNDO)).toHaveLength(1));
    expect(bodyOf(app.calls(UNDO)[0]!)).toEqual({ mutationId: writes.issued[0] });
    expect(app.calls(UNDO)[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(countsQueries(app).length).toBeGreaterThan(counted));
  });

  it('are busy while the request is out: nothing else can be pressed and Escape does not close', async () => {
    const answer = deferred<Response>();
    const { app } = await feed(THREE, { routes: { [RATE_BULK]: () => answer.promise } });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));
    await waitFor(() => expect(app.calls(RATE_BULK)).toHaveLength(1));

    for (const name of ['Like all', 'Dislike all', 'Cancel']) {
      expect(within(dialog).getByRole('button', { name })).toBeDisabled();
    }
    await app.user.click(within(dialog).getByRole('button', { name: 'Dislike all' }));
    await app.user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Rate these 3 visible articles?' })).toBeVisible();
    expect(app.calls(RATE_BULK)).toHaveLength(1);

    answer.resolve(
      json(200, {
        count: 3,
        mutationId: receipt(1),
        items: THREE.map((row) => acked(row, { rating: 1, readAt: AS_OF })),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await findToast('Rated 3 articles');
  });
});

describe('when the request does not go through', () => {
  it('says why in words, keeps the question open and lets the reader try again', async () => {
    let attempts = 0;
    const { app } = await feed(THREE, {
      routes: {
        [RATE_BULK]: () => {
          attempts += 1;
          return attempts === 1
            ? failure(403, 'FORBIDDEN')
            : json(200, {
                count: 3,
                mutationId: receipt(2),
                items: THREE.map((row) => acked(row, { rating: -1, readAt: AS_OF })),
              });
        },
      },
    });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Dislike all' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "You don't have permission to do that.",
    );
    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    for (const name of ['Like all', 'Dislike all', 'Cancel']) {
      expect(within(dialog).getByRole('button', { name })).toBeEnabled();
    }
    await app.user.click(within(dialog).getByRole('button', { name: 'Dislike all' }));
    await findToast('Rated 3 articles');
    expect(app.calls(RATE_BULK)).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the question and says so when an article changed on another device', async () => {
    const { app } = await feed(THREE, {
      routes: {
        [RATE_BULK]: () =>
          failure(409, 'STALE_STATE', { items: [acked(item(1), { readAt: AS_OF })] }),
      },
    });
    const dialog = await ask(app);

    await app.user.click(within(dialog).getByRole('button', { name: 'Like all' }));

    expect(
      await findToast("This changed on another device, so your change wasn't applied."),
    ).toHaveAttribute('data-tone', 'info');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.calls(RATE_BULK)).toHaveLength(1);
    expect(screen.queryByText(/^Rated \d+ articles?$/)).toBeNull();
  });
});

describe('in Slovak', () => {
  it.each([
    [1, 'Ohodnotiť tento viditeľný článok'],
    [2, 'Ohodnotiť tieto 2 viditeľné články'],
    [4, 'Ohodnotiť tieto 4 viditeľné články'],
    [5, 'Ohodnotiť týchto 5 viditeľných článkov'],
  ])('puts %i articles in the right plural', async (count, label) => {
    const { app } = await feed(numbered(count), { me: makeMe({ locale: 'sk' }) });

    await openMore(app, 'Verge', 'Viac');
    await app.user.click(await screen.findByRole('menuitem', { name: label }));

    const dialog = await screen.findByRole('dialog', { name: `${label}?` });
    expect(
      within(dialog).getByRole('button', { name: 'Označiť všetky ako „páči sa mi“' }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Označiť všetky ako „nepáči sa mi“' }),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Zrušiť' })).toBeVisible();
    expect(dialog.textContent).toContain('„Verge“');
    expect(dialog.textContent ?? '').not.toMatch(/umelej|inteligenci|trénuj|učen|analyz|model/i);
  });

  it('says why there is nothing to rate', async () => {
    const { app } = await feed([], { me: makeMe({ locale: 'sk' }) });

    await openMore(app, 'Verge', 'Viac');

    const entry = await screen.findByRole('menuitem', { name: /^Ohodnotiť viditeľné články/ });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry).toHaveTextContent('V tomto zozname nie sú načítané žiadne neprečítané články.');
  });
});
