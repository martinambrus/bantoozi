import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Sheet } from '../../src/components/sheet.js';
import { ArticleRow } from '../../src/features/article/article-row.js';
import { makeItem, renderReader } from './harness.js';

const ITEM = makeItem();

const apps: { unhandled: string[] }[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) expect(app.unhandled).toEqual([]);
});

function Page({ modal }: { modal: boolean }) {
  return (
    <>
      <ArticleRow item={ITEM} expanded={false} onToggleExpand={() => {}} simple={false} />
      <Sheet open={modal} onClose={() => {}} title="Article" side="bottom">
        <p>Details</p>
      </Sheet>
    </>
  );
}

function renderPage() {
  const app = renderReader(<Page modal={false} />);
  apps.push(app);
  return app;
}

const bar = () => screen.getByRole('group', { name: 'Reason for the dislike' });

describe('the focus in the reason bar while a modal opens', () => {
  it.each(['Clickbait', 'Other', 'Undo'])(
    'stays on the %s button, which is now in the modal',
    (name) => {
      const { rerender } = renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Dislike' }));
      act(() => within(bar()).getByRole('button', { name }).focus());
      expect(within(bar()).getByRole('button', { name })).toHaveFocus();

      rerender(<Page modal />);

      const dialog = screen.getByRole('dialog', { name: 'Article' });
      expect(within(dialog).getByRole('group', { name: 'Reason for the dislike' })).toBeVisible();
      expect(within(dialog).getByRole('button', { name })).toHaveFocus();
    },
  );

  it('leaves the modal its usual first focus when the bar had none', () => {
    const { rerender } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Dislike' }));

    rerender(<Page modal />);

    const dialog = screen.getByRole('dialog', { name: 'Article' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
