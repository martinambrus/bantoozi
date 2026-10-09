import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { Dialog } from '../../src/components/dialog.js';
import { ToastProvider } from '../../src/components/toast/toast-provider.js';
import { createToastStore, type ToastStore } from '../../src/components/toast/toast-store.js';
import { Toaster } from '../../src/components/toast/toaster.js';
import { createI18n } from '../../src/i18n/index.js';

type Doing = 'nothing' | 'removes the row' | 'focuses the other button';

/** A page with two buttons and a toast whose action does `doing`; the toast region follows it. */
function Page({ store, doing }: { store: ToastStore; doing: Doing }) {
  const [rowShown, setRowShown] = useState(true);
  const other = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    store.show({
      id: 'rated',
      message: 'Rated',
      tone: 'info',
      durationMs: null,
      action: {
        label: 'Undo',
        onAction: () => {
          if (doing === 'removes the row') setRowShown(false);
          if (doing === 'focuses the other button') other.current?.focus();
        },
      },
    });
  }, [store, doing]);
  return (
    <main tabIndex={-1}>
      <button type="button" ref={other}>
        Other
      </button>
      {rowShown ? <button type="button">Row</button> : null}
    </main>
  );
}

/** The same toast in a dialog, which holds the button the focus starts on. */
function DialogPage({ store, removes }: { store: ToastStore; removes: boolean }) {
  const [itemShown, setItemShown] = useState(true);
  useEffect(() => {
    store.show({
      id: 'rated',
      message: 'Rated',
      tone: 'info',
      durationMs: null,
      action: {
        label: 'Undo',
        onAction: () => {
          if (removes) setItemShown(false);
        },
      },
    });
  }, [store, removes]);
  return (
    <>
      <main tabIndex={-1}>
        <button type="button">Row</button>
      </main>
      <Dialog open onClose={() => {}} title="Rename folder">
        {itemShown ? <button type="button">Item</button> : null}
      </Dialog>
    </>
  );
}

function renderWith(ui: (store: ToastStore) => ReactNode) {
  const store = createToastStore();
  const i18n = createI18n('en');
  render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider store={store}>
        {ui(store)}
        <Toaster />
      </ToastProvider>
    </I18nextProvider>,
  );
  return { store, user: userEvent.setup() };
}

const renderPage = (doing: Doing = 'nothing') =>
  renderWith((store) => <Page store={store} doing={doing} />);

const row = () => screen.getByRole('button', { name: 'Row' });
const undo = () => screen.getByRole('button', { name: 'Undo' });
const dismiss = () => screen.getByRole('button', { name: 'Dismiss' });
const toastGone = () => expect(screen.queryByText('Rated')).not.toBeInTheDocument();

describe('the focus when a toast that holds it goes', () => {
  it('goes back to the element that had it when the action is pressed with the keyboard', async () => {
    const { user } = renderPage();
    act(() => row().focus());
    await user.tab();
    expect(undo()).toHaveFocus();

    await user.keyboard('{Enter}');

    toastGone();
    expect(row()).toHaveFocus();
  });

  it('goes back to the element that had it when the action is pressed with the mouse', async () => {
    const { user } = renderPage();
    act(() => row().focus());

    await user.click(undo());

    toastGone();
    expect(row()).toHaveFocus();
  });

  it('goes back to the element that had it when the dismiss button is pressed', async () => {
    const { user } = renderPage();
    act(() => row().focus());
    await user.tab();
    await user.tab();
    expect(dismiss()).toHaveFocus();

    await user.keyboard('{Enter}');

    toastGone();
    expect(row()).toHaveFocus();
  });

  it('goes back to where it came from, not to the toast it moved between', async () => {
    const { store, user } = renderPage();
    act(() => {
      store.show({
        id: 'second',
        message: 'Second',
        tone: 'info',
        durationMs: null,
        action: { label: 'Second action', onAction: () => {} },
      });
    });
    act(() => row().focus());
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Second action' })).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    expect(row()).toHaveFocus();
  });

  it('goes to the main landmark when the element that had it is gone', async () => {
    const { user } = renderPage('removes the row');
    act(() => row().focus());

    await user.click(undo());

    toastGone();
    expect(screen.queryByRole('button', { name: 'Row' })).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('goes to the main landmark when it came from nowhere', async () => {
    const { user } = renderPage();

    await user.click(undo());

    toastGone();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('stays where the action put it', async () => {
    const { user } = renderPage('focuses the other button');
    act(() => row().focus());

    await user.click(undo());

    toastGone();
    expect(screen.getByRole('button', { name: 'Other' })).toHaveFocus();
  });

  it('is not touched when the toast did not hold it', () => {
    renderPage();
    act(() => row().focus());

    fireEvent.click(undo());

    toastGone();
    expect(row()).toHaveFocus();
  });
});

describe('the focus when a toast in a dialog goes', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Rename folder' });

  it('goes back to the element of the dialog that had it', async () => {
    const { user } = renderWith((store) => <DialogPage store={store} removes={false} />);
    expect(within(dialog()).getByRole('button', { name: 'Item' })).toHaveFocus();

    await user.click(undo());

    toastGone();
    expect(within(dialog()).getByRole('button', { name: 'Item' })).toHaveFocus();
  });

  it('goes to the dialog when the element that had it is gone', async () => {
    const { user } = renderWith((store) => <DialogPage store={store} removes />);
    expect(within(dialog()).getByRole('button', { name: 'Item' })).toHaveFocus();

    await user.click(undo());

    toastGone();
    expect(within(dialog()).queryByRole('button', { name: 'Item' })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
