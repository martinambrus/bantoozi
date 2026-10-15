import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '../../src/components/tooltip.js';

function renderTooltip() {
  render(
    <Tooltip text="Explains the button">
      {(props) => (
        <button type="button" {...props}>
          Go
        </button>
      )}
    </Tooltip>,
  );
  return { user: userEvent.setup(), button: screen.getByRole('button', { name: 'Go' }) };
}

describe('Tooltip', () => {
  it('describes its trigger and stays hidden until it is wanted', () => {
    const { button } = renderTooltip();

    expect(button).toHaveAccessibleDescription('Explains the button');
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });

  it('shows on hover and hides when the pointer leaves', async () => {
    const { user, button } = renderTooltip();

    await user.hover(button);
    expect(screen.getByRole('tooltip')).toBeVisible();
    await user.unhover(button);
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });

  it('shows on keyboard focus and hides on blur', async () => {
    const { user } = renderTooltip();

    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Explains the button');
    await user.tab();
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });

  it('hides on Escape while the trigger keeps the focus', async () => {
    const { user, button } = renderTooltip();

    await user.tab();
    await user.keyboard('{Escape}');

    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
    expect(button).toHaveFocus();
  });

  describe('placement', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockTrigger(rect: { left: number; right: number; top: number }) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        ...rect,
        bottom: rect.top + 20,
        width: rect.right - rect.left,
        height: 20,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      });
    }

    it('sits fixed to the right of the trigger, top aligned', async () => {
      mockTrigger({ left: 200, right: 240, top: 100 });
      const { user, button } = renderTooltip();

      await user.hover(button);

      const tip = screen.getByRole('tooltip');
      expect(tip.style.left).toBe('248px');
      expect(tip.style.top).toBe('100px');
      expect(tip).toHaveClass('fixed');
    });

    it('flips to the left of the trigger near the right edge of the viewport', async () => {
      mockTrigger({ left: window.innerWidth - 60, right: window.innerWidth - 20, top: 50 });
      const { user, button } = renderTooltip();

      await user.hover(button);

      expect(screen.getByRole('tooltip').style.left).toBe(`${window.innerWidth - 60 - 8 - 256}px`);
    });
  });
});

describe('Tooltip layering', () => {
  it('renders its bubble at the end of the body, out of the trigger’s stacking context', () => {
    render(
      <div style={{ position: 'relative', zIndex: 1, overflow: 'auto' }} data-testid="sidebar">
        <Tooltip text="Explains it">
          {(props) => (
            <button type="button" {...props}>
              Trigger
            </button>
          )}
        </Tooltip>
      </div>,
    );
    const bubble = screen.getByRole('tooltip', { hidden: true });
    expect(bubble.parentElement).toBe(document.body);
    expect(screen.getByTestId('sidebar')).not.toContainElement(bubble);
    expect(screen.getByRole('button', { name: 'Trigger' })).toHaveAccessibleDescription(
      'Explains it',
    );
  });

  it('stays inside the dialog that holds its trigger, which sits in the top layer', async () => {
    const { rerender } = render(
      <dialog open data-testid="sheet">
        <Tooltip text="Explains it">
          {(props) => (
            <button type="button" {...props}>
              Trigger
            </button>
          )}
        </Tooltip>
      </dialog>,
    );
    // The host is found once the trigger is in the document: the next render places the bubble.
    rerender(
      <dialog open data-testid="sheet">
        <Tooltip text="Explains it">
          {(props) => (
            <button type="button" {...props}>
              Trigger
            </button>
          )}
        </Tooltip>
      </dialog>,
    );
    await userEvent.setup().hover(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByTestId('sheet')).toContainElement(screen.getByRole('tooltip'));
  });
});
