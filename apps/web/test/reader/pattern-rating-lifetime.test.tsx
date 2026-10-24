import type { ArticleListItem } from '@bantoozi/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useReaderActions } from '../../src/features/reader/actions/provider.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { failure, json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  deferred,
  makeItem,
  renderReader,
  undoResponse,
} from '../article/harness.js';
import { makeCard } from '../interests/support.js';
import { acked } from './actions/fake-transport.js';
import { holdExits } from './exit-hold.js';

const CARD = makeCard({ id: '31', title: 'EV battery tech', strength: 'love' });
const READ_AT = '2026-05-31T10:00:00.000Z';
const pattern = {
  kind: 'card' as const,
  cardId: '31',
  lowered: true,
  offer: ['101', '201', '202'],
  offerId: 'a0a00000-0000-4000-8000-000000000001',
};
function Row({ item }: { item: ArticleListItem }) {
  return <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  holdExits();
});

describe('an offer bound to its rating', () => {
  it.each(['success', 'failure'] as const)(
    'keeps the offer until a pending rating change settles with %s',
    async (outcome) => {
      const item = makeItem();
      const pending = deferred<Response>();
      let requests = 0;
      const disliked = acked(item, { rating: -1, reason: 'off_topic', readAt: READ_AT });
      const app = renderReader(<Row item={item} />, {
        routes: {
          'GET /cards': () => json(200, [CARD]),
          'GET /subscriptions': () => json(200, []),
          'POST /articles/:id/rating': () =>
            ++requests === 1
              ? actionResponse(disliked, { pattern, exampleSuggestion: null })
              : pending.promise,
          'POST /articles/:id/pattern-offer': () => new Response(null, { status: 204 }),
        },
      });
      await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await screen.findByRole('button', { name: 'Show fewer like these' });
      await app.user.click(screen.getByRole('button', { name: 'Like' }));
      await waitFor(() => expect(requests).toBe(2));
      expect(screen.getByRole('button', { name: 'Show fewer like these' })).toBeVisible();
      await act(async () => {
        pending.resolve(
          outcome === 'success'
            ? actionResponse(acked(disliked, { rating: 1, reason: null }), {
                pattern: null,
                exampleSuggestion: null,
              })
            : failure(403, 'FORBIDDEN'),
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      if (outcome === 'success') {
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Show fewer like these' })).toBeNull(),
        );
      } else {
        await waitFor(() =>
          expect(app.toasts.getSnapshot().some((toast) => toast.tone === 'error')).toBe(true),
        );
        expect(screen.getByRole('button', { name: 'Show fewer like these' })).toBeVisible();
      }
      expect(app.unhandled).toEqual([]);
    },
  );

  it('keeps a sticky offer after the undo window expires and unrelated store activity occurs', async () => {
    const item = makeItem();
    const unrelated = makeItem({ id: '102' });
    function Activity() {
      const store = useReaderActions();
      return (
        <button
          onClick={() => {
            expect(store.recent()).toHaveLength(0);
            store.observe([{ ...unrelated, stateVersion: '2', readAt: READ_AT }]);
          }}
        >
          Unrelated activity
        </button>
      );
    }
    const app = renderReader(
      <>
        <Row item={item} />
        <Activity />
      </>,
      {
        routes: {
          'GET /cards': () => json(200, [CARD]),
          'GET /subscriptions': () => json(200, []),
          'POST /articles/:id/rating': () =>
            actionResponse(acked(item, { rating: -1, reason: 'off_topic', readAt: READ_AT }), {
              pattern,
              exampleSuggestion: null,
            }),
          'POST /articles/:id/pattern-offer': () => new Response(null, { status: 204 }),
        },
      },
    );
    await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
    await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
    await screen.findByRole('button', { name: 'Show fewer like these' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    });
    await app.user.click(screen.getByRole('button', { name: 'Unrelated activity' }));
    expect(screen.getByRole('button', { name: 'Show fewer like these' })).toBeVisible();
    expect(app.unhandled).toEqual([]);
  });

  it.each(['Like', 'Dislike'])(
    'dismisses the sticky offer when the row uses %s to change or remove its rating',
    async (button) => {
      const item = makeItem();
      let version = BigInt(item.stateVersion);
      const app = renderReader(<Row item={item} />, {
        routes: {
          'GET /cards': () => json(200, [CARD]),
          'GET /subscriptions': () => json(200, []),
          'POST /articles/:id/rating': (request) => {
            const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
            return actionResponse(
              acked(item, {
                rating,
                reason: rating === -1 ? 'off_topic' : null,
                readAt: READ_AT,
                stateVersion: String(++version),
              }),
              { pattern: rating === -1 ? pattern : null, exampleSuggestion: null },
            );
          },
          'POST /articles/:id/pattern-offer': () => new Response(null, { status: 204 }),
        },
      });
      await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await screen.findByRole('button', { name: 'Show fewer like these' });
      await app.user.click(screen.getByRole('button', { name: button }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Show fewer like these' })).toBeNull(),
      );
      expect(app.unhandled).toEqual([]);
    },
  );
});

const offerKinds = [
  { kind: 'card', label: 'Show fewer like these', pattern, exampleSuggestion: null },
  {
    kind: 'feed',
    label: 'Make a Never card from these',
    pattern: { kind: 'feed', feedId: '7', offer: pattern.offer, offerId: pattern.offerId },
    exampleSuggestion: null,
  },
  {
    kind: 'suggestion',
    label: 'Teach EV battery tech: not this',
    pattern: null,
    exampleSuggestion: { cardId: '31', side: 'no' },
  },
];

describe.each(offerKinds)('$kind offer dismissal', (offered) => {
  function setup() {
    const item = makeItem();
    let version = BigInt(item.stateVersion);
    function BatchChange() {
      const store = useReaderActions();
      return (
        <button
          onClick={() =>
            store.dispatch(item, { type: 'rate', rating: 1 }, { ratingBatchId: 'change-batch' })
          }
        >
          Change in batch
        </button>
      );
    }
    const app = renderReader(
      <>
        <Row item={item} />
        <BatchChange />
      </>,
      {
        routes: {
          'GET /cards': () => json(200, [CARD]),
          'GET /subscriptions': () => json(200, []),
          'POST /articles/:id/rating': (request) => {
            const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
            return actionResponse(
              acked(item, {
                rating,
                reason: rating === -1 ? 'off_topic' : null,
                readAt: READ_AT,
                stateVersion: String(++version),
              }),
              rating === -1
                ? { pattern: offered.pattern, exampleSuggestion: offered.exampleSuggestion }
                : { pattern: null, exampleSuggestion: null },
            );
          },
          'POST /articles/undo': () =>
            undoResponse(acked(item, { stateVersion: String(++version) })),
          'POST /articles/:id/pattern-offer': () => new Response(null, { status: 204 }),
        },
      },
    );
    return app;
  }

  async function showOffer(app: ReturnType<typeof setup>) {
    await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
    await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
    await screen.findByRole('button', { name: offered.label });
  }

  it.each(['button', 'keyboard'] as const)('dismisses on Undo using the %s', async (input) => {
    const app = setup();
    await showOffer(app);
    const undo = screen.getByRole('button', { name: 'Undo' });
    if (input === 'button') await app.user.click(undo);
    else {
      act(() => undo.focus());
      await app.user.keyboard('{Enter}');
    }
    await waitFor(() => expect(app.calls('POST', '/articles/undo')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: offered.label })).toBeNull());
    expect(app.unhandled).toEqual([]);
  });

  it.each(['Like', 'Dislike', 'Change in batch'])(
    'dismisses after %s changes or removes the rating',
    async (button) => {
      const app = setup();
      await showOffer(app);
      await app.user.click(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(screen.queryByRole('button', { name: offered.label })).toBeNull());
      expect(app.calls('POST', '/articles/101/rating')).toHaveLength(2);
      expect(app.unhandled).toEqual([]);
    },
  );
});
