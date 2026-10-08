import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from '../../src/components/toast/toast-provider.js';
import {
  createToastStore,
  type ToastInput,
  type ToastStore,
} from '../../src/components/toast/toast-store.js';
import { Toaster } from '../../src/components/toast/toaster.js';
import { createI18n, type Language } from '../../src/i18n/index.js';

function renderToaster(store: ToastStore = createToastStore(), language: Language = 'en') {
  render(
    <I18nextProvider i18n={createI18n(language)}>
      <ToastProvider store={store}>
        <Toaster />
      </ToastProvider>
    </I18nextProvider>,
  );
  return store;
}

function named(label: string) {
  return { label, onAction: vi.fn() };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function fakeTimerUser() {
  vi.useFakeTimers();
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createToastStore', () => {
  it('returns the given id, or a fresh one for each toast', () => {
    const store = createToastStore();
    expect(store.show({ id: 'save', message: 'a', tone: 'info' })).toBe('save');
    const first = store.show({ message: 'b', tone: 'info' });
    const second = store.show({ message: 'c', tone: 'info' });
    expect(first).not.toBe(second);
    expect(store.getSnapshot().map((toast) => toast.id)).toEqual(['save', first, second]);
  });

  it('keeps the snapshot until something changes and notifies subscribers', () => {
    const store = createToastStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);

    store.dismiss('missing');
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(empty);

    const id = store.show({ message: 'a', tone: 'success' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(empty);

    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual([]);

    unsubscribe();
    store.show({ message: 'b', tone: 'info' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('replaces a toast shown again under the same id, keeping its position', () => {
    const store = createToastStore();
    store.show({ id: 'a', message: 'first', tone: 'info' });
    store.show({ id: 'b', message: 'second', tone: 'info' });
    store.show({ id: 'a', message: 'changed', tone: 'error' });
    expect(store.getSnapshot().map((toast) => [toast.id, toast.message, toast.tone])).toEqual([
      ['a', 'changed', 'error'],
      ['b', 'second', 'info'],
    ]);
  });

  it('holds at most three toasts: a fourth drops the oldest', () => {
    const store = createToastStore();
    for (const message of ['one', 'two', 'three', 'four']) store.show({ message, tone: 'info' });
    expect(store.getSnapshot().map((toast) => toast.message)).toEqual(['two', 'three', 'four']);
  });

  it('lists action first, then actions, and keeps at most three in all', () => {
    const [a, b, c, d] = [named('A'), named('B'), named('C'), named('D')];
    const actionsOf = (input: Pick<ToastInput, 'action' | 'actions'>) => {
      const store = createToastStore();
      store.show({ message: 'Rated', tone: 'info', ...input });
      return store.getSnapshot()[0]?.actions;
    };
    expect(actionsOf({})).toEqual([]);
    expect(actionsOf({ action: a })).toEqual([a]);
    expect(actionsOf({ actions: [a, b] })).toEqual([a, b]);
    expect(actionsOf({ action: a, actions: [b, c] })).toEqual([a, b, c]);
    expect(actionsOf({ actions: [a, b, c, d] })).toEqual([a, b, c]);
    expect(actionsOf({ action: d, actions: [a, b, c] })).toEqual([d, a, b]);
  });

  it('keeps the first action on the toast as its action', () => {
    const [a, b] = [named('A'), named('B')];
    const store = createToastStore();
    store.show({ id: 'many', message: 'many', tone: 'info', actions: [a, b] });
    store.show({ id: 'none', message: 'none', tone: 'info' });
    expect(store.getSnapshot().map((toast) => toast.action)).toEqual([a, undefined]);
  });

  it('lasts 5 s by default and stays when durationMs is null', () => {
    const store = createToastStore();
    store.show({ id: 'default', message: 'a', tone: 'info' });
    store.show({ id: 'sticky', message: 'b', tone: 'info', durationMs: null });
    store.show({ id: 'short', message: 'c', tone: 'info', durationMs: 800 });
    const durations = Object.fromEntries(
      store.getSnapshot().map((toast) => [toast.id, toast.durationMs]),
    );
    expect(durations).toEqual({ default: 5000, sticky: null, short: 800 });
  });
});

describe('Toaster', () => {
  it('always renders a polite status region, even without toasts', () => {
    const store = renderToaster();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();

    act(() => {
      store.show({ message: 'Saved', tone: 'success' });
    });
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Saved');
  });

  it('shows at most three toasts', () => {
    const store = renderToaster();
    act(() => {
      for (const message of ['one', 'two', 'three', 'four']) store.show({ message, tone: 'info' });
    });
    expect(screen.queryByText('one')).not.toBeInTheDocument();
    for (const message of ['two', 'three', 'four']) expect(screen.getByText(message)).toBeVisible();
  });

  it('marks each tone with an icon, not with colour alone', () => {
    const store = renderToaster();
    act(() => {
      store.show({ message: 'info toast', tone: 'info', durationMs: null });
      store.show({ message: 'success toast', tone: 'success', durationMs: null });
      store.show({ message: 'error toast', tone: 'error', durationMs: null });
    });
    const icons = ['info', 'success', 'error'].map((tone) => {
      const toast = screen.getByText(`${tone} toast`).closest('[data-tone]');
      expect(toast).toHaveAttribute('data-tone', tone);
      const icon = toast?.firstElementChild;
      expect(icon?.tagName.toLowerCase()).toBe('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      return icon?.innerHTML;
    });
    expect(new Set(icons).size).toBe(3);
  });

  it('runs the action and then dismisses the toast', async () => {
    const user = userEvent.setup();
    const store = renderToaster();
    const seen: number[] = [];
    act(() => {
      store.show({
        message: 'Rated',
        tone: 'info',
        action: { label: 'Undo', onAction: () => seen.push(store.getSnapshot().length) },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(seen).toEqual([1]);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
    expect(store.getSnapshot()).toEqual([]);
  });

  describe('with several actions', () => {
    const UNDO = 'Undo';
    const TEACH = 'Teach EV battery tech';
    const STOP = 'Stop suggesting';
    const LABELS = [UNDO, TEACH, STOP];

    function showWith(store: ToastStore, input: Pick<ToastInput, 'action' | 'actions'>) {
      act(() => {
        store.show({ message: 'Rated', tone: 'info', durationMs: null, ...input });
      });
    }

    function actionLabels() {
      const buttons = screen.getAllByRole('button');
      expect(buttons.at(-1)).toHaveAccessibleName('Dismiss');
      return buttons.slice(0, -1).map((button) => button.textContent);
    }

    it('renders one button per action, in order, before the dismiss button', () => {
      const store = renderToaster();
      showWith(store, { actions: LABELS.map(named) });
      expect(actionLabels()).toEqual(LABELS);
    });

    it.each(LABELS)('runs "%s" once, and only it, then dismisses the toast', async (label) => {
      const user = userEvent.setup();
      const store = renderToaster();
      const actions = LABELS.map(named);
      showWith(store, { actions });

      await user.click(screen.getByRole('button', { name: label }));
      expect(actions.map((action) => action.onAction.mock.calls.length)).toEqual(
        LABELS.map((other) => (other === label ? 1 : 0)),
      );
      expect(screen.queryByText('Rated')).not.toBeInTheDocument();
      expect(store.getSnapshot()).toEqual([]);
    });

    it('puts action before actions', () => {
      const store = renderToaster();
      showWith(store, { action: named(UNDO), actions: [named(TEACH), named(STOP)] });
      expect(actionLabels()).toEqual(LABELS);
    });

    it('shows only the first three of four actions', () => {
      const store = renderToaster();
      showWith(store, { actions: [...LABELS, 'Fourth'].map(named) });
      expect(actionLabels()).toEqual(LABELS);
      expect(screen.queryByRole('button', { name: 'Fourth' })).not.toBeInTheDocument();
    });
  });

  it('dismisses with a labelled icon button, in both languages', async () => {
    const user = userEvent.setup();
    const store = renderToaster(createToastStore(), 'sk');
    act(() => {
      store.show({ message: 'Uložené', tone: 'success', durationMs: null });
    });
    await user.click(
      screen.getByRole('button', { name: createI18n('sk').t('common:actions.dismiss') }),
    );
    expect(screen.queryByText('Uložené')).not.toBeInTheDocument();
  });

  it('expires after its duration', () => {
    vi.useFakeTimers();
    const store = renderToaster();
    act(() => {
      store.show({ id: 'default', message: 'five seconds', tone: 'info' });
      store.show({ id: 'short', message: 'one second', tone: 'info', durationMs: 1000 });
    });
    advance(999);
    expect(screen.getByText('one second')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('one second')).not.toBeInTheDocument();
    advance(3999);
    expect(screen.getByText('five seconds')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('five seconds')).not.toBeInTheDocument();
  });

  it('stays until dismissed when durationMs is null', () => {
    vi.useFakeTimers();
    const store = renderToaster();
    act(() => {
      store.show({ message: 'sticky', tone: 'error', durationMs: null });
    });
    advance(10 * 60 * 1000);
    expect(screen.getByText('sticky')).toBeInTheDocument();
  });

  it('pauses while hovered and resumes with the remaining time', async () => {
    const user = fakeTimerUser();
    const store = renderToaster();
    act(() => {
      store.show({ message: 'Saved', tone: 'success' });
    });
    advance(3000);
    await user.hover(screen.getByText('Saved'));
    advance(60_000);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await user.unhover(screen.getByText('Saved'));
    advance(1999);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('pauses while a control inside has focus and resumes when focus leaves', async () => {
    const user = fakeTimerUser();
    const store = renderToaster();
    act(() => {
      store.show({
        message: 'Rated',
        tone: 'info',
        action: { label: 'Undo', onAction: () => {} },
      });
    });
    advance(3000);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    advance(60_000);
    expect(screen.getByText('Rated')).toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    advance(60_000);
    expect(screen.getByText('Rated')).toBeInTheDocument();

    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    advance(1999);
    expect(screen.getByText('Rated')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });

  it('restarts the timer when a toast is replaced under its id', () => {
    vi.useFakeTimers();
    const store = renderToaster();
    act(() => {
      store.show({ id: 'save', message: 'Saving', tone: 'info' });
    });
    advance(4000);
    act(() => {
      store.show({ id: 'save', message: 'Saved', tone: 'success' });
    });
    expect(screen.queryByText('Saving')).not.toBeInTheDocument();
    advance(4999);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('animates only when motion is allowed', () => {
    const store = renderToaster();
    act(() => {
      store.show({ message: 'Hello', tone: 'info', durationMs: null });
    });
    const classes = (screen.getByText('Hello').closest('[data-tone]')?.className ?? '').split(
      /\s+/,
    );
    const animated = classes.filter((name) => name.includes('animate-'));
    expect(animated.length).toBeGreaterThan(0);
    expect(animated.every((name) => name.startsWith('motion-safe:'))).toBe(true);
  });
});

describe('ToastProvider and useToast', () => {
  function Trigger({ onShown }: { onShown: (id: string) => void }) {
    const toast = useToast();
    return (
      <>
        <button
          type="button"
          onClick={() => onShown(toast.show({ message: 'Hello', tone: 'info', durationMs: null }))}
        >
          Show
        </button>
        <button type="button" onClick={() => toast.dismiss('hello')}>
          Dismiss by id
        </button>
      </>
    );
  }

  it('creates its own store and exposes show and dismiss', async () => {
    const user = userEvent.setup();
    const shown: string[] = [];
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <ToastProvider>
          <Trigger onShown={(id) => shown.push(id)} />
          <Toaster />
        </ToastProvider>
      </I18nextProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(shown).toHaveLength(1);
    expect(typeof shown[0]).toBe('string');
  });

  it('dismisses by id', async () => {
    const user = userEvent.setup();
    const store = createToastStore();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <ToastProvider store={store}>
          <Trigger onShown={() => {}} />
          <Toaster />
        </ToastProvider>
      </I18nextProvider>,
    );
    act(() => {
      store.show({ id: 'hello', message: 'Hello', tone: 'info', durationMs: null });
    });
    await user.click(screen.getByRole('button', { name: 'Dismiss by id' }));
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
  });

  it('fails loudly outside a provider', () => {
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <I18nextProvider i18n={createI18n('en')}>
          <Trigger onShown={() => {}} />
        </I18nextProvider>,
      ),
    ).toThrow(/ToastProvider/);
    silence.mockRestore();
  });
});
