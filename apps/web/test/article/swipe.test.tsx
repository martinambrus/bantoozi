import type { ArticleListItem, UserPreferences } from '@bantoozi/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meKey } from '../../src/api/query-keys.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { acked } from '../reader/actions/fake-transport.js';
import {
  actionResponse,
  bodyOf,
  makeItem,
  makeMe,
  ratingResponse,
  renderReader,
  type ReaderHarnessOptions,
} from './harness.js';

const TITLE = 'Solid-state batteries reach the pilot line';
const READ_AT = '2026-05-31T10:00:00.000Z';
const WIDTH = 400;
const ORIGIN = { x: 200, y: 100 };
const BAR = 'Reason for the dislike';

type Swipe = UserPreferences['swipe'];
type PointerKind = 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel';

const apps: { unhandled: string[] }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: WIDTH,
    bottom: 100,
    width: WIDTH,
    height: 100,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function answers(item: ArticleListItem) {
  return {
    'POST /articles/:id/rating': () =>
      ratingResponse(acked(item, { rating: item.rating === 1 ? null : 1, readAt: READ_AT })),
    'POST /articles/:id/bookmark': () => actionResponse(acked(item, { bookmarkedAt: READ_AT })),
    'DELETE /articles/:id/bookmark': () => actionResponse(acked(item, { bookmarkedAt: null })),
    'POST /articles/:id/read': () => actionResponse(acked(item, { readAt: READ_AT })),
    'POST /articles/:id/unread': () => actionResponse(acked(item, { readAt: null })),
  };
}

function swipeOf(side: 'left' | 'right', pref: Swipe['left'] | Swipe['right']): Swipe {
  return side === 'right'
    ? { left: 'none', right: pref as Swipe['right'] }
    : { left: pref as Swipe['left'], right: 'none' };
}

function renderRow(
  item: ArticleListItem = makeItem(),
  options: ReaderHarnessOptions & { swipe?: Swipe } = {},
) {
  const { swipe, ...rest } = options;
  const onToggleExpand = vi.fn();
  const app = renderReader(
    <ArticleRow item={item} expanded={false} onToggleExpand={onToggleExpand} simple={false} />,
    {
      routes: answers(item),
      ...(swipe === undefined ? {} : { me: makeMe({ preferences: { swipe } }) }),
      ...rest,
    },
  );
  apps.push(app);
  return { ...app, onToggleExpand };
}

const row = () => screen.getByRole('article', { name: TITLE });
const content = () => row().querySelector<HTMLElement>('[data-swipe-content]');
const shift = () => content()?.style.transform;
const feedback = () => row().querySelector<HTMLElement>('[data-swipe-action]');
const title = () => screen.getByRole('button', { name: TITLE });

function shownFeedback(): HTMLElement {
  const layer = feedback();
  expect(layer).not.toBeNull();
  return layer!;
}

function shownContent(): HTMLElement {
  const element = content();
  expect(element).not.toBeNull();
  return element!;
}
const bar = () => screen.queryByRole('group', { name: BAR });
const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';

function pointer(
  kind: PointerKind,
  dx: number,
  dy: number,
  init: PointerEventInit = {},
  target: Element = row(),
) {
  fireEvent[kind](target, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: ORIGIN.x + dx,
    clientY: ORIGIN.y + dy,
    ...init,
  });
}

const down = (init?: PointerEventInit, target?: Element) =>
  pointer('pointerDown', 0, 0, init, target);
const move = (dx: number, dy = 0, init?: PointerEventInit, target?: Element) =>
  pointer('pointerMove', dx, dy, init, target);
const up = (dx: number, dy = 0, init?: PointerEventInit, target?: Element) =>
  pointer('pointerUp', dx, dy, init, target);
const cancel = (dx = 0, dy = 0) => pointer('pointerCancel', dx, dy);

/** A whole swipe: the finger goes down, moves by `dx` and is lifted there. */
function swipe(dx: number, init?: PointerEventInit) {
  down(init);
  move(dx, 0, init);
  up(dx, 0, init);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('following the finger', () => {
  it('leaves vertical scrolling and pinch-zoom to the browser', () => {
    renderRow();
    expect(row()).toHaveClass('touch-pan-y', 'touch-pinch-zoom');
  });

  it('starts only when the finger has gone more than 10 px sideways', () => {
    renderRow();

    down();
    move(10);
    expect(shift()).toBe('');
    move(11);
    expect(shift()).toBe('translateX(11px)');
    move(120);
    expect(shift()).toBe('translateX(120px)');
  });

  it('follows the finger to the left too', () => {
    renderRow();

    down();
    move(-10);
    expect(shift()).toBe('');
    move(-120);

    expect(shift()).toBe('translateX(-120px)');
  });

  it('does not go further than the width of the row, nor past where the finger started', () => {
    renderRow();

    down();
    move(500);
    expect(shift()).toBe('translateX(400px)');
    move(-80);
    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    move(90);
    expect(shift()).toBe('translateX(90px)');
  });

  it('puts the row back when it is released', () => {
    renderRow();
    down();
    move(100);
    expect(shift()).toBe('translateX(100px)');

    up(100);

    expect(shift()).toBe('');
  });
});

describe('where a swipe starts', () => {
  it('does not start on a movement that is more up or down than sideways', () => {
    renderRow();

    down();
    move(4, 60);
    expect(shift()).toBe('');
    move(30, 60);
    expect(shift()).toBe('');
    move(61, 60);
    expect(shift()).toBe('translateX(61px)');
  });

  it('lets a vertical drag go: nothing moves, shows or is sent', async () => {
    const { calls } = renderRow();

    down();
    move(3, 40);
    move(6, 120);
    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    up(6, 120);
    await advance(10_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeNull();

    swipe(100);
    expect(shift()).toBe('');
    down();
    move(100);
    expect(shift()).toBe('translateX(100px)');
  });

  it('is not started by a mouse', () => {
    renderRow();

    down({ pointerType: 'mouse' });
    move(200, 0, { pointerType: 'mouse' });
    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    up(200, 0, { pointerType: 'mouse' });

    down();
    move(200);
    expect(shift()).toBe('translateX(200px)');
  });

  it('is started by a pen', () => {
    renderRow();

    down({ pointerType: 'pen' });
    move(100, 0, { pointerType: 'pen' });

    expect(shift()).toBe('translateX(100px)');
  });

  it('follows the finger that went down, not another one', () => {
    renderRow();

    down();
    move(150, 0, { pointerId: 2 });
    expect(shift()).toBe('');
    move(100);
    expect(shift()).toBe('translateX(100px)');
    move(180, 0, { pointerId: 2 });
    expect(shift()).toBe('translateX(100px)');
  });
});

describe('the colour and the name of the action', () => {
  it('shows them once the finger is past 15 % of the width', () => {
    renderRow();

    down();
    move(59);
    expect(shift()).toBe('translateX(59px)');
    expect(feedback()).toBeNull();
    move(61);

    const shown = feedback();
    expect(shown).not.toBeNull();
    expect(shown).toHaveAttribute('data-swipe-action', 'like');
    expect(within(shown!).getByText('Like')).toBeInTheDocument();
    expect(shown!.querySelector('svg')).not.toBeNull();
  });

  it('takes them away again when the finger goes back under 15 %', () => {
    renderRow();
    down();
    move(100);
    expect(feedback()).not.toBeNull();

    move(40);

    expect(feedback()).toBeNull();
  });

  it('is hidden from assistive technology, since the buttons do the same', () => {
    renderRow();
    down();
    move(100);

    expect(shownFeedback()).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the dislike on the left', () => {
    renderRow();

    down();
    move(-59);
    expect(feedback()).toBeNull();
    move(-61);

    expect(shownFeedback()).toHaveAttribute('data-swipe-action', 'dislike');
    expect(within(shownFeedback()).getByText('Dislike')).toBeInTheDocument();
  });

  it('marks the moment the release would run the action', () => {
    renderRow();
    down();

    move(139);
    expect(shownFeedback()).not.toHaveAttribute('data-armed', 'true');
    move(141);

    expect(shownFeedback()).toHaveAttribute('data-armed', 'true');
  });

  it.each([
    ['right', 'like', {}, 'Like'],
    ['right', 'like', { rating: 1 }, 'Remove like'],
    ['right', 'bookmark', {}, 'Bookmark'],
    ['right', 'bookmark', { bookmarkedAt: READ_AT }, 'Remove bookmark'],
    ['left', 'dislike', {}, 'Dislike'],
    ['left', 'dislike', { rating: -1 }, 'Remove dislike'],
    ['left', 'read', {}, 'Mark as read'],
    ['left', 'read', { readAt: READ_AT }, 'Mark as unread'],
  ] as const)('on the %s, "%s" of %j is named "%s"', (side, pref, patch, name) => {
    renderRow(makeItem(patch), { swipe: swipeOf(side, pref) });

    down();
    move(side === 'right' ? 100 : -100);

    expect(shownFeedback()).toHaveAttribute('data-swipe-action', pref);
    expect(within(shownFeedback()).getByText(name)).toBeInTheDocument();
  });

  it.each([
    ['right', 'like', 'Páči sa mi'],
    ['right', 'bookmark', 'Záložka'],
    ['left', 'dislike', 'Nepáči sa mi'],
    ['left', 'read', 'Označiť ako prečítané'],
  ] as const)('on the %s, "%s" is named in Slovak "%s"', (side, pref, name) => {
    renderRow(makeItem(), { language: 'sk', swipe: swipeOf(side, pref) });

    down();
    move(side === 'right' ? 100 : -100);

    expect(within(shownFeedback()).getByText(name)).toBeInTheDocument();
  });
});

describe('releasing a swipe', () => {
  it('snaps back below 35 % and sends nothing', async () => {
    const { calls } = renderRow();
    down();
    move(100);
    expect(feedback()).not.toBeNull();
    move(139);

    up(139);

    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    await advance(10_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(pressed('Like')).toBe(false);
  });

  it.each([140, 141, 400])('runs the action when released at %s px', async (dx) => {
    const { calls } = renderRow();

    swipe(dx);
    await advance(0);

    expect(shift()).toBe('');
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
    });
    expect(pressed('Like')).toBe(true);
  });

  it('measures the width of the row it is on', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });
    const { calls } = renderRow();

    swipe(69);
    await advance(0);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);

    swipe(71);
    await advance(0);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('decides by where the finger is lifted', async () => {
    const { calls } = renderRow();
    down();
    move(100);

    up(141);
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('snaps back when the pointer is cancelled, even past 35 %', async () => {
    const { calls } = renderRow();
    down();
    move(200);
    expect(feedback()).not.toBeNull();

    cancel(200);

    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    await advance(10_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(pressed('Like')).toBe(false);
  });

  it('ignores what the pointer does after it was cancelled', async () => {
    const { calls } = renderRow();
    down();
    move(100);
    cancel(100);

    move(300);
    up(300);
    await advance(0);

    expect(shift()).toBe('');
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });
});

describe('what a swipe does, by the preferences', () => {
  const fence = { stateVersion: '4', contentRevision: '2' };

  it.each([
    ['right', 'like', {}, 'POST', '/articles/101/rating', { ...fence, rating: 1 }],
    ['right', 'like', { rating: 1 }, 'POST', '/articles/101/rating', { ...fence, rating: null }],
    [
      'right',
      'bookmark',
      {},
      'POST',
      '/articles/101/bookmark',
      { ...fence, mediaPolicyFeedId: '7' },
    ],
    ['right', 'bookmark', { bookmarkedAt: READ_AT }, 'DELETE', '/articles/101/bookmark', null],
    ['left', 'read', {}, 'POST', '/articles/101/read', fence],
    ['left', 'read', { readAt: READ_AT }, 'POST', '/articles/101/unread', fence],
  ] as const)(
    'on the %s, "%s" of %j sends %s %s',
    async (side, pref, patch, method, path, body) => {
      const { calls, requests } = renderRow(makeItem(patch), { swipe: swipeOf(side, pref) });

      swipe(side === 'right' ? 200 : -200);
      await advance(0);

      expect(requests).toHaveLength(1);
      expect(calls(method, path)).toHaveLength(1);
      if (body !== null) expect(bodyOf(calls(method, path)[0]!)).toEqual(body);
      expect(bar()).toBeNull();
    },
  );

  it('opens the reason bar for a swipe that dislikes, and sends the dislike after it', async () => {
    const { calls } = renderRow();

    swipe(-200);
    await advance(0);

    expect(pressed('Dislike')).toBe(true);
    expect(bar()).toBeInTheDocument();
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Promo' }));
    await advance(0);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
      reason: 'promo',
    });
  });

  it('takes a swipe on a disliked article for taking the dislike back', async () => {
    const item = makeItem({ rating: -1 });
    const { calls } = renderRow(item, {
      routes: {
        'POST /articles/:id/rating': () => ratingResponse(acked(item, { rating: null })),
      },
    });

    swipe(-200);
    await advance(0);

    expect(bar()).toBeNull();
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toMatchObject({ rating: null });
  });

  it.each([
    ['right', 'none', 200],
    ['left', 'none', -200],
  ] as const)('does not swipe %s when that is set to %s', async (side, _pref, dx) => {
    const { calls, requests } = renderRow(makeItem(), {
      swipe:
        side === 'right' ? { left: 'dislike', right: 'none' } : { left: 'none', right: 'like' },
    });

    down();
    move(dx);
    expect(shift()).toBe('');
    expect(feedback()).toBeNull();
    up(dx);
    await advance(10_000);
    expect(requests).toHaveLength(0);
    expect(bar()).toBeNull();

    down();
    move(-dx);
    expect(shift()).toBe(`translateX(${-dx}px)`);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });

  it('honours a change of the preferences made while the page is open', async () => {
    const { calls, queryClient } = renderRow();
    act(() => {
      queryClient.setQueryData(
        meKey(),
        makeMe({ preferences: { swipe: { left: 'read', right: 'bookmark' } } }),
      );
    });

    swipe(200);
    await advance(0);

    expect(calls('POST', '/articles/101/bookmark')).toHaveLength(1);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });
});

describe('the click that follows a swipe', () => {
  it.each([
    [141, 'a swipe that ran its action'],
    [100, 'a drag that snapped back'],
  ])('is not taken for a press of the title after %s px: %s', (dx) => {
    const { onToggleExpand } = renderRow();

    swipe(dx);
    fireEvent.click(title());
    expect(onToggleExpand).not.toHaveBeenCalled();

    fireEvent.click(title());
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('is not taken for a press of the button the swipe began on', async () => {
    const { calls } = renderRow(makeItem(), { swipe: { left: 'none', right: 'bookmark' } });
    const like = screen.getByRole('button', { name: 'Like' });

    down({}, like);
    move(200, 0, {}, like);
    up(200, 0, {}, like);
    fireEvent.click(like);
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(calls('POST', '/articles/101/bookmark')).toHaveLength(1);
  });

  it('lets a plain tap through, also one that moved a little', () => {
    const { onToggleExpand } = renderRow();

    down();
    move(4, 2);
    up(4, 2);
    fireEvent.click(title());

    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('lets a tap through that comes after a swipe, whether or not the swipe had a click', () => {
    const { onToggleExpand } = renderRow();
    swipe(200);

    down({}, title());
    up(0, 0, {}, title());
    fireEvent.click(title());

    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it('lets a press by keyboard through that comes much later', async () => {
    const { onToggleExpand } = renderRow();
    swipe(200);
    await advance(1000);

    fireEvent.click(title());

    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });
});

describe('moving without a transition', () => {
  it('animates only the snap back, and not for people who ask for less motion', () => {
    renderRow();

    down();
    move(100);
    expect(shownContent()).not.toHaveClass('transition-transform');
    up(100);

    expect(shownContent()).toHaveClass('transition-transform', 'motion-reduce:transition-none');
  });

  it('follows the finger at once again for the next swipe', () => {
    renderRow();
    swipe(100);

    down();
    move(50);

    expect(shownContent()).not.toHaveClass('transition-transform');
  });
});
