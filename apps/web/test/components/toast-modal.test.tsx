import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../../src/components/confirm-dialog.js';
import { Dialog } from '../../src/components/dialog.js';
import { Sheet } from '../../src/components/sheet.js';
import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import { createToastStore, type ToastStore } from '../../src/components/toast/toast-store.js';
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

function showSticky(store: ToastStore, message: string) {
  act(() => {
    store.show({ message, tone: 'info', durationMs: null });
  });
}

function theRegion() {
  expect(screen.getAllByRole('status')).toHaveLength(1);
  return screen.getByRole('status');
}

function modal(name: string) {
  return screen.getByRole('dialog', { name });
}

describe('the toaster while a modal is open', () => {
  it('keeps its one live region inside the open dialog, with or without a toast', () => {
    const { store } = renderApp(<Dialog open onClose={() => {}} title="Rename folder" />);
    const region = theRegion();
    expect(region.closest('dialog')).toBe(modal('Rename folder'));

    showSticky(store, 'Saved');
    expect(theRegion()).toBe(region);
    expect(region.closest('dialog')).toBe(modal('Rename folder'));
    expect(region).toHaveTextContent('Saved');
    expect(modal('Rename folder')).toContainElement(screen.getByText('Saved'));
  });

  it('carries the toasts on screen into a dialog that opens, and back to the page when it closes', () => {
    const { store, rerender } = renderApp(
      <Dialog open={false} onClose={() => {}} title="Rename folder" />,
    );
    showSticky(store, 'Saved');
    expect(theRegion().closest('dialog')).toBeNull();

    rerender(<Dialog open onClose={() => {}} title="Rename folder" />);
    expect(theRegion().closest('dialog')).toBe(modal('Rename folder'));
    expect(theRegion()).toHaveTextContent('Saved');

    rerender(<Dialog open={false} onClose={() => {}} title="Rename folder" />);
    expect(theRegion().closest('dialog')).toBeNull();
    expect(theRegion()).toHaveTextContent('Saved');
  });

  it('keeps the actions of a toast in the dialog working', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const { store } = renderApp(<Dialog open onClose={() => {}} title="Rename folder" />);
    act(() => {
      store.show({
        message: 'Moved',
        tone: 'info',
        durationMs: null,
        action: { label: 'Undo', onAction },
      });
    });

    await user.click(within(modal('Rename folder')).getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Moved')).not.toBeInTheDocument();
  });

  it('follows the topmost of nested modals and falls back to the one below as they close', async () => {
    function Stacked() {
      const [sheetOpen, setSheetOpen] = useState(true);
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Why this?">
          <button type="button" onClick={() => setConfirmOpen(true)}>
            Remove it
          </button>
          <ConfirmDialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => {}}
            title="Remove it?"
          />
        </Sheet>
      );
    }
    const user = userEvent.setup();
    const { store } = renderApp(<Stacked />);
    expect(theRegion().closest('dialog')).toBe(modal('Why this?'));

    await user.click(screen.getByRole('button', { name: 'Remove it' }));
    showSticky(store, 'Heads up');
    expect(theRegion().closest('dialog')).toBe(modal('Remove it?'));
    expect(theRegion()).toHaveTextContent('Heads up');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Remove it?' })).not.toBeInTheDocument();
    expect(theRegion().closest('dialog')).toBe(modal('Why this?'));
    expect(theRegion()).toHaveTextContent('Heads up');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(theRegion().closest('dialog')).toBeNull();
    expect(theRegion()).toHaveTextContent('Heads up');
  });

  it('follows the most recently opened modal, wherever it sits in the tree', () => {
    function Pair({ first, second }: { first: boolean; second: boolean }) {
      return (
        <>
          <Dialog open={first} onClose={() => {}} title="First" />
          <Dialog open={second} onClose={() => {}} title="Second" />
        </>
      );
    }
    const { rerender } = renderApp(<Pair first={false} second={false} />);
    expect(theRegion().closest('dialog')).toBeNull();

    rerender(<Pair first={false} second />);
    expect(theRegion().closest('dialog')).toBe(modal('Second'));

    rerender(<Pair first second />);
    expect(theRegion().closest('dialog')).toBe(modal('First'));

    rerender(<Pair first={false} second />);
    expect(theRegion().closest('dialog')).toBe(modal('Second'));

    rerender(<Pair first second />);
    expect(theRegion().closest('dialog')).toBe(modal('First'));

    rerender(<Pair first second={false} />);
    expect(theRegion().closest('dialog')).toBe(modal('First'));

    rerender(<Pair first={false} second={false} />);
    expect(theRegion().closest('dialog')).toBeNull();
  });
});

describe('a modal without a ToastProvider', () => {
  it('opens and closes as before', () => {
    const i18n = createI18n('en');
    const ui = (open: boolean) => (
      <I18nextProvider i18n={i18n}>
        <Dialog open={open} onClose={() => {}} title="Rename folder" />
      </I18nextProvider>
    );
    const { rerender } = render(ui(true));
    expect(modal('Rename folder')).toHaveAttribute('open');

    rerender(ui(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
