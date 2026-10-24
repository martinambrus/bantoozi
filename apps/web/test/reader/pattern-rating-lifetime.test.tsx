import type { ArticleListItem } from '@bantoozi/shared';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { json } from '../api/fake-fetch.js';
import { actionResponse, bodyOf, makeItem, renderReader } from '../article/harness.js';
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
