import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { Dialog } from '../../src/components/dialog.js';
import { Sheet } from '../../src/components/sheet.js';
import { createI18n } from '../../src/i18n/index.js';

type Target = 'list' | 'nothing' | 'unfocusable' | undefined;

/**
 * A list of rows that each open an editor. Saving closes the editor, and renaming the rows gives
 * them new keys, so the row that opened the editor is replaced by another one.
 */
function Page({
  target,
  expose,
  renameWithSave = false,
}: {
  target?: Target;
  expose?: (rename: () => void) => void;
  renameWithSave?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState(['alpha', 'beta']);
  const list = useRef<HTMLUListElement>(null);
  const rename = useCallback(() => setNames((current) => current.map((name) => `${name}!`)), []);

  useEffect(() => {
    expose?.(rename);
  }, [expose, rename]);

  const returnFocus = {
    list: () => list.current,
    nothing: () => null,
    unfocusable: () => document.getElementById('plain'),
    none: undefined,
  }[target ?? 'none'];

  return (
    <>
      <button type="button">Before</button>
      <main tabIndex={-1}>
        <ul ref={list} tabIndex={-1} aria-label="Names">
          {names.map((name) => (
            <li key={name}>
              <button type="button" onClick={() => setOpen(true)}>
                {`Edit ${name}`}
              </button>
            </li>
          ))}
        </ul>
        <div id="plain">Not a control</div>
      </main>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Edit name"
        returnFocus={returnFocus}
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            if (renameWithSave) rename();
          }}
        >
          Save
        </button>
      </Dialog>
    </>
  );
}

function renderPage(props: Parameters<typeof Page>[0] = {}) {
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <Page {...props} />
    </I18nextProvider>,
  );
  return user;
}

async function saveFrom(user: ReturnType<typeof userEvent.setup>, row = 'Edit alpha') {
  await user.click(screen.getByRole('button', { name: row }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}

const list = () => screen.getByRole('list', { name: 'Names' });

describe('the focus when a modal closes', () => {
  it('goes back to the element that opened it', async () => {
    const user = renderPage({ target: 'list' });
    await user.click(screen.getByRole('button', { name: 'Edit beta' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Edit beta' })).toHaveFocus();
  });

  it('goes to the element returnFocus names when the opener is gone', async () => {
    const user = renderPage({ target: 'list', renameWithSave: true });
    await saveFrom(user);
    expect(screen.queryByRole('button', { name: 'Edit alpha' })).not.toBeInTheDocument();
    expect(list()).toHaveFocus();
  });

  it('goes to the main landmark when the opener is gone and returnFocus is not given', async () => {
    const user = renderPage({ renameWithSave: true });
    await saveFrom(user);
    expect(screen.getByRole('main')).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it.each(['nothing', 'unfocusable'] as const)(
    'goes to the main landmark when returnFocus names %s',
    async (target) => {
      const user = renderPage({ target, renameWithSave: true });
      await saveFrom(user);
      expect(screen.getByRole('main')).toHaveFocus();
    },
  );

  it('leaves a focus that the page put elsewhere itself as the modal closed', async () => {
    function Elsewhere() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      const picked = useRef<HTMLButtonElement>(null);
      useLayoutEffect(() => {
        if (gone) picked.current?.focus();
      }, [gone]);
      return (
        <>
          <button type="button" ref={picked}>
            Picked by the page
          </button>
          <main tabIndex={-1}>
            {gone ? null : (
              <button type="button" onClick={() => setOpen(true)}>
                Edit
              </button>
            )}
          </main>
          <Dialog open={open} onClose={() => setOpen(false)} title="Edit name">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setGone(true);
              }}
            >
              Save
            </button>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <Elsewhere />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Picked by the page' })).toHaveFocus();
  });

  it('stays inside the modal that is still open when the opener of an inner one is gone', async () => {
    function Nested() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <>
          <main tabIndex={-1}>
            <button type="button" onClick={() => setOuter(true)}>
              Open outer
            </button>
          </main>
          <Dialog open={outer} onClose={() => setOuter(false)} title="Outer">
            {gone ? null : (
              <button type="button" onClick={() => setInner(true)}>
                Open inner
              </button>
            )}
            <Dialog open={inner} onClose={() => setInner(false)} title="Inner">
              <button
                type="button"
                onClick={() => {
                  setInner(false);
                  setGone(true);
                }}
              >
                Remove and close
              </button>
            </Dialog>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <Nested />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    await user.click(screen.getByRole('button', { name: 'Remove and close' }));

    const outer = screen.getByRole('dialog', { name: 'Outer' });
    expect(outer).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('main')).not.toHaveFocus();
  });

  it('works for a sheet too', async () => {
    function SheetPage() {
      const [open, setOpen] = useState(false);
      const [shown, setShown] = useState(true);
      return (
        <>
          <main tabIndex={-1}>
            {shown ? (
              <button type="button" onClick={() => setOpen(true)}>
                Why this?
              </button>
            ) : null}
          </main>
          <Sheet open={open} onClose={() => setOpen(false)} title="Explanation">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setShown(false);
              }}
            >
              Remove it
            </button>
          </Sheet>
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <SheetPage />
      </I18nextProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Why this?' }));
    await user.click(screen.getByRole('button', { name: 'Remove it' }));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  describe('when the opener goes only after the modal has closed', () => {
    it('moves the focus on to returnFocus, or to the main landmark', async () => {
      let rename = () => {};
      const user = renderPage({ target: 'list', expose: (next) => (rename = next) });
      await saveFrom(user);
      expect(screen.getByRole('button', { name: 'Edit alpha' })).toHaveFocus();

      act(() => rename());
      await waitFor(() => expect(list()).toHaveFocus());
    });

    it('falls back to the main landmark without returnFocus', async () => {
      let rename = () => {};
      const user = renderPage({ expose: (next) => (rename = next) });
      await saveFrom(user);

      act(() => rename());
      await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
    });

    it('leaves the focus where the person has put it since', async () => {
      let rename = () => {};
      const user = renderPage({ target: 'list', expose: (next) => (rename = next) });
      await saveFrom(user);
      await user.click(screen.getByRole('button', { name: 'Before' }));

      act(() => rename());
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    });
  });
});
