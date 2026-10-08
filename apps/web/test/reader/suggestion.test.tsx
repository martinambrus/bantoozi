import type { ArticleListItem, CardDto, Me } from '@bantoozi/shared';
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { cardCache, cardsKey } from '../../src/features/interests/queries.js';
import { useReaderActions } from '../../src/features/reader/actions/provider.js';
import { runResetHooks } from '../../src/session/reset.js';
import { UUID_V4, failure, json } from '../api/fake-fetch.js';
import {
  MUTATION_ID,
  actionResponse,
  bodyOf,
  deferred,
  findToast,
  makeItem,
  makeMe,
  renderReader,
  undoResponse,
  type ReaderHarnessOptions,
} from '../article/harness.js';
import { cardResult, makeCard } from '../interests/support.js';
import { USER_A_ID } from '../session/fixtures.js';
import { acked } from './actions/fake-transport.js';

const READ_AT = '2026-05-31T10:00:00.000Z';
const EV = makeCard({ id: '31', title: 'EV battery tech', strength: 'love' });
const SOLAR = makeCard({ id: '32', title: 'Solar power', strength: 'like' });
const CARDS = [EV, SOLAR];
const FORK = makeCard({
  id: '35',
  title: 'EV battery tech',
  strength: 'love',
  origin: 'fork',
  isPrivateFork: true,
});
interface Suggestion {
  cardId: string;
  side: 'yes' | 'no';
}
const YES: Suggestion = { cardId: '31', side: 'yes' };
const NO: Suggestion = { cardId: '31', side: 'no' };

const TEACH_YES = 'Teach EV battery tech: this is it';
const TEACH_NO = 'Teach EV battery tech: not this';
const STOP = 'Stop suggesting';
const OFF = 'Teaching suggestions are off. You can turn them back on in Settings.';

const apps: { unhandled: string[] }[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function Row({ item }: { item: ArticleListItem }) {
  return <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />;
}

/** The answer of the rating route: the item rated as `rating`, with `suggestion` if the server offers one. */
function rates(item: ArticleListItem, suggestion: Suggestion | null, rating: 1 | -1 = 1) {
  return () =>
    actionResponse(acked(item, { rating, readAt: READ_AT }), { exampleSuggestion: suggestion });
}

const cards = (list: readonly CardDto[] = CARDS) => ({ 'GET /cards': () => json(200, list) });
const teaches = {
  'POST /cards/:id/examples': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
};

function renderRow(
  item: ArticleListItem,
  routes: NonNullable<ReaderHarnessOptions['routes']>,
  options: Omit<ReaderHarnessOptions, 'routes'> = {},
) {
  const app = renderReader(<Row item={item} />, { ...options, routes });
  apps.push(app);
  return app;
}

function server(item: ArticleListItem, suggestion: Suggestion | null) {
  return { 'POST /articles/:id/rating': rates(item, suggestion), ...cards(), ...teaches };
}

const like = () => screen.getByRole('button', { name: 'Like' });
const names = (toast: HTMLElement) =>
  within(toast)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent);
const cachedIds = (app: { queryClient: QueryClient }) =>
  app.queryClient.getQueryData<CardDto[]>(cardsKey(USER_A_ID))?.map((card) => card.id);

async function rateAndFindToast(app: ReturnType<typeof renderRow>) {
  await app.user.click(like());
  return findToast('Marked as liked');
}

async function press(toast: HTMLElement, name: string, app: ReturnType<typeof renderRow>) {
  await app.user.click(within(toast).getByRole('button', { name }));
}

describe('the offer in the undo toast', () => {
  it('stays 8 seconds and adds Teach and Stop suggesting to Undo', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, YES));

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', TEACH_YES, STOP, 'Dismiss']);
    expect(app.toasts.getSnapshot()).toHaveLength(1);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({
      message: 'Marked as liked',
      durationMs: 8000,
    });
    expect(app.calls('GET', '/cards')).toHaveLength(1);
  });

  it('offers the side "not this" for a suggestion of side no, after a dislike with its reason', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, NO),
      'POST /articles/:id/rating': rates(item, NO, -1),
    });

    await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
    await app.user.click(
      within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
        name: 'Off-topic',
      }),
    );
    const toast = await findToast('Marked as disliked');

    expect(names(toast)).toEqual(['Undo', TEACH_NO, STOP, 'Dismiss']);
    expect(bodyOf(app.calls('POST', '/articles/101/rating')[0]!)).toMatchObject({
      rating: -1,
      reason: 'off_topic',
    });
  });

  it('leaves the screen after 8 seconds', async () => {
    vi.useFakeTimers();
    const item = makeItem();
    const app = renderRow(item, server(item, YES));
    app.queryClient.setQueryData(cardsKey(USER_A_ID), CARDS);

    fireEvent.click(like());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Marked as liked')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7990);
    });
    expect(screen.getByText('Marked as liked')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(screen.queryByText('Marked as liked')).toBeNull();
    expect(app.calls('GET', '/cards')).toHaveLength(0);
  });

  it('still undoes the rating by its receipt', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /articles/undo': () => undoResponse(item),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, 'Undo', app);

    await waitFor(() => expect(app.calls('POST', '/articles/undo')).toHaveLength(1));
    expect(bodyOf(app.calls('POST', '/articles/undo')[0]!)).toEqual({ mutationId: MUTATION_ID });
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(0);
  });

  it('does not change anything when it is ignored', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, YES));

    await rateAndFindToast(app);

    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(0);
    expect(app.calls('PATCH', '/me')).toHaveLength(0);
    expect(cachedIds(app)).toEqual(['31', '32']);
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Teach', () => {
  it('sends the article with side yes to the card, swaps the cached id and confirms', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, YES));
    const toast = await rateAndFindToast(app);
    expect(cachedIds(app)).toEqual(['31', '32']);

    await press(toast, TEACH_YES, app);

    expect(await findToast('Learned: this is EV battery tech')).toHaveAttribute(
      'data-tone',
      'success',
    );
    const posted = app.calls('POST', '/cards/31/examples');
    expect(posted).toHaveLength(1);
    expect(bodyOf(posted[0]!)).toEqual({ articleId: '101', side: 'yes' });
    expect(posted[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(cachedIds(app)).toEqual(['35', '32']);
    expect(screen.queryByText('Marked as liked')).toBeNull();
  });

  it('sends side no for a suggestion of side no and confirms it the way the drawer does', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, NO),
      'POST /articles/:id/rating': rates(item, NO, -1),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dislike' }));
    fireEvent.click(screen.getByRole('button', { name: 'Off-topic' }));
    const toast = await findToast('Marked as disliked');

    await press(toast, TEACH_NO, app);

    expect(await findToast("Learned: this isn't EV battery tech")).toBeInTheDocument();
    expect(bodyOf(app.calls('POST', '/cards/31/examples')[0]!)).toEqual({
      articleId: '101',
      side: 'no',
    });
  });

  it('confirms with the name the answer gives the card', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /cards/:id/examples': () =>
        json(200, cardResult({ ...FORK, title: 'My batteries' }, { from: '31', to: '35' })),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, TEACH_YES, app);

    expect(await findToast('Learned: this is My batteries')).toBeInTheDocument();
  });

  it('says the interest is gone for a 404 and has the cards read again', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /cards/:id/examples': () => failure(404, 'NOT_FOUND'),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, TEACH_YES, app);

    expect(
      await findToast("This interest is gone, so it can't learn from this article."),
    ).toHaveAttribute('data-tone', 'error');
    expect(app.queryClient.getQueryState(cardsKey(USER_A_ID))?.isInvalidated).toBe(true);
    expect(cachedIds(app)).toEqual(['31', '32']);
  });

  it('says the plan has no room for another private card, with the numbers', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /cards/:id/examples': () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxForks', used: 20, max: 20 }),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, TEACH_YES, app);

    expect(
      await findToast(
        "Teaching an interest needs a private copy of it, and you've reached your plan's limit of private cards: 20 of 20.",
      ),
    ).toHaveAttribute('data-tone', 'error');
    expect(cachedIds(app)).toEqual(['31', '32']);
  });

  it('says anything else in the words of every other screen', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /cards/:id/examples': () => failure(500, 'INTERNAL'),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, TEACH_YES, app);

    expect(await findToast('Something went wrong on our side. Try again.')).toHaveAttribute(
      'data-tone',
      'error',
    );
  });
});

describe('Stop suggesting', () => {
  const OFF_ME: Me = makeMe({ preferences: { exampleSuggestions: false } });

  it('saves the preference, caches the answer and confirms', async () => {
    const item = makeItem();
    const app = renderRow(item, { ...server(item, YES), 'PATCH /me': () => json(200, OFF_ME) });
    const toast = await rateAndFindToast(app);

    await press(toast, STOP, app);

    expect(await findToast(OFF)).toHaveAttribute('data-tone', 'success');
    const patched = app.calls('PATCH', '/me');
    expect(patched).toHaveLength(1);
    expect(bodyOf(patched[0]!)).toEqual({ preferences: { exampleSuggestions: false } });
    expect(patched[0]!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(app.queryClient.getQueryData(meKey())).toEqual(OFF_ME);
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(0);
  });

  it('is obeyed by the next rating', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const app = renderReader(
      <>
        <Row item={first} />
        <Row item={second} />
      </>,
      {
        routes: {
          'POST /articles/101/rating': rates(first, YES),
          'POST /articles/102/rating': rates(second, YES),
          ...cards(),
          'PATCH /me': () => json(200, OFF_ME),
        },
      },
    );
    apps.push(app);
    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[0]!);
    await press(await findToast('Marked as liked'), STOP, app);
    await findToast(OFF);

    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[1]!);
    const toast = await findToast('Marked as liked');

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
  });

  it('says so when the preference could not be saved, and keeps it as it was', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'PATCH /me': () => failure(500, 'INTERNAL'),
    });
    const toast = await rateAndFindToast(app);

    await press(toast, STOP, app);

    expect(await findToast('Something went wrong on our side. Try again.')).toHaveAttribute(
      'data-tone',
      'error',
    );
    expect(app.queryClient.getQueryData<Me>(meKey())?.preferences.exampleSuggestions).toBe(true);
  });
});

describe('when there is no offer', () => {
  function Replay({ item }: { item: ArticleListItem }) {
    const store = useReaderActions();
    return (
      <button
        type="button"
        onClick={() => {
          store.dispatch(item, { type: 'rate', rating: 1 }, { replayed: true });
        }}
      >
        Replay the rating
      </button>
    );
  }

  it('shows the plain undo toast for an answer to a replayed offline action', async () => {
    const item = makeItem();
    const app = renderReader(<Replay item={item} />, { routes: server(item, YES) });
    apps.push(app);

    fireEvent.click(screen.getByRole('button', { name: 'Replay the rating' }));
    const toast = await findToast('Marked as liked');

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
    expect(app.calls('GET', '/cards')).toHaveLength(0);
  });

  it('shows the plain undo toast when the preference is off, without reading the cards', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, YES), {
      me: makeMe({ preferences: { exampleSuggestions: false } }),
    });

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
    expect(app.calls('GET', '/cards')).toHaveLength(0);
  });

  it('shows the plain undo toast when the answer carries no suggestion, without reading the cards', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, null));

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
    expect(app.calls('GET', '/cards')).toHaveLength(0);
  });

  it('shows the plain undo toast when the card is not among the ones the person holds', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, { cardId: '99', side: 'yes' }));

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
    expect(app.calls('GET', '/cards')).toHaveLength(1);
  });

  it('shows the plain undo toast when the cards cannot be read', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'GET /cards': () => failure(500, 'INTERNAL'),
    });

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 5000 });
  });

  it('keeps an offer that arrives late from covering a newer toast', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const list = deferred<Response>();
    const app = renderReader(
      <>
        <Row item={first} />
        <Row item={second} />
      </>,
      {
        routes: {
          'POST /articles/101/rating': rates(first, YES),
          'POST /articles/102/rating': rates(second, null),
          'GET /cards': () => list.promise,
        },
      },
    );
    apps.push(app);
    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[0]!);
    await waitFor(() => expect(app.calls('GET', '/cards')).toHaveLength(1));
    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[1]!);
    await findToast('Marked as liked');

    list.resolve(json(200, CARDS));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const toast = await findToast('Marked as liked');
    expect(names(toast)).toEqual(['Undo', 'Dismiss']);
    expect(app.toasts.getSnapshot()).toHaveLength(1);
  });

  it('shows no offer that arrives after the account was reset', async () => {
    const item = makeItem();
    const list = deferred<Response>();
    const app = renderRow(item, { ...server(item, YES), 'GET /cards': () => list.promise });
    await app.user.click(like());
    await waitFor(() => expect(app.calls('GET', '/cards')).toHaveLength(1));

    await act(async () => {
      await runResetHooks('logout');
    });
    list.resolve(json(200, CARDS));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(app.toasts.getSnapshot()).toEqual([]);
  });
});

describe('a card that took the place of another', () => {
  const MINE = makeCard({ ...FORK, title: 'My batteries' });

  it('is offered under its new name and taught by its new id', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'POST /cards/:id/examples': () => json(200, cardResult(MINE, { from: '35', to: '36' })),
    });
    app.queryClient.setQueryData(cardsKey(USER_A_ID), CARDS);
    act(() => {
      cardCache(app.queryClient, USER_A_ID).apply({
        card: MINE,
        idChange: { from: '31', to: '35' },
      });
    });
    expect(cachedIds(app)).toEqual(['35', '32']);

    const toast = await rateAndFindToast(app);
    expect(names(toast)).toEqual(['Undo', 'Teach My batteries: this is it', STOP, 'Dismiss']);
    await press(toast, 'Teach My batteries: this is it', app);

    await findToast('Learned: this is My batteries');
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(0);
    expect(app.calls('POST', '/cards/35/examples')).toHaveLength(1);
    expect(app.calls('GET', '/cards')).toHaveLength(0);
  });

  it('is found in the list the server gives, when the move happened before it was read', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      ...server(item, YES),
      'GET /cards': () => json(200, [MINE, SOLAR]),
    });
    act(() => {
      cardCache(app.queryClient, USER_A_ID).apply({
        card: MINE,
        idChange: { from: '31', to: '35' },
      });
    });

    const toast = await rateAndFindToast(app);

    expect(names(toast)).toEqual(['Undo', 'Teach My batteries: this is it', STOP, 'Dismiss']);
  });

  it('is taught by the id the first teaching gave it, also when the server still names the old one', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const next = makeCard({ ...FORK, id: '36', title: 'EV battery tech' });
    const app = renderReader(
      <>
        <Row item={first} />
        <Row item={second} />
      </>,
      {
        routes: {
          'POST /articles/101/rating': rates(first, YES),
          'POST /articles/102/rating': rates(second, NO),
          ...cards(),
          'POST /cards/:id/examples': (_request, params) =>
            params['id'] === '31'
              ? json(200, cardResult(FORK, { from: '31', to: '35' }))
              : json(200, cardResult(next, { from: '35', to: '36' })),
        },
      },
    );
    apps.push(app);
    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[0]!);
    await press(await findToast('Marked as liked'), TEACH_YES, app);
    await findToast('Learned: this is EV battery tech');

    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[1]!);
    const toast = await findToast('Marked as liked');
    await press(toast, TEACH_NO, app);

    await waitFor(() => expect(app.calls('POST', '/cards/35/examples')).toHaveLength(1));
    expect(bodyOf(app.calls('POST', '/cards/35/examples')[0]!)).toEqual({
      articleId: '102',
      side: 'no',
    });
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(1);
    expect(cachedIds(app)).toEqual(['36', '32']);
  });
});

describe('the offer in Slovak', () => {
  it('speaks Slovak, to the confirmation', async () => {
    const item = makeItem();
    const app = renderRow(item, server(item, YES), { language: 'sk' });
    await app.user.click(screen.getByRole('button', { name: 'Páči sa mi' }));
    const toast = await findToast('Označené ako „páči sa mi“');

    expect(names(toast).slice(0, 3)).toEqual([
      'Vrátiť späť',
      'Naučiť „EV battery tech“: presne toto',
      'Prestať navrhovať',
    ]);
    await press(toast, 'Naučiť „EV battery tech“: presne toto', app);

    expect(await findToast('Zapamätané: toto je „EV battery tech“')).toBeInTheDocument();
  });

  it('confirms in Slovak that the suggestions are off', async () => {
    const item = makeItem();
    const app = renderRow(
      item,
      {
        ...server(item, YES),
        'PATCH /me': () => json(200, makeMe({ preferences: { exampleSuggestions: false } })),
      },
      { language: 'sk' },
    );
    await app.user.click(screen.getByRole('button', { name: 'Páči sa mi' }));
    const toast = await findToast('Označené ako „páči sa mi“');

    await press(toast, 'Prestať navrhovať', app);

    expect(
      await findToast('Navrhovanie učenia je vypnuté. Znova ho zapnete v Nastaveniach.'),
    ).toBeInTheDocument();
  });
});
