import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/api/errors.js';
import { ConfirmDialog } from '../../src/components/confirm-dialog.js';
import { Dialog } from '../../src/components/dialog.js';
import { Sheet } from '../../src/components/sheet.js';
import { createI18n, type Language } from '../../src/i18n/index.js';

function renderWithI18n(ui: ReactNode, language: Language = 'en') {
  return render(<I18nextProvider i18n={createI18n(language)}>{ui}</I18nextProvider>);
}

function DialogHarness({
  children,
  showCloseButton,
}: {
  children?: ReactNode;
  showCloseButton?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Rename folder"
        {...(showCloseButton === undefined ? {} : { showCloseButton })}
      >
        {children}
      </Dialog>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    renderWithI18n(<Dialog open={false} onClose={() => {}} title="Rename folder" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('opens with showModal, which makes the rest of the page inert, and closes the native dialog', async () => {
    const user = userEvent.setup();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    renderWithI18n(<DialogHarness>Just text.</DialogHarness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens as a modal dialog named by its title', async () => {
    const user = userEvent.setup();
    renderWithI18n(<DialogHarness>Pick a new name.</DialogHarness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const dialog = screen.getByRole('dialog', { name: 'Rename folder' });
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveTextContent('Pick a new name.');
    expect(screen.getByRole('heading', { name: 'Rename folder' })).toBeInTheDocument();
  });

  it('focuses the first focusable element when it opens', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <DialogHarness>
        <label>
          Name
          <input />
        </label>
        <button type="button">Save</button>
      </DialogHarness>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('focuses the close button when the content has nothing focusable', async () => {
    const user = userEvent.setup();
    renderWithI18n(<DialogHarness>Just text.</DialogHarness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('focuses the dialog itself when nothing inside is focusable', async () => {
    const user = userEvent.setup();
    renderWithI18n(<DialogHarness showCloseButton={false}>Just text.</DialogHarness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the element focused before opening', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <DialogHarness>
        <input aria-label="Name" />
      </DialogHarness>,
    );
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(opener).not.toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes with its close button and restores focus', async () => {
    const user = userEvent.setup();
    renderWithI18n(<DialogHarness>Just text.</DialogHarness>);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('treats the native cancel event as a close request', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithI18n(
      <Dialog open onClose={onClose} title="Rename folder">
        text
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('labels the close button in Slovak', async () => {
    const user = userEvent.setup();
    renderWithI18n(<DialogHarness>Len text.</DialogHarness>, 'sk');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      screen.getByRole('button', { name: createI18n('sk').t('common:actions.close') }),
    ).toBeInTheDocument();
  });
});

describe('Sheet', () => {
  function SheetHarness({ side }: { side?: 'right' | 'bottom' | 'auto' }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open sheet
        </button>
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          title="Why this?"
          {...(side === undefined ? {} : { side })}
        >
          <button type="button">Not really about this</button>
        </Sheet>
      </>
    );
  }

  it('has the dialog semantics: title, first focus, Escape, focus restore', async () => {
    const user = userEvent.setup();
    renderWithI18n(<SheetHarness />);
    const opener = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(opener);

    expect(screen.getByRole('dialog', { name: 'Why this?' })).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Not really about this' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('restores focus after the close button too', async () => {
    const user = userEvent.setup();
    renderWithI18n(<SheetHarness />);
    const opener = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each(['right', 'bottom'] as const)('docks to the %s when asked', async (side) => {
    const user = userEvent.setup();
    renderWithI18n(<SheetHarness side={side} />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-side', side);
  });

  it('is automatic by default: right from the lg breakpoint, bottom below it', async () => {
    const user = userEvent.setup();
    renderWithI18n(<SheetHarness />);
    await user.click(screen.getByRole('button', { name: 'Open sheet' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-side', 'auto');
    const classes = dialog.className.split(/\s+/);
    expect(classes).toContain('lg:right-0');
    expect(classes).toContain('max-lg:bottom-0');
  });
});

describe('ConfirmDialog', () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function renderConfirm(props: Partial<ComponentProps<typeof ConfirmDialog>> = {}) {
    const onClose = vi.fn();
    const onConfirm = props.onConfirm ?? vi.fn();
    renderWithI18n(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Delete label?"
        body="Articles keep their other labels."
        confirmLabel="Delete label"
        cancelLabel="Keep it"
        {...props}
        onConfirm={onConfirm}
      />,
    );
    return { onClose, onConfirm };
  }

  it('shows the title, body and labels, with focus on the safe choice', () => {
    renderConfirm();
    const dialog = screen.getByRole('dialog', { name: 'Delete label?' });
    expect(dialog).toHaveAccessibleDescription('Articles keep their other labels.');
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete label' })).toBeEnabled();
  });

  it('falls back to the common confirm and cancel labels', () => {
    renderWithI18n(<ConfirmDialog open onClose={() => {}} onConfirm={() => {}} title="Sure?" />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('marks a dangerous confirmation', () => {
    renderConfirm({ danger: true });
    expect(screen.getByRole('button', { name: 'Delete label' })).toHaveAttribute(
      'data-variant',
      'danger',
    );
  });

  it('cancels without confirming', async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderConfirm();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes after a synchronous confirmation', async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderConfirm();
    await user.click(screen.getByRole('button', { name: 'Delete label' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows a pending state until an async confirmation settles, then closes', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const { onClose, onConfirm } = renderConfirm({ onConfirm: vi.fn(() => pending.promise) });
    await user.click(screen.getByRole('button', { name: 'Delete label' }));

    const confirm = screen.getByRole('button', { name: 'Delete label' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('dialog'), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('stays open with the localized error when the confirmation fails', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const { onClose } = renderConfirm({ onConfirm: vi.fn(() => pending.promise) });
    await user.click(screen.getByRole('button', { name: 'Delete label' }));

    pending.reject(
      new ApiError({ kind: 'http', status: 403, code: 'FORBIDDEN', message: 'forbidden' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(createI18n('en').t('common:errors.FORBIDDEN'));
    expect(onClose).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Delete label' });
    expect(confirm).toBeEnabled();
    expect(confirm).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus());
  });

  it('closes on Escape while idle', async () => {
    const user = userEvent.setup();
    const { onClose } = renderConfirm();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
