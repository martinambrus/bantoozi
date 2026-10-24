import type { ArticleListItem, CardDto } from '@bantoozi/shared';
import { screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { failure, json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  findToast,
  makeItem,
  makeMe,
  makeDetail,
  setVisibility,
  restoreVisibility,
  renderReader,
  type ReaderHarnessOptions,
} from '../article/harness.js';
import { cardDraftRoutes, cardResult, makeCard } from '../interests/support.js';
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
  kind: 'card';
  cardId: string;
  lowered: boolean;
  offer: string[] | null;
  offerId: string | null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

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
    'GET /subscriptions': () => json(200, []),
    'GET /cards': () => json(200, [EV, SOLAR] satisfies CardDto[]),
    'POST /cards/:id/examples/batch': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
    'POST /cards/:id/examples': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
  } satisfies NonNullable<ReaderHarnessOptions['routes']>;
}

async function dislike(
  pattern: Pattern | null,
  suggestion = false,
  options: Pick<ReaderHarnessOptions, 'me'> = {},
) {
  holdExits();
  const item = makeItem();
  const app = renderReader(<Row item={item} />, {
    ...options,
    routes: server(item, pattern, suggestion),
  });
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
  kind: 'card',
  cardId: '31',
  lowered: true,
  offer: ['201', '202'],
  offerId: 'a0a00000-0000-4000-8000-000000000001',
};

describe('the dislike pattern in the undo toast', () => {
  it('T1 offers "Show fewer like these" after Undo, stays until closed, and sends the batch', async () => {
    const app = await dislike(OFFER);

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual([SHOW_FEWER, NOT_NOW]);
    expect(app.toasts.getSnapshot()).toHaveLength(2);
    expect(app.toasts.getSnapshot().find((t) => t.id === 'pattern-offer:card:31')).toMatchObject({
      durationMs: null,
    });

    await app.user.click(within(toast).getByRole('button', { name: SHOW_FEWER }));

    expect(await findToast('EV battery tech will show fewer like these.')).toHaveAttribute(
      'data-tone',
      'success',
    );
    const posted = app.calls('POST', '/cards/31/examples/batch');
    expect(posted).toHaveLength(1);
    expect(bodyOf(posted[0]!)).toEqual({ articleIds: ['201', '202'], side: 'no' });
    expect(app.calls('POST', '/articles/101/pattern-offer').map(bodyOf)).toContainEqual({
      offerId: OFFER.offerId,
      event: 'accepted',
    });
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

  it('D2 two quick same-scope offers replace in place and keep each rating undo', async () => {
    holdExits();
    const items = [makeItem(), makeItem({ id: '102' })];
    const app = renderReader(
      <>
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </>,
      {
        routes: {
          ...server(items[0]!, OFFER),
          'POST /articles/:id/rating': (_request, params) =>
            actionResponse(
              acked(
                items.find((item) => item.id === params['id'])!,
                { rating: -1, readAt: READ_AT },
              ),
              {
                exampleSuggestion: null,
                pattern: { ...OFFER, offerId: `a0a00000-0000-4000-8000-000000000${params['id']}` },
              },
            ),
        },
      },
    );
    apps.push(app);
    let firstOffer: HTMLElement | null = null;
    for (let i = 0; i < items.length; i++) {
      await app.user.click(screen.getAllByRole('button', { name: 'Dislike' })[i]!);
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      const button = await screen.findByRole('button', { name: SHOW_FEWER });
      const toast = button.closest<HTMLElement>('[data-toast-id]')!;
      expect(toast.dataset['toastId']).toBe('pattern-offer:card:31');
      if (firstOffer !== null) expect(toast).toBe(firstOffer);
      firstOffer = toast;
    }
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2);
    expect(app.toasts.getSnapshot().filter((t) => t.id.startsWith('reader-undo:'))).toHaveLength(2);
    await app.user.click(screen.getByRole('button', { name: NOT_NOW }));
    expect(app.calls('POST', '/articles/102/pattern-offer').map(bodyOf)).toContainEqual({
      offerId: 'a0a00000-0000-4000-8000-000000000102',
      event: 'dismissed',
    });
  });

  it.each(['on', 'off'] as const)(
    'DPF-8 opens Never with three examples (estimates %s)',
    async (estimates) => {
      holdExits();
      const item = makeItem();
      const me = makeMe();
      const ids = ['101', '201', '202'];
      const app = renderReader(<Row item={item} />, {
        me: { ...me, preferences: { ...me.preferences, estimates } },
        routes: {
          ...server(item, null),
          ...cardDraftRoutes(),
          'GET /topics': () => json(200, []),
          'GET /articles/:id': (_request, params) =>
            json(200, makeDetail(makeItem({ id: params['id']!, title: `Parts ${params['id']}` }))),
          'POST /articles/:id/rating': () =>
            actionResponse(acked(item, { rating: -1, readAt: READ_AT }), {
              exampleSuggestion: null,
              pattern: { kind: 'feed', feedId: '9', offer: ids, offerId: OFFER.offerId },
            }),
        },
      });
      apps.push(app);
      await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      const button = await screen.findByRole('button', { name: 'Make a Never card from these' });
      expect(
        screen.queryByText('Similar unread articles in this feed will be ranked lower.', {
          exact: false,
        }) !== null,
      ).toBe(estimates === 'on');
      await app.user.click(button);
      expect(app.calls('POST', '/articles/101/pattern-offer').map(bodyOf)).toContainEqual({
        offerId: OFFER.offerId,
        event: 'accepted',
      });
      const editor = await screen.findByRole('dialog', { name: 'New card from these articles' });
      expect(within(editor).getByRole('radio', { name: 'Never' })).toBeChecked();
      await waitFor(() =>
        expect(app.calls('POST', '/cards/drafts').map(bodyOf)).toEqual([
          { articleIds: ids, kind: 'never' },
        ]),
      );
    },
  );

  it.each([
    { missing: ['201'], expected: ['101', '202'] },
    { missing: ['101', '201', '202'], expected: [] },
  ])(
    'D4 opens Never with the surviving articles ($missing missing)',
    async ({ missing, expected }) => {
      holdExits();
      const item = makeItem();
      const app = renderReader(<Row item={item} />, {
        routes: {
          ...server(item, null),
          ...cardDraftRoutes(),
          'GET /topics': () => json(200, []),
          'GET /articles/:id': (_request, params) =>
            missing.includes(params['id']!)
              ? failure(404, 'NOT_FOUND')
              : json(200, makeDetail(makeItem({ id: params['id']! }))),
          'POST /articles/:id/rating': () =>
            actionResponse(acked(item, { rating: -1, readAt: READ_AT }), {
              exampleSuggestion: null,
              pattern: {
                kind: 'feed',
                feedId: '9',
                offer: ['101', '201', '202'],
                offerId: OFFER.offerId,
              },
            }),
        },
      });
      apps.push(app);
      await app.user.click(screen.getByRole('button', { name: 'Dislike' }));
      await app.user.click(screen.getByRole('button', { name: 'Off-topic' }));
      await app.user.click(
        await screen.findByRole('button', { name: 'Make a Never card from these' }),
      );
      if (expected.length > 0) {
        await screen.findByRole('dialog', { name: 'New card from these articles' });
        await waitFor(() =>
          expect(app.calls('POST', '/cards/drafts').map(bodyOf)).toEqual([
            { articleIds: expected, kind: 'never' },
          ]),
        );
        expect(app.toasts.getSnapshot().filter((t) => t.tone === 'error')).toHaveLength(0);
      } else {
        await waitFor(() =>
          expect(app.toasts.getSnapshot().filter((t) => t.tone === 'error')).toHaveLength(1),
        );
        expect(screen.queryByRole('dialog', { name: 'New card from these articles' })).toBeNull();
        expect(app.calls('POST', '/cards/drafts')).toHaveLength(0);
      }
    },
  );

  it('D6 offers teaching with similar demotion off and makes no ranking claim', async () => {
    const me = makeMe();
    const app = await dislike({ ...OFFER, lowered: false }, false, {
      me: {
        ...me,
        preferences: {
          ...me.preferences,
          demote: { ...me.preferences.demote, similar: 'off' },
        },
      },
    });
    expect(await screen.findByRole('button', { name: SHOW_FEWER })).toBeVisible();
    expect(screen.queryByText(LOWERED, { exact: false })).toBeNull();
    expect(app.toasts.getSnapshot().every((t) => t.message === DISLIKED)).toBe(true);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('T3 says the ranking was lowered, with only Undo, when there is no offer', async () => {
    const app = await dislike({
      kind: 'card',
      cardId: '31',
      lowered: true,
      offer: null,
      offerId: null,
    });

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo']);
    expect(app.calls('POST', '/cards/31/examples/batch')).toHaveLength(0);
  });

  it.each([
    ['no pattern', null],
    [
      'a pattern that lowered nothing',
      { kind: 'card' as const, cardId: '31', lowered: false, offer: null, offerId: null },
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

    expect(buttons(toast)).toEqual([SHOW_FEWER, NOT_NOW]);
    expect(within(toast).queryByRole('button', { name: SINGLE_TEACH })).toBeNull();
  });
});
