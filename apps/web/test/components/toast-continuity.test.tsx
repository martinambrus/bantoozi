import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../../src/components/dialog.js';
import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import {
  createToastStore,
  type ToastInput,
  type ToastStore,
} from '../../src/components/toast/toast-store.js';
import { Toaster } from '../../src/components/toast/toaster.js';
import { createI18n } from '../../src/i18n/index.js';

function renderApp(ui: ReactNode) {
  const store = createToastStore();
  const i18n = createI18n('en');
  const view = render(ui, {
    wrapper: ({ children }) => (
      <I18nextProvider i18n={i18n}>
        <ToastProvider store={store}>
          {children}
          <Toaster />
        </ToastProvider>
      </I18nextProvider>
    ),
  });
  return { store, ...view };
}

const modal = (open: boolean) => <Dialog open={open} onClose={() => {}} title="Rename folder" />;

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function show(store: ToastStore, input: Partial<ToastInput> = {}) {
  act(() => {
    store.show({ id: 'rated', message: 'Rated', tone: 'info', ...input });
  });
}

const undoAction = () => ({ label: 'Undo', onAction: vi.fn() });
const undoButton = () => screen.getByRole('button', { name: 'Undo' });

describe('a toast while a modal opens and closes', () => {
  it('goes at 5 s, not at 8 s, when a modal opens at 3 s', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(false));
    show(store);
    advance(3000);

    rerender(modal(true));
    expect(within(screen.getByRole('dialog')).getByText('Rated')).toBeInTheDocument();
    advance(1999);
    expect(screen.getByText('Rated')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
    advance(3000);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });

  it('goes at 5 s when the modal it was moved into closes at 3 s', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(true));
    show(store);
    advance(3000);

    rerender(modal(false));
    expect(screen.getByText('Rated')).toBeInTheDocument();
    expect(screen.getByText('Rated').closest('dialog')).toBeNull();
    advance(1999);
    expect(screen.getByText('Rated')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });

  it('spends one time in all across several moves', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(false));
    show(store);
    advance(1000);
    rerender(modal(true));
    advance(1000);
    rerender(modal(false));
    advance(1000);
    rerender(modal(true));
    advance(1999);
    expect(screen.getByText('Rated')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });

  it('stays until dismissed when it has no duration, whatever the modals do', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(false));
    show(store, { durationMs: null });
    rerender(modal(true));
    advance(10 * 60 * 1000);
    rerender(modal(false));
    advance(10 * 60 * 1000);
    expect(screen.getByText('Rated')).toBeInTheDocument();
  });

  it('starts over when it is shown again under its id in a modal', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(false));
    show(store);
    advance(3000);
    rerender(modal(true));
    show(store, { message: 'Rated again' });
    advance(4999);
    expect(screen.getByText('Rated again')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated again')).not.toBeInTheDocument();
  });

  it('can still be dismissed from the modal it moved into', async () => {
    const user = userEvent.setup();
    const { store, rerender } = renderApp(modal(false));
    show(store, { durationMs: null });
    rerender(modal(true));

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe('the focus in a toast while a modal opens', () => {
  it('stays on a toast action, which is now in the modal', async () => {
    const user = userEvent.setup();
    const action = undoAction();
    const { store, rerender } = renderApp(modal(false));
    show(store, { durationMs: null, action });
    act(() => undoButton().focus());
    expect(undoButton()).toHaveFocus();

    rerender(modal(true));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Undo' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(action.onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });

  it('stays on the very control that had it', () => {
    const { store, rerender } = renderApp(modal(false));
    show(store, { durationMs: null, action: undoAction() });
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());

    rerender(modal(true));
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss' }),
    ).toHaveFocus();
  });

  it('follows a toast from one modal into the next', () => {
    const { store, rerender } = renderApp(
      <>
        {modal(true)}
        <Dialog open={false} onClose={() => {}} title="Second" />
      </>,
    );
    show(store, { durationMs: null, action: undoAction() });
    act(() => undoButton().focus());

    rerender(
      <>
        {modal(true)}
        <Dialog open onClose={() => {}} title="Second" />
      </>,
    );
    expect(
      within(screen.getByRole('dialog', { name: 'Second' })).getByRole('button', { name: 'Undo' }),
    ).toHaveFocus();
  });

  it('leaves the modal its usual first focus when no toast had the focus', () => {
    const { store, rerender } = renderApp(
      <>
        <button type="button">Page</button>
        {modal(false)}
      </>,
    );
    show(store, { durationMs: null, action: undoAction() });
    act(() => screen.getByRole('button', { name: 'Page' }).focus());

    rerender(
      <>
        <button type="button">Page</button>
        {modal(true)}
      </>,
    );
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('does not pull the focus into a modal that opens after the toast went away', async () => {
    const user = userEvent.setup();
    const { store, rerender } = renderApp(modal(false));
    show(store, { durationMs: null, action: undoAction() });
    await user.click(undoButton());
    expect(store.getSnapshot()).toEqual([]);

    show(store, { id: 'later', message: 'Later', durationMs: null, action: undoAction() });
    rerender(modal(true));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('keeps the countdown paused, then finishes the time that was left', () => {
    vi.useFakeTimers();
    const { store, rerender } = renderApp(modal(false));
    show(store, { action: undoAction() });
    advance(3000);
    act(() => undoButton().focus());
    advance(60_000);
    expect(screen.getByText('Rated')).toBeInTheDocument();

    rerender(modal(true));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo' })).toHaveFocus();
    advance(60_000);
    expect(screen.getByText('Rated')).toBeInTheDocument();

    act(() => (document.activeElement as HTMLElement).blur());
    advance(1999);
    expect(screen.getByText('Rated')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('Rated')).not.toBeInTheDocument();
  });
});
