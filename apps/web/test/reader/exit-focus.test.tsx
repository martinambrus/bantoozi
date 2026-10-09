import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { json } from '../api/fake-fetch.js';
import { findToast } from '../article/harness.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { AS_OF, createReaderHarness, item, rowTitles } from './support.js';
import { likeOf, receipt } from './surfaces.js';

const { open } = createReaderHarness();

const titleOf = (name: string) => screen.getByRole('button', { name });

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Writes that each move the article on to a newer state, as the API does; the Undo restores article 1. */
function newerEachTime(): Record<string, ApiRouteHandler> {
  let version = 4n;
  let issued = 0;
  const next = () => String((version += 1n));
  return {
    'POST /articles/:id/rating': (request, params) => {
      const { rating } = bodyOf(request) as { rating: 1 | -1 | null };
      const written = item(params['id'] ?? '', { rating, readAt: AS_OF, stateVersion: next() });
      return json(200, {
        item: written,
        mutationId: receipt((issued += 1)),
        exampleSuggestion: null,
      });
    },
    'POST /articles/undo': () =>
      json(200, {
        count: 1,
        mutationId: receipt(900),
        items: [item(1, { stateVersion: next() })],
      }),
  };
}

describe('a row that comes back after its rating was undone', () => {
  it('leaves again the way it first left, and hands the focus to the next row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({
      path: '/read/for_you',
      items: [item(1), item(2), item(3)],
      routes: newerEachTime(),
    });
    await screen.findByRole('article', { name: 'Article 3' });
    likeOf('Article 1').focus();
    fireEvent.click(likeOf('Article 1'));
    await pass(600);
    expect(rowTitles()).toEqual(['Article 2', 'Article 3']);
    expect(titleOf('Article 2')).toHaveFocus();
    const toast = await findToast('Marked as liked');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']));

    likeOf('Article 1').focus();
    fireEvent.click(likeOf('Article 1'));
    await pass(300);

    expect(rowTitles()).toEqual(['Article 1', 'Article 2', 'Article 3']);
    await pass(300);
    expect(rowTitles()).toEqual(['Article 2', 'Article 3']);
    expect(titleOf('Article 2')).toHaveFocus();
  });
});

describe('the only row of a list', () => {
  it('hands the focus to the main landmark when it leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open({ path: '/read/for_you', items: [item(1)] });
    await screen.findByRole('article', { name: 'Article 1' });
    likeOf('Article 1').focus();

    fireEvent.click(likeOf('Article 1'));
    await pass(600);

    expect(rowTitles()).toEqual([]);
    expect(screen.getByRole('main')).toHaveFocus();
  });
});
