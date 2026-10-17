import type { ArticleListItem, CardDto } from '@bantoozi/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { json } from '../api/fake-fetch.js';
import {
  actionResponse,
  bodyOf,
  findToast,
  makeItem,
  renderReader,
  type ReaderHarnessOptions,
} from '../article/harness.js';
import { cardResult, makeCard } from '../interests/support.js';
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
}

const apps: { unhandled: string[] }[] = [];

afterEach(() => {
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
    'GET /cards': () => json(200, [EV, SOLAR] satisfies CardDto[]),
    'POST /cards/:id/examples/batch': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
    'POST /cards/:id/examples': () => json(200, cardResult(FORK, { from: '31', to: '35' })),
  } satisfies NonNullable<ReaderHarnessOptions['routes']>;
}

async function dislike(pattern: Pattern | null, suggestion = false) {
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

const OFFER: Pattern = { cardId: '31', lowered: true, offer: ['201', '202'] };

describe('the dislike pattern in the undo toast', () => {
  it('T1 offers "Show fewer like these" after Undo, for 8 seconds, and sends the batch', async () => {
    const app = await dislike(OFFER);

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo', SHOW_FEWER, NOT_NOW]);
    expect(app.toasts.getSnapshot()).toHaveLength(1);
    expect(app.toasts.getSnapshot()[0]).toMatchObject({ durationMs: 8000 });

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

  it('T3 says the ranking was lowered, with only Undo, when there is no offer', async () => {
    const app = await dislike({ cardId: '31', lowered: true, offer: null });

    const toast = await findToast(`${DISLIKED} ${LOWERED}`);

    expect(buttons(toast)).toEqual(['Undo']);
    expect(app.calls('POST', '/cards/31/examples/batch')).toHaveLength(0);
  });

  it.each([
    ['no pattern', null],
    ['a pattern that lowered nothing', { cardId: '31', lowered: false, offer: null }],
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
