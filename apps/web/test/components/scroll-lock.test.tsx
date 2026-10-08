import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfirmDialog } from '../../src/components/confirm-dialog.js';
import { Dialog } from '../../src/components/dialog.js';
import { lockScroll } from '../../src/components/scroll-lock.js';
import { Sheet } from '../../src/components/sheet.js';
import { createI18n } from '../../src/i18n/index.js';

const html = document.documentElement;
const i18n = createI18n('en');
const noop = () => {};
const held: Array<() => void> = [];

function lock() {
  const release = lockScroll();
  held.push(release);
  return release;
}

afterEach(() => {
  cleanup();
  for (const release of held.splice(0)) release();
  html.style.overflow = '';
});

type Kind = 'dialog' | 'sheet' | 'confirm';

function Modals({ open = [] }: { open?: readonly Kind[] }) {
  return (
    <I18nextProvider i18n={i18n}>
      <Dialog open={open.includes('dialog')} onClose={noop} title="Rename folder" />
      <Sheet open={open.includes('sheet')} onClose={noop} title="Why this?" />
      <ConfirmDialog
        open={open.includes('confirm')}
        onClose={noop}
        onConfirm={noop}
        title="Remove it?"
      />
    </I18nextProvider>
  );
}

describe('the page scroll while a modal is open', () => {
  it.each(['', 'scroll'])('is locked, then restored to %j', (before) => {
    html.style.overflow = before;
    const { rerender } = render(<Modals />);
    expect(html.style.overflow).toBe(before);

    rerender(<Modals open={['dialog']} />);
    expect(html.style.overflow).toBe('hidden');

    rerender(<Modals />);
    expect(html.style.overflow).toBe(before);
  });

  it.each(['dialog', 'sheet', 'confirm'] as const)('is locked by a %s', (kind) => {
    const { rerender } = render(<Modals />);
    rerender(<Modals open={[kind]} />);
    expect(html.style.overflow).toBe('hidden');

    rerender(<Modals />);
    expect(html.style.overflow).toBe('');
  });

  it.each(['', 'scroll'])('stays locked until the last of two modals closes, from %j', (before) => {
    html.style.overflow = before;
    const { rerender } = render(<Modals />);

    rerender(<Modals open={['dialog', 'sheet']} />);
    rerender(<Modals open={['sheet']} />);
    expect(html.style.overflow).toBe('hidden');
    rerender(<Modals />);
    expect(html.style.overflow).toBe(before);

    rerender(<Modals open={['dialog', 'sheet']} />);
    rerender(<Modals open={['dialog']} />);
    expect(html.style.overflow).toBe('hidden');
    rerender(<Modals />);
    expect(html.style.overflow).toBe(before);
  });

  it.each(['', 'scroll'])(
    'is restored when the whole tree unmounts while open, from %j',
    (before) => {
      html.style.overflow = before;
      const { unmount } = render(<Modals open={['dialog', 'sheet']} />);
      expect(html.style.overflow).toBe('hidden');

      unmount();
      expect(html.style.overflow).toBe(before);
    },
  );
});

describe('lockScroll', () => {
  it.each(['', 'scroll'])('saves %j, hides the overflow and gives it back on release', (before) => {
    html.style.overflow = before;
    const release = lock();
    expect(html.style.overflow).toBe('hidden');

    release();
    expect(html.style.overflow).toBe(before);
  });

  it('counts its holders: the last release restores, whatever the order', () => {
    html.style.overflow = 'scroll';
    const first = lock();
    const second = lock();
    const third = lock();

    second();
    first();
    expect(html.style.overflow).toBe('hidden');
    third();
    expect(html.style.overflow).toBe('scroll');
  });

  it('ignores a release called twice, and keeps counting correctly afterwards', () => {
    html.style.overflow = 'scroll';
    const first = lock();
    const second = lock();

    first();
    first();
    expect(html.style.overflow).toBe('hidden');

    second();
    second();
    expect(html.style.overflow).toBe('scroll');

    html.style.overflow = '';
    const again = lock();
    expect(html.style.overflow).toBe('hidden');
    again();
    expect(html.style.overflow).toBe('');
  });
});
