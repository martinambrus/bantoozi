import type { ArticleListItem, CardDto } from '@bantoozi/shared';
import { act, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { json } from '../api/fake-fetch.js';
import { actionResponse, deferred, findToast, makeItem, renderReader } from '../article/harness.js';
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
      const plain = await findToast('Marked as disliked');
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
