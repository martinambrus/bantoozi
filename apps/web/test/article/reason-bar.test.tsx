import type { ArticleListItem } from '@bantoozi/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { FOCUS_RING } from '../../src/components/cx.js';
import { Sheet } from '../../src/components/sheet.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { runResetHooks } from '../../src/session/reset.js';
import { UUID_V4, failure } from '../api/fake-fetch.js';
import { acked } from '../reader/actions/fake-transport.js';
import { USER_B_ID } from '../session/fixtures.js';
import {
  actionResponse,
  bodyOf,
  makeItem,
  ratingResponse,
  renderReader,
  type ReaderHarnessOptions,
} from './harness.js';

const TITLE = 'Solid-state batteries reach the pilot line';
const READ_AT = '2026-05-31T10:00:00.000Z';
const RATE = 'POST /articles/:id/rating';
const GROUP = 'Reason for the dislike';

const REASONS = [
  ['Off-topic', 'off_topic', '1'],
  ['Clickbait', 'clickbait', '2'],
  ['Seen it', 'seen', '3'],
  ['Too shallow', 'shallow', '4'],
  ['Promo', 'promo', '5'],
  ['Other', 'other', '6'],
] as const;

const apps: { unhandled: string[] }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function Rows({ items }: { items: readonly ArticleListItem[] }) {
  return (
    <>
      {items.map((item) => (
        <ArticleRow
          key={item.id}
          item={item}
          expanded={false}
          onToggleExpand={() => {}}
          simple={false}
        />
      ))}
    </>
  );
}

function renderRows(items: readonly ArticleListItem[], options: ReaderHarnessOptions = {}) {
  const app = renderReader(<Rows items={items} />, options);
  apps.push(app);
  return app;
}

function answers(item: ArticleListItem, patch: Partial<ArticleListItem> = {}) {
  return {
    [`POST /articles/${item.id}/rating`]: () =>
      ratingResponse(acked(item, { rating: -1, readAt: READ_AT, ...patch })),
  };
}

const dislike = (index = 0) => screen.getAllByRole('button', { name: 'Dislike' })[index]!;
const like = (index = 0) => screen.getAllByRole('button', { name: 'Like' })[index]!;
const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed') === 'true';
const bar = () => screen.getByRole('group', { name: GROUP });
const queryBar = () => screen.queryByRole('group', { name: GROUP });
const reasonButton = (name: string) => within(bar()).getByRole('button', { name });
const keyDown = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the dislike reason bar', () => {
  it('holds a dislike for 5 seconds, then sends it once without a reason', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });

    fireEvent.click(dislike());

    expect(pressed(dislike())).toBe(true);
    expect(bar()).toBeInTheDocument();
    await advance(4900);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeInTheDocument();

    await advance(100);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
    });
    expect(queryBar()).toBeNull();
    expect(pressed(dislike())).toBe(true);
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('makes room above itself for the toasts while it is open, and gives the room back', () => {
    renderRows([makeItem()]);
    const room = () => document.documentElement.style.getPropertyValue('--reason-bar-height');
    expect(room()).toBe('');

    fireEvent.click(dislike());
    expect(room()).toMatch(/^\d+px$/);
    fireEvent.click(reasonButton('Undo'));

    expect(room()).toBe('');
  });

  it('names the article and offers the six reasons in order, then Undo', () => {
    renderRows([makeItem()]);
    fireEvent.click(dislike());

    expect(bar()).toHaveTextContent(`Disliked: ${TITLE}`);
    const buttons = within(bar()).getAllByRole('button');
    expect(buttons).toHaveLength(7);
    REASONS.forEach(([label, , key], index) => {
      expect(buttons[index]).toHaveAccessibleName(label);
      expect(buttons[index]).toHaveAttribute('aria-keyshortcuts', key);
    });
    expect(buttons[6]).toHaveAccessibleName('Undo');
  });

  it('gives every control a 44 px target and a focus ring', () => {
    renderRows([makeItem()]);
    fireEvent.click(dislike());

    for (const control of within(bar()).getAllByRole('button')) {
      expect(control.className).toContain('min-h-11');
      for (const token of FOCUS_RING.split(' ')) expect(control.className).toContain(token);
    }
  });

  it('never takes the focus and says in a polite live region that it opened', () => {
    renderRows([makeItem()]);
    const button = dislike();
    button.focus();

    fireEvent.click(button);

    expect(document.activeElement).toBe(button);
    const announcement = screen.getByText(
      `Disliked: ${TITLE}. Choose a reason with the keys 1 to 6, or undo.`,
    );
    expect(announcement).toHaveAttribute('aria-live', 'polite');
  });

  it.each(REASONS)('sends "%s" as the reason when it is clicked', async (label, reason) => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item, { reason }) });
    fireEvent.click(dislike());

    fireEvent.click(reasonButton(label));
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
      reason,
    });
    expect(queryBar()).toBeNull();
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it.each(REASONS)(
    'sends the reason of "%s" (%s) when the key %s is pressed',
    async (_label, reason, key) => {
      const item = makeItem();
      const { calls } = renderRows([item], { routes: answers(item, { reason }) });
      fireEvent.click(dislike());

      keyDown(key);
      await advance(0);

      expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
      expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toMatchObject({
        rating: -1,
        reason,
      });
      expect(queryBar()).toBeNull();
    },
  );

  it.each([
    [null, 'false'],
    [1, 'true'],
  ] as const)('Undo sends nothing and gives back the rating %s', async (before, wasLiked) => {
    const item = makeItem({ rating: before });
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());
    expect(pressed(dislike())).toBe(true);

    fireEvent.click(reasonButton('Undo'));

    expect(queryBar()).toBeNull();
    expect(pressed(dislike())).toBe(false);
    expect(String(pressed(like()))).toBe(wasLiked);
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });

  it('releases a dislike without a reason when another article is disliked, and holds the new one', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const { calls } = renderRows([first, second], {
      routes: { ...answers(first), ...answers(second, { reason: 'clickbait' }) },
    });

    fireEvent.click(dislike(0));
    fireEvent.click(dislike(1));
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
    });
    expect(calls('POST', '/articles/102/rating')).toHaveLength(0);
    expect(bar()).toHaveTextContent('Disliked: Another article');

    fireEvent.click(reasonButton('Clickbait'));
    await advance(10_000);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(calls('POST', '/articles/102/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/102/rating')[0]!)).toMatchObject({
      reason: 'clickbait',
    });
  });

  it('counts the 5 seconds again for the dislike that replaced another one', async () => {
    const first = makeItem();
    const second = makeItem({ id: '102', title: 'Another article' });
    const { calls } = renderRows([first, second], {
      routes: { ...answers(first), ...answers(second) },
    });

    fireEvent.click(dislike(0));
    await advance(4000);
    fireEvent.click(dislike(1));
    await advance(4900);
    expect(calls('POST', '/articles/102/rating')).toHaveLength(0);

    await advance(100);
    expect(calls('POST', '/articles/102/rating')).toHaveLength(1);
  });

  it('takes a second press of the dislike on the same article for Undo', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());

    fireEvent.click(dislike());

    expect(pressed(dislike())).toBe(false);
    expect(queryBar()).toBeNull();
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });

  it('cancels the held dislike when the like is pressed and likes from the state without it', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], {
      routes: {
        [RATE]: () => ratingResponse(acked(item, { rating: 1, readAt: READ_AT })),
      },
    });
    fireEvent.click(dislike());

    fireEvent.click(like());
    await advance(0);

    expect(queryBar()).toBeNull();
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: 1,
    });
    expect(pressed(like())).toBe(true);
    expect(pressed(dislike())).toBe(false);
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('rates the like from the rating the dislike replaced, so a liked article is un-liked', async () => {
    const item = makeItem({ rating: 1 });
    const { calls } = renderRows([item], {
      routes: { [RATE]: () => ratingResponse(acked(item, { rating: null })) },
    });
    fireEvent.click(dislike());

    fireEvent.click(like());
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toMatchObject({ rating: null });
  });

  it('sends a bookmark pressed meanwhile after the dislike', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], {
      routes: {
        ...answers(item),
        'POST /articles/:id/bookmark': () =>
          actionResponse(acked(acked(item, { rating: -1 }), { bookmarkedAt: READ_AT })),
      },
    });
    fireEvent.click(dislike());
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark' }));
    expect(pressed(screen.getByRole('button', { name: 'Bookmark' }))).toBe(true);
    await advance(4900);
    expect(calls('POST', '/articles/101/bookmark')).toHaveLength(0);

    fireEvent.click(reasonButton('Other'));
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(calls('POST', '/articles/101/bookmark')).toHaveLength(1);
  });

  it.each([
    [1, 'Like'],
    [-1, 'Dislike'],
  ] as const)('opens no bar when the rating %s is taken back', async (rating, name) => {
    const item = makeItem({ rating });
    const { calls } = renderRows([item], {
      routes: { [RATE]: () => ratingResponse(acked(item, { rating: null })) },
    });

    fireEvent.click(screen.getByRole('button', { name }));
    await advance(0);

    expect(queryBar()).toBeNull();
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toMatchObject({ rating: null });
  });

  it('opens no bar for a like', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], {
      routes: { [RATE]: () => ratingResponse(acked(item, { rating: 1 })) },
    });

    fireEvent.click(like());
    await advance(0);

    expect(queryBar()).toBeNull();
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('stays after its row has left the list and still sends the reason', async () => {
    const item = makeItem();
    function Leaving() {
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown ? <Rows items={[item]} /> : null}
          <button type="button" onClick={() => setShown(false)}>
            Remove the row
          </button>
        </>
      );
    }
    const app = renderReader(<Leaving />, { routes: answers(item, { reason: 'promo' }) });
    apps.push(app);
    fireEvent.click(dislike());

    fireEvent.click(screen.getByRole('button', { name: 'Remove the row' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(bar()).toHaveTextContent(`Disliked: ${TITLE}`);
    fireEvent.click(reasonButton('Promo'));
    await advance(0);

    expect(bodyOf(app.calls('POST', '/articles/101/rating')[0]!)).toMatchObject({
      rating: -1,
      reason: 'promo',
    });
  });

  it.each([
    [
      'the page is hidden',
      () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      },
    ],
    ['the page goes away', () => window.dispatchEvent(new Event('pagehide'))],
  ])('sends the held dislike at once, without a reason, when %s', async (_, leave) => {
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'visibilityState');
    });
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());

    act(leave);
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
    });
    expect(queryBar()).toBeNull();
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('keeps waiting when the page becomes visible', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeInTheDocument();
  });

  it('closes without sending anything when the account is reset', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());

    await act(async () => {
      await runResetHooks('logout');
    });

    expect(queryBar()).toBeNull();
    expect(pressed(dislike())).toBe(false);
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
  });

  it('is dropped with the account when another one signs in', async () => {
    const item = makeItem();
    const app = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());
    expect(bar()).toBeInTheDocument();

    act(() => app.switchAccount(USER_B_ID));
    await advance(60_000);

    expect(queryBar()).toBeNull();
    expect(app.calls('POST', '/articles/101/rating')).toHaveLength(0);
  });

  it('is shown inside an open modal, since the page behind it cannot be reached', async () => {
    const item = makeItem();
    const app = renderReader(
      <Sheet open onClose={() => {}} title="Article" side="bottom">
        <Rows items={[item]} />
      </Sheet>,
      { routes: answers(item, { reason: 'promo' }) },
    );
    apps.push(app);

    fireEvent.click(dislike());

    const dialog = screen.getByRole('dialog', { name: 'Article' });
    expect(within(dialog).getByRole('group', { name: GROUP })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promo' }));
    await advance(0);
    expect(bodyOf(app.calls('POST', '/articles/101/rating')[0]!)).toMatchObject({
      rating: -1,
      reason: 'promo',
    });
  });

  it('keeps one key and one body for the request, also when it is sent again', async () => {
    const item = makeItem();
    let attempts = 0;
    const { calls } = renderRows([item], {
      routes: {
        [RATE]: () => {
          attempts += 1;
          return attempts === 1
            ? failure(503, 'INTERNAL')
            : ratingResponse(acked(item, { rating: -1, reason: 'clickbait' }));
        },
      },
    });
    fireEvent.click(dislike());
    fireEvent.click(reasonButton('Clickbait'));
    await advance(0);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);

    await advance(5000);

    const [first, again] = calls('POST', '/articles/101/rating');
    expect(calls('POST', '/articles/101/rating')).toHaveLength(2);
    expect(first!.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(again!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'));
    expect(again!.body).toBe(first!.body);
    expect(bodyOf(first!)).toMatchObject({ rating: -1, reason: 'clickbait' });
  });

  it('waits while the pointer is in the bar and goes on with the time that was left', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());
    await advance(4000);

    fireEvent.pointerEnter(bar());
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeInTheDocument();

    fireEvent.pointerLeave(bar());
    await advance(999);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    await advance(1);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('waits while a control in the bar has the focus and goes on when it is lost', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());
    await advance(3000);

    act(() => reasonButton('Clickbait').focus());
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);

    act(() => reasonButton('Clickbait').blur());
    await advance(1999);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    await advance(1);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('keeps waiting when the pointer leaves the bar while a control in it has the focus', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());
    await advance(1000);
    act(() => reasonButton('Clickbait').focus());
    fireEvent.pointerEnter(bar());

    fireEvent.pointerLeave(bar());
    await advance(60_000);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);

    act(() => reasonButton('Clickbait').blur());
    await advance(3999);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    await advance(1);
    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
  });

  it('speaks Slovak', () => {
    renderRows([makeItem()], { language: 'sk' });
    fireEvent.click(screen.getByRole('button', { name: 'Nepáči sa mi' }));

    const group = screen.getByRole('group', { name: 'Dôvod nepáčenia' });
    expect(group).toHaveTextContent(`Nepáči sa vám: ${TITLE}`);
    const names = [
      'Mimo témy',
      'Klikbajt',
      'Už videné',
      'Príliš plytké',
      'Reklama',
      'Iné',
      'Vrátiť späť',
    ];
    const buttons = within(group).getAllByRole('button');
    names.forEach((name, index) => expect(buttons[index]).toHaveAccessibleName(name));
  });
});

describe('the keys 1 to 6 while the bar is open', () => {
  function Surroundings() {
    return (
      <>
        <Rows items={[makeItem()]} />
        <input aria-label="Filter" />
        <textarea aria-label="Note" />
        <select aria-label="Order">
          <option>One</option>
        </select>
        <div aria-label="Editor" contentEditable suppressContentEditableWarning tabIndex={0} />
        <dialog aria-label="Modal" hidden />
      </>
    );
  }

  const ignored: [string, () => void][] = [
    ['an input', () => keyDown('3', {}, screen.getByLabelText('Filter'))],
    ['a textarea', () => keyDown('3', {}, screen.getByLabelText('Note'))],
    ['a select', () => keyDown('3', {}, screen.getByLabelText('Order'))],
    ['a contenteditable region', () => keyDown('3', {}, screen.getByLabelText('Editor'))],
    ['an IME composition', () => keyDown('3', { isComposing: true })],
    ['an IME composition reported by key code 229', () => keyDown('3', { keyCode: 229 })],
    ['the Ctrl key', () => keyDown('3', { ctrlKey: true })],
    ['the Meta key', () => keyDown('3', { metaKey: true })],
    ['the Alt key', () => keyDown('3', { altKey: true })],
    [
      'an open modal dialog',
      () => {
        screen.getByLabelText('Modal').setAttribute('open', '');
        keyDown('3');
      },
    ],
  ];

  it.each(ignored)('does not pick a reason in %s', async (_where, press) => {
    const item = makeItem();
    const app = renderReader(<Surroundings />, { routes: answers(item) });
    apps.push(app);
    fireEvent.click(dislike());

    press();
    await advance(0);

    expect(app.calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeInTheDocument();
    await advance(5000);
    expect(bodyOf(app.calls('POST', '/articles/101/rating')[0]!)).toEqual({
      stateVersion: '4',
      contentRevision: '2',
      rating: -1,
    });
  });

  it('ignores them, and everything else, while no bar is open', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });

    keyDown('3');
    await advance(60_000);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(pressed(dislike())).toBe(false);
  });

  it('ignores the other keys while the bar is open', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item) });
    fireEvent.click(dislike());

    for (const key of ['0', '7', 'a', 'Enter', 'F1']) keyDown(key);
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(0);
    expect(bar()).toBeInTheDocument();
  });

  it('answers a key once even when the browser repeats it', async () => {
    const item = makeItem();
    const { calls } = renderRows([item], { routes: answers(item, { reason: 'seen' }) });
    fireEvent.click(dislike());

    keyDown('3');
    keyDown('3', { repeat: true });
    await advance(0);

    expect(calls('POST', '/articles/101/rating')).toHaveLength(1);
    expect(bodyOf(calls('POST', '/articles/101/rating')[0]!)).toMatchObject({ reason: 'seen' });
  });
});
