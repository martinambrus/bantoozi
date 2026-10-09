import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { cardsKey } from '../../src/features/interests/queries.js';
import { USER_A_ID } from '../session/fixtures.js';
import { HELD, checkUnhandled, renderDrawer } from './support.js';

checkUnhandled();

describe('the focus after an editor opened from the drawer closes', () => {
  it('goes to the list of interests when the Edit button that opened it is gone', async () => {
    const app = await renderDrawer();
    const row = app.panel.getByRole('listitem', { name: 'EV battery tech' });
    await app.user.click(within(row).getByRole('button', { name: 'Edit card' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit interest card' });
    act(() => {
      app.queryClient.setQueryData(
        cardsKey(USER_A_ID),
        HELD.filter((card) => card.id !== '31'),
      );
    });
    await waitFor(() =>
      expect(within(row).queryByRole('button', { name: 'Edit card' })).toBeNull(),
    );

    await app.user.click(within(editor).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog', { name: 'Edit interest card' })).toBeNull();
    expect(app.panel.getByRole('list', { name: 'Your interests' })).toHaveFocus();
  });

  it('goes to the row of actions when the button that opened the new card is gone', async () => {
    const app = await renderDrawer();
    const opener = app.panel.getByRole('button', { name: 'Make a card from this' });
    const actions = opener.parentElement!;
    const next = opener.nextSibling;
    await app.user.click(opener);
    const editor = await screen.findByRole('dialog', { name: 'New card from this article' });
    opener.remove();

    try {
      await app.user.click(within(editor).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog', { name: 'New card from this article' })).toBeNull();
      expect(actions).toHaveFocus();
    } finally {
      actions.insertBefore(opener, next);
    }
  });
});
