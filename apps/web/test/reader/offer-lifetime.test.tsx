import type { ArticleListItem, CardDto } from '@bantoozi/shared';
import { act, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { failure, json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  deferred,
  findToast,
  makeItem,
  renderReader,
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

describe('delayed rating offers', () => {
  it.each(['not-held', 'unreadable', 'changed'] as const)(
    'keeps the lowered sentence in the plain toast when the offer is %s',
    async (scenario) => {
      const item = makeItem();
      const cards = deferred<Response>();
      const app = renderReader(<Row item={item} />, {
        routes: {
          'GET /cards': () => cards.promise,
          'GET /subscriptions': () => json(200, []),
          'POST /articles/:id/rating': (request) => {
            const rating = (bodyOf(request) as { rating: 1 | -1 }).rating;
            return actionResponse(
              acked(item, {
                rating,
                reason: rating === -1 ? 'off_topic' : null,
                readAt: READ_AT,
                stateVersion: rating === -1 ? '5' : '6',
              }),
              { pattern: rating === -1 ? pattern : null, exampleSuggestion: null },
            );
          },
        },
      });
      await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await waitFor(() => expect(app.calls('GET', '/cards')).toHaveLength(1));
      const id = app.toasts.getSnapshot()[0]!.id;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      if (scenario === 'changed') {
        await app.user.click(screen.getByRole('button', { name: 'Like' }));
        await findToast('Marked as liked');
      }
      await act(async () => {
        cards.resolve(
          scenario === 'unreadable'
            ? failure(403, 'FORBIDDEN')
            : json(200, scenario === 'not-held' ? [] : [CARD]),
        );
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(app.toasts.getSnapshot().find((toast) => toast.id === id)?.message).toBe(
        'Marked as disliked Similar articles will be ranked lower.',
      );
      expect(screen.queryByRole('button', { name: 'Show fewer like these' })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3001);
      });
      expect(app.toasts.getSnapshot().some((toast) => toast.id === id)).toBe(false);
      expect(app.unhandled).toEqual([]);
    },
  );

  it.each(['pattern', 'suggestion'] as const)(
    'keeps the plain undo when a delayed %s loses to a newer rating',
    async (kind) => {
      const first = makeItem();
      const second = makeItem({ id: '102' });
      const cards = deferred<Response>();
      const app = renderReader(
        <>
          <Row item={first} />
          <Row item={second} />
        </>,
        {
          routes: {
            'GET /cards': () => cards.promise,
            'GET /subscriptions': () => json(200, []),
            'POST /articles/:id/rating': (_request, params) =>
              actionResponse(
                acked(params['id'] === '101' ? first : second, {
                  rating: params['id'] === '101' ? -1 : 1,
                  readAt: READ_AT,
                }),
                {
                  pattern: params['id'] === '101' && kind === 'pattern' ? pattern : null,
                  exampleSuggestion:
                    params['id'] === '101' && kind === 'suggestion'
                      ? { cardId: '31', side: 'no' }
                      : null,
                },
              ),
          },
        },
      );
      await app.user.click(screen.getAllByRole('button', { name: 'Dislike' })[0]!);
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await waitFor(() => expect(app.calls('GET', '/cards')).toHaveLength(1));
      await app.user.click(screen.getAllByRole('button', { name: 'Like' })[1]!);
      await findToast('Marked as liked');
      await act(async () => {
        cards.resolve(json(200, [CARD] satisfies CardDto[]));
      });
      const plain = await findToast(
        kind === 'pattern'
          ? 'Marked as disliked Similar articles will be ranked lower.'
          : 'Marked as disliked',
      );
      expect(within(plain).getByRole('button', { name: 'Undo' })).toBeVisible();
      expect(
        screen.queryByRole('button', {
          name: kind === 'pattern' ? 'Show fewer like these' : 'Teach EV battery tech: not this',
        }),
      ).toBeNull();
      expect(app.unhandled).toEqual([]);
    },
  );
});
