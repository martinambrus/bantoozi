import type { ArticleListItem } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { actionResponse, findToast, makeItem, renderReader } from '../article/harness.js';
import { acked } from './actions/fake-transport.js';

const READ_AT = '2026-05-31T10:00:00.000Z';
const LIKED = 'Marked as liked';
const DISLIKED = 'Marked as disliked';
const LOWERED = 'Similar articles will be ranked lower.';

const apps: { unhandled: string[] }[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function Row({ item }: { item: ArticleListItem }) {
  return <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />;
}

describe('rating toasts', () => {
  it('a like and a later dislike each keep their own toast on screen', async () => {
    const liked = makeItem({ id: '101' });
    const disliked = makeItem({ id: '102', title: 'Old Skoda 100 for sale' });
    let call = 0;
    const app = renderReader(
      <>
        <Row item={liked} />
        <Row item={disliked} />
      </>,
      {
        routes: {
          'POST /articles/:id/rating': () => {
            call += 1;
            return call === 1
              ? actionResponse(acked(liked, { rating: 1, readAt: READ_AT }), {
                  exampleSuggestion: null,
                  pattern: null,
                })
              : actionResponse(acked(disliked, { rating: -1, readAt: READ_AT }), {
                  exampleSuggestion: null,
                  pattern: {
                    kind: 'card',
                    cardId: '31',
                    lowered: true,
                    offer: null,
                    offerId: null,
                  },
                });
          },
        },
      },
    );
    apps.push(app);

    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[0]!);
    await findToast(LIKED);
    await app.user.click(screen.getAllByRole('button', { name: 'Dislike' })[1]!);
    await app.user.click(
      within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
        name: 'Off-topic',
      }),
    );

    await findToast(`${DISLIKED} ${LOWERED}`);
    expect(await findToast(LIKED)).toBeTruthy();
    expect(app.toasts.getSnapshot()).toHaveLength(2);
  });
});
