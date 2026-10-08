import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../../src/components/dialog.js';
import { IconButton } from '../../src/components/icon-button.js';
import { MoreIcon } from '../../src/components/icons.js';
import { Menu, MenuItem } from '../../src/components/menu.js';
import { createI18n } from '../../src/i18n/index.js';

function renderMenu() {
  const onRename = vi.fn();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <button type="button">Before</button>
      <Menu
        header={<p>Signed in as Ada</p>}
        trigger={(props) => (
          <IconButton {...props} label="More actions">
            <MoreIcon />
          </IconButton>
        )}
      >
        <MenuItem onSelect={onRename}>Rename</MenuItem>
        <MenuItem disabled onSelect={onArchive}>
          Archive
        </MenuItem>
        <MenuItem tone="danger" onSelect={onDelete}>
          Delete
        </MenuItem>
      </Menu>
      <button type="button">After</button>
    </I18nextProvider>,
  );
  return { onRename, onArchive, onDelete };
}

const trigger = () => screen.getByRole('button', { name: 'More actions' });
const focusedItemName = () => (document.activeElement as HTMLElement).textContent;

describe('Menu', () => {
  it('has a trigger that announces the popup and its state', async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'More actions' });
    expect(trigger()).toHaveAttribute('aria-controls', menu.id);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Rename', 'Archive', 'Delete']);
  });

  it('puts the header outside the menu role and focuses the first item on click', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    expect(screen.getByText('Signed in as Ada')).toBeVisible();
    expect(within(screen.getByRole('menu')).queryByText('Signed in as Ada')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
  });

  it('opens from the trigger with ArrowDown (first item) and ArrowUp (last item)', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.tab();
    await user.tab();
    expect(trigger()).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger()).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
  });

  it('moves focus with the arrow keys, wrapping and skipping disabled items', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    expect(focusedItemName()).toBe('Rename');

    await user.keyboard('{ArrowDown}');
    expect(focusedItemName()).toBe('Delete');
    await user.keyboard('{ArrowDown}');
    expect(focusedItemName()).toBe('Rename');
    await user.keyboard('{ArrowUp}');
    expect(focusedItemName()).toBe('Delete');
    await user.keyboard('{ArrowUp}');
    expect(focusedItemName()).toBe('Rename');
  });

  it('jumps to the first and last enabled item with Home and End', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.keyboard('{End}');
    expect(focusedItemName()).toBe('Delete');
    await user.keyboard('{Home}');
    expect(focusedItemName()).toBe('Rename');
  });

  it('activates the focused item with Enter, closes and refocuses the trigger', async () => {
    const user = userEvent.setup();
    const { onRename, onDelete } = renderMenu();
    await user.click(trigger());
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('activates the focused item with Space', async () => {
    const user = userEvent.setup();
    const { onRename } = renderMenu();
    await user.click(trigger());
    await user.keyboard(' ');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('activates an item on click', async () => {
    const user = userEvent.setup();
    const { onDelete } = renderMenu();
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('never activates a disabled item', async () => {
    const user = userEvent.setup();
    const { onArchive } = renderMenu();
    await user.click(trigger());
    const archive = screen.getByRole('menuitem', { name: 'Archive' });
    expect(archive).toBeDisabled();
    await user.click(archive);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('closes on Escape and refocuses the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Tab and keeps focus on the trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes on an outside click without taking focus back', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('stays open when the click lands inside it, and closes when the trigger is clicked again', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(trigger());
    await user.click(screen.getByText('Signed in as Ada'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(trigger());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('can be closed from the trigger when no item can take the focus', async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <Menu
          trigger={(props) => (
            <IconButton {...props} label="More actions">
              <MoreIcon />
            </IconButton>
          )}
        >
          <MenuItem disabled onSelect={() => {}}>
            Archive
          </MenuItem>
        </Menu>
      </I18nextProvider>,
    );
    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes only the menu when Escape is pressed inside a dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <I18nextProvider i18n={createI18n('en')}>
        <Dialog open onClose={onClose} title="Settings">
          <Menu
            trigger={(props) => (
              <IconButton {...props} label="More actions">
                <MoreIcon />
              </IconButton>
            )}
          >
            <MenuItem onSelect={() => {}}>Rename</MenuItem>
          </Menu>
        </Dialog>
      </I18nextProvider>,
    );
    await user.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
