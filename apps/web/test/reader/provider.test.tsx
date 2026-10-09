import type { ArticleListItem, Me } from '@bantoozi/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import {
  useObserveItems,
  useReaderActions,
  useReaderItem,
  useUndoAction,
} from '../../src/features/reader/actions/provider.js';
import type { ReaderActions } from '../../src/features/reader/actions/types.js';
import { failure, json, noContent } from '../api/fake-fetch.js';
import {
  MUTATION_ID,
  actionResponse,
  bodyOf,
  deferred,
  findToast,
  makeItem,
  makeMe,
  ratingResponse,
  renderReader,
  undoResponse,
} from '../article/harness.js';
import { probe } from '../article/reader-probe.js';
import { runResetHooks, type ResetReason } from '../../src/session/reset.js';
import { renderApp, type ApiRouteHandler } from '../support/app.js';
import { acked } from './actions/fake-transport.js';

// The reader page belongs to another task; the probe page renders article rows in its place.
vi.mock('../../src/features/reader/reader-page.js', async () => {
  const { ProbePage } = await import('../article/reader-probe.js');
  return { ReaderPage: ProbePage };
});

const COUNTS = {
  forYou: 3,
  maybe: 1,
  everything: 0,
  new: 2,
  bookmarks: 0,
  hidden: 0,
  scored: 4,
  total: 6,
  asOf: '2026-05-31T10:00:00.000Z',
  datasetVersion: 'd1',
  rankingPending: false,
};

const READ_AT = '2026-05-31T10:00:00.000Z';
const TITLE = 'Solid-state batteries reach the pilot line';

async function openReader(
  options: { item?: ArticleListItem; me?: Me; routes?: Record<string, ApiRouteHandler> } = {},
) {
  const item = options.item ?? makeItem();
  probe.items = [item];
  probe.store = null;
  const app = await renderApp({
    path: '/read/for_you',
    server: {
      me: options.me ?? makeMe(),
      routes: { 'GET /articles/counts': () => json(200, COUNTS), ...options.routes },
    },
  });
  await screen.findByRole('article', { name: TITLE });
  return app;
}

beforeEach(() => {
  // jsdom has no scrolling; the router's scroll restoration would log "not implemented".
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

const like = () => screen.getByRole('button', { name: 'Like' });
const dislike = () => screen.getByRole('button', { name: 'Dislike' });
const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed') === 'true';

describe('reader actions in the signed-in app', () => {
  it('shows a rating at once and sends it with the fence of the row', async () => {
    const item = makeItem();
    const answer = deferred<Response>();
    const app = await openReader({
      item,
      routes: { 'POST /articles/:id/rating': () => answer.promise },
    });

    await app.user.click(like());

    expect(pressed(like())).toBe(true);
    expect(app.calls('POST /articles/:id/rating')).toHaveLength(1);
    expect(bodyOf(app.calls('POST /articles/:id/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
    });

    answer.resolve(ratingResponse(acked(item, { rating: 1, readAt: READ_AT })));
    await findToast('Marked as liked');
    expect(pressed(like())).toBe(true);
    expect(app.unhandled).toEqual([]);
  });

  it('rolls a rating the server refused back, says so, and resends it from the toast', async () => {
    const item = makeItem();
    let attempts = 0;
    const app = await openReader({
      item,
      routes: {
        'POST /articles/:id/rating': () => {
          attempts += 1;
          return attempts === 1
            ? failure(400, 'VALIDATION_FAILED')
            : ratingResponse(acked(item, { rating: 1, readAt: READ_AT }));
        },
      },
    });

    await app.user.click(like());
    const failed = await findToast("Couldn't save — retry");
    expect(pressed(like())).toBe(false);
    expect(screen.getByText('Unread')).toBeInTheDocument();

    await app.user.click(within(failed).getByRole('button', { name: 'Retry' }));
    await findToast('Marked as liked');

    const [first, second] = app.calls('POST /articles/:id/rating');
    expect(second!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'));
    expect(second!.body).toBe(first!.body);
    expect(pressed(like())).toBe(true);
    expect(screen.queryByText("Couldn't save — retry")).toBeNull();
  });

  it('rolls a rating back once the server has failed it three times (503), says so, and resends it from the toast', async () => {
    const item = makeItem();
    let attempts = 0;
    const app = await openReader({
      item,
      routes: {
        'POST /articles/:id/rating': () => {
          attempts += 1;
          return attempts <= 3
            ? failure(503, 'ENGINE_UNAVAILABLE')
            : ratingResponse(acked(item, { rating: 1, readAt: READ_AT }));
        },
      },
    });

    await app.user.click(like());
    expect(pressed(like())).toBe(true);
    const failed = await findToast("Couldn't save — retry");
    expect(app.calls('POST /articles/:id/rating')).toHaveLength(3);
    expect(pressed(like())).toBe(false);
    expect(screen.getByText('Unread')).toBeInTheDocument();

    await app.user.click(within(failed).getByRole('button', { name: 'Retry' }));
    await findToast('Marked as liked');

    const sent = app.calls('POST /articles/:id/rating');
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((call) => call.headers.get('Idempotency-Key'))).size).toBe(1);
    expect(pressed(like())).toBe(true);
  });

  it('adopts the server state and says so when the article changed on another device', async () => {
    const other = makeItem({ rating: -1, stateVersion: '7' });
    const app = await openReader({
      routes: { 'POST /articles/:id/rating': () => failure(409, 'STALE_STATE', { item: other }) },
    });

    await app.user.click(like());

    await findToast("This changed on another device, so your change wasn't applied.");
    expect(pressed(like())).toBe(false);
    expect(pressed(dislike())).toBe(true);
  });

  it('undoes an acknowledged rating with the receipt and restores the earlier rating', async () => {
    const before = makeItem({ rating: -1 });
    const liked = acked(before, { rating: 1, readAt: READ_AT });
    const app = await openReader({
      item: before,
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(liked),
        'POST /articles/undo': () => undoResponse(acked(liked, { rating: -1 })),
      },
    });
    expect(pressed(dislike())).toBe(true);

    await app.user.click(like());
    const toast = await findToast('Marked as liked');
    expect(pressed(like())).toBe(true);
    expect(pressed(dislike())).toBe(false);

    await app.user.click(within(toast).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(pressed(dislike())).toBe(true));
    expect(pressed(like())).toBe(false);
    expect(app.calls('POST /articles/undo')).toHaveLength(1);
    expect(bodyOf(app.calls('POST /articles/undo')[0]!)).toEqual({ mutationId: MUTATION_ID });
  });

  it('keeps newer changes and says so when the server cannot undo', async () => {
    const before = makeItem({ rating: -1 });
    const liked = acked(before, { rating: 1, readAt: READ_AT });
    const elsewhere = { ...liked, rating: null, stateVersion: '9' } satisfies ArticleListItem;
    const app = await openReader({
      item: before,
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(liked),
        'POST /articles/undo': () => failure(409, 'STALE_STATE', { items: [elsewhere] }),
      },
    });

    await app.user.click(like());
    await app.user.click(
      within(await findToast('Marked as liked')).getByRole('button', { name: 'Undo' }),
    );

    await findToast('Newer changes were kept.');
    expect(pressed(like())).toBe(false);
    expect(pressed(dislike())).toBe(false);
  });

  it('says so when the server refuses the undo', async () => {
    const before = makeItem();
    const liked = acked(before, { rating: 1, readAt: READ_AT });
    const app = await openReader({
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(liked),
        'POST /articles/undo': () => failure(409, 'CONFLICT', { reason: 'expired' }),
      },
    });

    await app.user.click(like());
    await app.user.click(
      within(await findToast('Marked as liked')).getByRole('button', { name: 'Undo' }),
    );

    await findToast('This can no longer be undone.');
    expect(pressed(like())).toBe(true);
  });

  it('reloads the counts once an action is acknowledged, not when it fails', async () => {
    const item = makeItem();
    let accept = false;
    const app = await openReader({
      item,
      routes: {
        'POST /articles/:id/rating': () =>
          accept ? ratingResponse(acked(item, { rating: 1 })) : failure(400, 'VALIDATION_FAILED'),
      },
    });
    await waitFor(() => expect(screen.getByTestId('total')).toHaveTextContent('6'));
    expect(app.calls('GET /articles/counts')).toHaveLength(1);

    await app.user.click(like());
    await findToast("Couldn't save — retry");
    expect(app.calls('GET /articles/counts')).toHaveLength(1);

    accept = true;
    await app.user.click(
      within(await findToast("Couldn't save — retry")).getByRole('button', { name: 'Retry' }),
    );
    await findToast('Marked as liked');
    await waitFor(() => expect(app.calls('GET /articles/counts')).toHaveLength(2));
  });

  it('forgets every pending change and cancels its request when the account signs out', async () => {
    const item = makeItem();
    const answer = deferred<Response>();
    const app = await openReader({
      item,
      routes: {
        'POST /articles/:id/rating': () => answer.promise,
        'POST /auth/logout': () => noContent(),
      },
    });
    const store = probe.store!;
    await app.user.click(like());
    const [request] = app.calls('POST /articles/:id/rating');
    expect(store.view(item)).not.toBe(item);
    const version = store.getVersion();

    await act(async () => {
      await app.session.logout();
    });

    expect(request!.signal?.aborted).toBe(true);
    expect(store.getVersion()).toBeGreaterThan(version);
    expect(store.view(item)).toBe(item);
    expect(store.recent()).toEqual([]);
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText("Couldn't save — retry")).toBeNull();
  });
});

describe('reader actions provider', () => {
  function Capture({ into }: { into: ReaderActions[] }) {
    into.push(useReaderActions());
    return null;
  }

  it('gives every consumer of an account the same store', () => {
    const stores: ReaderActions[] = [];
    renderReader(
      <>
        <Capture into={stores} />
        <Capture into={stores} />
      </>,
    );
    expect(new Set(stores).size).toBe(1);
  });

  it('creates a store per account and drops the previous one', () => {
    const stores: ReaderActions[] = [];
    const view = renderReader(<Capture into={stores} />);
    const first = stores.at(-1)!;
    const version = first.getVersion();

    view.switchAccount('0192f7a0-0000-7000-8000-00000000000b');

    const second = stores.at(-1)!;
    expect(second).not.toBe(first);
    expect(first.getVersion()).toBeGreaterThan(version);
  });

  it('stops everything when it is unmounted', () => {
    const stores: ReaderActions[] = [];
    const view = renderReader(<Capture into={stores} />);
    const store = stores.at(-1)!;
    const version = store.getVersion();

    view.unmount();

    expect(store.getVersion()).toBeGreaterThan(version);
  });

  it.each(['logout', 'account_switch', 'unauthorized', 'remote'] as const satisfies ResetReason[])(
    'forgets what is pending on an account reset (%s) while it stays mounted',
    async (reason) => {
      const stores: ReaderActions[] = [];
      const item = makeItem();
      renderReader(<Capture into={stores} />, {
        routes: { 'POST /articles/:id/rating': () => deferred<Response>().promise },
      });
      const store = stores.at(-1)!;
      store.dispatch(item, { type: 'rate', rating: 1 });
      expect(store.view(item)).not.toBe(item);

      await act(async () => {
        await runResetHooks(reason);
      });

      expect(store.view(item)).toBe(item);
    },
  );

  it('shows the newest observed state of an article to every row of it', () => {
    const stale = makeItem();
    const newer = makeItem({ rating: -1, stateVersion: '9' });
    function Rows() {
      useObserveItems([newer]);
      return <Shown item={stale} />;
    }
    function Shown({ item }: { item: ArticleListItem }) {
      const shown = useReaderItem(item);
      return <p>{`rating ${shown.rating ?? 'none'} v${shown.stateVersion}`}</p>;
    }
    renderReader(<Rows />);
    expect(screen.getByText('rating -1 v9')).toBeInTheDocument();
  });

  it('returns the item itself while nothing is known about it', () => {
    const item = makeItem();
    const seen: ArticleListItem[] = [];
    function Shown() {
      seen.push(useReaderItem(item));
      return null;
    }
    renderReader(<Shown />);
    expect(seen.at(-1)).toBe(item);
  });
});

describe('the undo other surfaces offer', () => {
  function UndoLatest() {
    const store = useReaderActions();
    const undo = useUndoAction();
    return (
      <button type="button" onClick={() => void undo(store.recent()[0]!.id)}>
        Undo the latest
      </button>
    );
  }

  it.each([
    [
      'refuses it',
      () => failure(409, 'CONFLICT', { reason: 'expired' }),
      'This can no longer be undone.',
    ],
    [
      'kept newer changes',
      () => failure(409, 'STALE_STATE', { items: [] }),
      'Newer changes were kept.',
    ],
  ] as const)(
    'sends the receipt and says so when the server %s',
    async (_case, answer, message) => {
      const item = makeItem();
      const app = renderReader(
        <>
          <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />
          <UndoLatest />
        </>,
        {
          routes: {
            'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: 1 })),
            'POST /articles/undo': answer,
          },
        },
      );
      await app.user.click(like());
      await findToast('Marked as liked');

      await app.user.click(screen.getByRole('button', { name: 'Undo the latest' }));

      expect(await findToast(message)).toBeInTheDocument();
      expect(app.calls('POST', '/articles/undo')).toHaveLength(1);
      expect(bodyOf(app.calls('POST', '/articles/undo')[0]!)).toEqual({ mutationId: MUTATION_ID });
    },
  );
});

describe('reader action toasts', () => {
  function Row({ item }: { item: ArticleListItem }) {
    return <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />;
  }

  it('offers an undo for 5 seconds after a rating', async () => {
    const item = makeItem();
    const { user, toasts } = renderReader(<Row item={item} />, {
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: 1 })),
      },
    });
    await user.click(like());
    await findToast('Marked as liked');

    const [toast, ...rest] = toasts.getSnapshot();
    expect(rest).toEqual([]);
    expect(toast).toMatchObject({
      message: 'Marked as liked',
      tone: 'success',
      durationMs: 5000,
      action: { label: 'Undo' },
    });
  });

  it.each([
    ['disliked', -1, 'Marked as disliked'],
    ['un-rated', null, 'Rating removed'],
  ] as const)('says what a rating that %s did', async (_name, rating, message) => {
    const item = makeItem({ rating: rating === null ? 1 : null });
    const { user } = renderReader(<Row item={item} />, {
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating })),
      },
    });
    await user.click(rating === null ? like() : dislike());
    if (rating !== null) await user.click(screen.getByRole('button', { name: 'Other' }));
    expect(await findToast(message)).toBeInTheDocument();
  });

  it('offers the undo of the latest rating only', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const { user, toasts } = renderReader(
      <>
        <Row item={first} />
        <Row item={second} />
      </>,
      {
        routes: {
          'POST /articles/101/rating': () => ratingResponse(acked(first, { rating: 1 })),
          'POST /articles/102/rating': () => ratingResponse(acked(second, { rating: -1 })),
        },
      },
    );

    await user.click(screen.getAllByRole('button', { name: 'Like' })[0]!);
    await findToast('Marked as liked');
    await user.click(screen.getAllByRole('button', { name: 'Dislike' })[1]!);
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await findToast('Marked as disliked');

    expect(toasts.getSnapshot().map((toast) => toast.message)).toEqual(['Marked as disliked']);
  });

  it('offers no undo for an action that changed nothing', async () => {
    const item = makeItem();
    const { user, toasts, calls } = renderReader(<Row item={item} />, {
      routes: { 'POST /articles/:id/rating': () => ratingResponse({ ...item, rating: 1 }) },
    });
    await user.click(like());
    await waitFor(() => expect(calls('POST', '/articles/101/rating')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(toasts.getSnapshot()).toEqual([]);
  });

  it('offers no undo toast for a bookmark', async () => {
    const item = makeItem();
    const { user, toasts, calls } = renderReader(<Row item={item} />, {
      routes: {
        'POST /articles/:id/bookmark': () => actionResponse(acked(item, { bookmarkedAt: READ_AT })),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(calls('POST', '/articles/101/bookmark')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(toasts.getSnapshot()).toEqual([]);
  });

  it('keeps a failed save on screen with a retry', async () => {
    const item = makeItem();
    const { user, toasts } = renderReader(<Row item={item} />, {
      routes: { 'POST /articles/:id/rating': () => failure(400, 'VALIDATION_FAILED') },
    });
    await user.click(like());
    await findToast("Couldn't save — retry");
    expect(toasts.getSnapshot()).toMatchObject([{ tone: 'error', action: { label: 'Retry' } }]);
  });

  it.each([
    [{ type: 'open' }, 'POST /articles/:id/open'],
    [{ type: 'dwell', ms: 1000 }, 'POST /articles/:id/dwell'],
  ] as const)('does not toast a failed %o', async (action, route) => {
    const item = makeItem();
    const stores: ReaderActions[] = [];
    function Capture() {
      stores.push(useReaderActions());
      return null;
    }
    const { toasts } = renderReader(<Capture />, {
      routes: { [route]: () => failure(400, 'VALIDATION_FAILED') },
    });
    const result = await stores.at(-1)!.dispatch(item, action).result;
    expect(result.status).toBe('failed');
    expect(toasts.getSnapshot()).toEqual([]);
  });
});
