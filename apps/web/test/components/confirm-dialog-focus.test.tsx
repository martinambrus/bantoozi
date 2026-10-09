import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { ConfirmDialog } from '../../src/components/confirm-dialog.js';
import { createI18n } from '../../src/i18n/index.js';

/** A list whose rows each ask to be deleted; confirming removes the row that asked. */
function Page() {
  const [names, setNames] = useState(['alpha', 'beta']);
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);

  return (
    <>
      <main tabIndex={-1}>
        <ul ref={list} tabIndex={-1} aria-label="Names">
          {names.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => setDeleting(name)}>
                {`Delete ${name}`}
              </button>
            </li>
          ))}
        </ul>
      </main>
      <ConfirmDialog
        open={deleting !== null}
        danger
        title="Delete this name?"
        confirmLabel="Delete"
        returnFocus={() => list.current}
        onClose={() => setDeleting(null)}
        onConfirm={() => setNames((current) => current.filter((name) => name !== deleting))}
      />
    </>
  );
}

function renderPage() {
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <Page />
    </I18nextProvider>,
  );
  return user;
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

describe('the focus when a confirmation closes', () => {
  it('goes to the element returnFocus names when the row that asked is gone', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete alpha' }));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await closed();

    expect(screen.queryByRole('button', { name: 'Delete alpha' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Names' })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('goes back to the button that asked when nothing was deleted', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('button', { name: 'Delete beta' }));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await closed();

    expect(screen.getByRole('button', { name: 'Delete beta' })).toHaveFocus();
  });
});
