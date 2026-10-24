import type { ArticleListItem, CardDto } from '@bantoozi/shared';
import { screen, within, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  findToast,
  makeItem,
  setVisibility,
  restoreVisibility,
  renderReader,
  type ReaderHarnessOptions,
} from '../article/harness.js';
import { cardResult, makeCard } from '../interests/support.js';
import { holdExits } from './exit-hold.js';
import { acked } from './actions/fake-transport.js';

const READ_AT = '2026-05-31T10:00:00.000Z';
const EV = makeCard({ id: '31', title: 'EV battery tech', strength: 'love' });
const SOLAR = makeCard({ id: '32', title: 'Solar power', strength: 'like' });
const FORK = makeCard({
  id: '35',
  title: 'EV battery tech',
  strength: 'love',
  origin: 'fork',
  isPrivateFork: true,
});

const DISLIKED = 'Marked as disliked';
const LOWERED = 'Similar articles will be ranked lower.';
const SHOW_FEWER = 'Show fewer like these';
const NOT_NOW = 'Not now';
const SINGLE_TEACH = 'Teach EV battery tech: not this';

interface Pattern {
  cardId: string;
  lowered: boolean;
  offer: string[] | null;
  offerId: string | null;
}

const apps: { unhandled: string[] }[] = [];

afterEach(() => {
  restoreVisibility();
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function Row({ item }: { item: ArticleListItem }) {
  return <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />;
}

function server(item: ArticleListItem, pattern: Pattern | null, suggestion = false) {
  return {
    'POST /articles/:id/rating': () =>
      actionResponse(acked(item, { rating: -1, readAt: READ_AT }), {
        exampleSuggestion: suggestion ? { cardId: '31', side: 'no' } : null,
        pattern,
      }),
    'POST /articles/:id/pattern-offer': () => json(204, null),
    'GET /cards': () => json(200, [EV, SOLAR] satisfies CardDto[]),
    'POST /cards/:id/examples/batch': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
    'POST /cards/:id/examples': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
  } satisfies NonNullable<ReaderHarnessOptions['routes']>;
}

async function dislike(pattern: Pattern | null, suggestion = false) {
  holdExits();
  const item = makeItem();
  const app = renderReader(<Row item={item} />, { routes: server(item, pattern, suggestion) });
  apps.push(app);
  await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
  await app.user.click(
    within(screen.getByRole('group', { name: 'Reason for the dislike' })).getByRole('button', {
      name: 'Off-topic',
    }),
  );
  return app;
}

const buttons = (toast: HTMLElement) =>
  within(toast)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    .filter((name) => name !== 'Dismiss');

const OFFER: Pattern = {
  cardId: '31',
  lowered: true,
  offer: ['201', '202'],
  offerId: 'a0a00000-0000-4000-8000-000000000001',
};

describe('the dislike pattern in the undo toast', () => {
  it('T1 offers "Show fewer like these" after Undo, stays until closed, and sends the batch', async () => {
    const app = await dislike(OFFER);

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo', SHOW_FEWER, NOT_NOW]);
    expect(app.toasts.getSnapshot()).toHaveLength(1);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: null });

    await app.user.click(within(toast).getByRole('button', { name: SHOW_FEWER }));

    expect(await findToast('EV battery tech will show fewer like these.')).toHaveAttribute(
      'data-tone',
      'success',
    );
    const posted = app.calls('POST', '/cards/31/examples/batch');
    expect(posted).toHaveLength(1);
    expect(bodyOf(posted[0]!)).toEqual({ articleIds: ['201', '202'], side: 'no' });
  });

  it('T2 "Not now" closes the toast and sends nothing', async () => {
    const app = await dislike(OFFER);
    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    await app.user.click(within(toast).getByRole('button', { name: NOT_NOW }));

    expect(screen.queryByText(`${DISLIKED} ${LOWERED}`)).toBeNull();
    expect(app.calls('POST', '/cards/31/examples/batch')).toHaveLength(0);
    expect(app.calls('POST', '/cards/31/examples')).toHaveLength(0);
  });

  it('DPF-6 acknowledges visibility after one second, then the answer', async () => {
    const app = await dislike(OFFER);
    await findToast(`${DISLIKED} ${LOWERED}`);
    expect(app.calls('POST', '/articles/101/pattern-offer')).toHaveLength(0);
    await waitFor(() => expect(app.calls('POST', '/articles/101/pattern-offer')).toHaveLength(1), {
      timeout: 1800,
    });
    expect(bodyOf(app.calls('POST', '/articles/101/pattern-offer')[0]!)).toEqual({
      offerId: OFFER.offerId,
      event: 'seen',
    });
    await app.user.click(screen.getByRole('button', { name: NOT_NOW }));
    await waitFor(() => expect(app.calls('POST', '/articles/101/pattern-offer')).toHaveLength(2));
    expect(bodyOf(app.calls('POST', '/articles/101/pattern-offer')[1]!)).toEqual({
      offerId: OFFER.offerId,
      event: 'dismissed',
    });
  });

  it('DPF-6 hidden time does not count and closing before one second records no seen event', async () => {
    setVisibility('hidden');
    const app = await dislike(OFFER);
    const toast = await findToast(`${DISLIKED} ${LOWERED}`);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(app.calls('POST', '/articles/101/pattern-offer')).toHaveLength(0);
    setVisibility('visible');
    await app.user.click(within(toast).getByRole('button', { name: NOT_NOW }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(app.calls('POST', '/articles/101/pattern-offer').map(bodyOf)).toEqual([
      { offerId: OFFER.offerId, event: 'dismissed' },
    ]);
  });

  it('DPF-7 a later rating keeps the sticky offer visible and its undo separate', async () => {
    holdExits();
    const first = makeItem();
    const second = makeItem({ id: '102' });
    const legacyOffer = OFFER;
    const app = renderReader(
      <>
        <Row item={first} />
        <Row item={second} />
      </>,
      {
        routes: {
          ...server(first, legacyOffer),
          'POST /articles/:id/rating': (_request, params) =>
            params['id'] === first.id
              ? actionResponse(acked(first, { rating: -1, readAt: READ_AT }), {
                  exampleSuggestion: null,
                  pattern: legacyOffer,
                })
              : actionResponse(acked(second, { rating: 1, readAt: READ_AT }), {
                  exampleSuggestion: null,
                  pattern: null,
                }),
        },
      },
    );
    apps.push(app);
    await app.user.click(screen.getAllByRole('button', { name: 'Dislike' })[0]!);
    await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
    const offer = await findToast(`${DISLIKED} ${LOWERED}`);
    await app.user.click(screen.getAllByRole('button', { name: 'Like' })[1]!);
    const later = await findToast('Marked as liked');
    expect(offer).toBeVisible();
    expect(within(offer).getByRole('button', { name: SHOW_FEWER })).toBeVisible();
    expect(offer.dataset['toastId']).not.toBe(later.dataset['toastId']);
    expect(
      app.toasts.getSnapshot().find((t) => t.id === offer.dataset['toastId'])?.durationMs,
    ).toBeNull();
    await app.user.click(within(offer).getByRole('button', { name: NOT_NOW }));
    expect(later).toBeVisible();
  });

  it('T3 says the ranking was lowered, with only Undo, when there is no offer', async () => {
    const app = await dislike({ cardId: '31', lowered: true, offer: null, offerId: null });

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo']);
    expect(app.calls('POST', '/cards/31/examples/batch')).toHaveLength(0);
  });

  it.each([
    ['no pattern', null],
    [
      'a pattern that lowered nothing',
      { cardId: '31', lowered: false, offer: null, offerId: null },
    ],
  ])("T4 keeps today's toast for %s", async (_name, pattern) => {
    const app = await dislike(pattern);

    const toast = await findToast(DISLIKED);

    expect(buttons(toast)).toEqual(['Undo']);
    expect(screen.queryByText(LOWERED, { exact: false })).toBeNull();
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ message: DISLIKED });
  });

  it('T5 shows no single "Teach … not this" action while the offer is shown', async () => {
    await dislike(OFFER, true);

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo', SHOW_FEWER, NOT_NOW]);
    expect(within(toast).queryByRole('button', { name: SINGLE_TEACH })).toBeNull();
  });
});
