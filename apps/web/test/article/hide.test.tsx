import type { ArticleListItem } from '@bantoozi/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArticleRow } from '../../src/features/article/article-row.js';
import { acked } from '../reader/actions/fake-transport.js';
import {
  actionResponse,
  bodyOf,
  makeItem,
  ratingResponse,
  renderReader,
  type ReaderHarnessOptions,
} from './harness.js';

const READ_AT = '2026-05-31T10:00:00.000Z';
const BAR = 'Reason for the dislike';
const FENCE = { stateVersion: '4', contentRevision: '2' };

const apps: { unhandled: string[] }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function renderRow(item: ArticleListItem = makeItem(), options: ReaderHarnessOptions = {}) {
  const app = renderReader(
    <ArticleRow item={item} expanded={false} onToggleExpand={() => {}} simple={false} />,
    {
      routes: {
        'POST /articles/:id/rating': () =>
          ratingResponse(acked(item, { rating: item.rating === 1 ? null : 1, readAt: READ_AT })),
      },
      ...options,
    },
  );
  apps.push(app);
  return app;
}

const like = () => screen.getByRole('button', { name: 'Like' });
const dislike = () => screen.getByRole('button', { name: 'Dislike' });
const bar = () => screen.queryByRole('group', { name: BAR });
const sent = (app: ReturnType<typeof renderRow>) => app.calls('POST', '/articles/101/rating');

function press(
  kind: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel',
  target: Element,
  init: PointerEventInit = {},
) {
  fireEvent[kind](target, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 100,
    clientY: 100,
    ...init,
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The thumb goes down on `target`, stays `ms`, and is lifted; the browser then clicks. */
async function hold(target: Element, ms: number, init: PointerEventInit = {}) {
  press('pointerDown', target, init);
  await advance(ms);
  press('pointerUp', target, init);
  fireEvent.click(target);
  await advance(0);
}

describe('hiding with Shift', () => {
  it('rates and hides with a Shift+click on the like', async () => {
    const app = renderRow();

    fireEvent.click(like(), { shiftKey: true });
    await advance(0);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1, hide: true });
  });

  it('does not hide with a plain click', async () => {
    const app = renderRow();

    fireEvent.click(like());
    await advance(0);

    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1 });
  });

  it('hides and takes the rating back with a Shift+click on a rating that is set', async () => {
    const item = makeItem({ rating: 1 });
    const app = renderRow(item);

    fireEvent.click(like(), { shiftKey: true });
    await advance(0);

    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: null, hide: true });
  });

  it('holds a Shift+dislike for the reason bar, then sends the hide with the reason', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      routes: { 'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: -1 })) },
    });

    fireEvent.click(dislike(), { shiftKey: true });
    await advance(0);
    expect(sent(app)).toHaveLength(0);
    expect(bar()).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Seen it' }));
    await advance(0);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: -1, hide: true, reason: 'seen' });
  });

  it('sends the hide of a Shift+dislike without a reason when the bar runs out', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      routes: { 'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: -1 })) },
    });

    fireEvent.click(dislike(), { shiftKey: true });
    await advance(5000);

    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: -1, hide: true });
  });
});

describe('hiding with a long press', () => {
  it.each(['touch', 'pen'])('rates and hides when a %s press is held for 500 ms', async (kind) => {
    const app = renderRow();

    await hold(like(), 500, { pointerType: kind });

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1, hide: true });
  });

  it.each([0, 400, 499])('rates only, without hiding, when the press is %s ms', async (ms) => {
    const app = renderRow();

    await hold(like(), ms);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1 });
  });

  it('rates once, not a second time by the click that follows the press', async () => {
    const app = renderRow();

    await hold(like(), 800);
    await advance(10_000);

    expect(sent(app)).toHaveLength(1);
  });

  it('does not take a long press with a mouse for a hide', async () => {
    const app = renderRow();

    await hold(like(), 800, { pointerType: 'mouse' });

    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1 });
  });

  it('does not hide when the thumb moved off while it was held', async () => {
    const app = renderRow();
    press('pointerDown', like());
    await advance(300);
    press('pointerMove', like(), { clientX: 130 });
    await advance(300);
    press('pointerUp', like(), { clientX: 130 });
    fireEvent.click(like());
    await advance(0);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1 });
  });

  it('does nothing when the pointer is cancelled, and the next press is a fresh one', async () => {
    const app = renderRow();
    press('pointerDown', like());
    await advance(600);
    press('pointerCancel', like());
    await advance(0);
    expect(sent(app)).toHaveLength(0);

    await hold(like(), 100);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: 1 });
  });

  it('takes the click after the next press for an ordinary press again', async () => {
    const app = renderRow();
    await hold(like(), 600);

    await hold(like(), 50);

    expect(sent(app)).toHaveLength(2);
    const second = bodyOf(sent(app)[1]!);
    expect(second).toMatchObject({ rating: null });
    expect(second).not.toHaveProperty('hide');
  });

  it('holds a long-pressed dislike for the reason bar and hides with it', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      routes: { 'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: -1 })) },
    });

    await hold(dislike(), 600);
    expect(sent(app)).toHaveLength(0);
    expect(bar()).toBeInTheDocument();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Other' }));
    await advance(0);

    expect(sent(app)).toHaveLength(1);
    expect(bodyOf(sent(app)[0]!)).toEqual({ ...FENCE, rating: -1, hide: true, reason: 'other' });
  });

  it('does not open the menu of the browser while a thumb or a pen is held, but for a mouse', () => {
    renderRow();

    press('pointerDown', like());
    expect(fireEvent.contextMenu(like())).toBe(false);
    press('pointerUp', like());
    press('pointerDown', like(), { pointerType: 'mouse' });
    expect(fireEvent.contextMenu(like())).toBe(true);
  });

  it('does not hide with a long press on the bookmark', async () => {
    const item = makeItem();
    const app = renderRow(item, {
      routes: {
        'POST /articles/:id/bookmark': () => actionResponse(acked(item, { bookmarkedAt: READ_AT })),
      },
    });

    await hold(screen.getByRole('button', { name: 'Bookmark' }), 800);

    const bookmarks = app.calls('POST', '/articles/101/bookmark');
    expect(bookmarks).toHaveLength(1);
    expect(bodyOf(bookmarks[0]!)).toEqual({ ...FENCE, mediaPolicyFeedId: '7' });
    expect(sent(app)).toHaveLength(0);
  });
});
