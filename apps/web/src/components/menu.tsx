import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { FOCUS_RING, cx } from './cx.js';

/** Spread these onto the element that opens the menu (a button). */
export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
  trigger: (props: MenuTriggerProps) => ReactNode;
  /** Shown above the items, outside the menu role (an account name, for instance). */
  header?: ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end' | undefined;
  children: ReactNode;
}

const MenuContext = createContext<{ close: () => void } | null>(null);

function menuItems(panel: HTMLElement | null): HTMLElement[] {
  return Array.from(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

/**
 * A menu button (WAI-ARIA menu button pattern): the arrow keys, Home and End move between the
 * items (a disabled one included, so a keyboard can reach and read it), Enter or Space activate
 * one, and Escape or Tab close the menu and refocus the trigger. A press outside closes it and
 * leaves the focus where the user put it.
 */
export function Menu({ trigger, header, align = 'start', children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [initialFocus, setInitialFocus] = useState<'first' | 'last'>('first');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const items = menuItems(panelRef.current);
    (initialFocus === 'last' ? items[items.length - 1] : items[0])?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, initialFocus]);

  function openAt(which: 'first' | 'last') {
    if (open) {
      const items = menuItems(panelRef.current);
      (which === 'last' ? items[items.length - 1] : items[0])?.focus();
      return;
    }
    setInitialFocus(which);
    setOpen(true);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openAt(event.key === 'ArrowDown' ? 'first' : 'last');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    const items = menuItems(panelRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = items[(current + 1) % items.length];
        break;
      case 'ArrowUp':
        target = items[current <= 0 ? items.length - 1 : current - 1];
        break;
      case 'Home':
        target = items[0];
        break;
      case 'End':
        target = items[items.length - 1];
        break;
      case 'Escape':
        // A prevented Escape is not a close request for a dialog around the menu.
        event.preventDefault();
        close();
        return;
      case 'Tab':
        event.preventDefault();
        close();
        return;
      default:
        return;
    }
    event.preventDefault();
    target?.focus();
  }

  const context = useMemo(() => ({ close }), [close]);

  return (
    <div ref={rootRef} className="relative inline-block">
      {trigger({
        ref: triggerRef,
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: () => (open ? close() : openAt('first')),
        onKeyDown: onTriggerKeyDown,
      })}
      {open ? (
        <div
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          className={cx(
            'absolute top-full z-40 mt-1 min-w-52 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-300 bg-white py-1 text-slate-900 shadow-lg outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {header === undefined ? null : (
            <div className="border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
              {header}
            </div>
          )}
          <div
            role="menu"
            id={menuId}
            aria-labelledby={triggerId}
            aria-orientation="vertical"
            className="flex flex-col p-1"
          >
            <MenuContext value={context}>{children}</MenuContext>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  disabled?: boolean | undefined;
  tone?: 'default' | 'danger' | undefined;
  children: ReactNode;
}

/** An action in a {@link Menu}; choosing it closes the menu. A disabled one does nothing. */
export function MenuItem({
  onSelect,
  disabled = false,
  tone = 'default',
  children,
}: MenuItemProps) {
  const menu = useContext(MenuContext);
  if (menu === null) throw new Error('MenuItem must be rendered inside a <Menu>');
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled ? true : undefined}
      onClick={() => {
        if (disabled) return;
        onSelect();
        menu.close();
      }}
      className={cx(
        'flex min-h-11 w-full cursor-pointer items-center rounded-md px-3 text-start text-sm font-medium hover:bg-slate-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:aria-disabled:hover:bg-transparent',
        tone === 'danger' ? 'text-red-700 dark:text-red-300' : 'text-slate-900 dark:text-slate-100',
        FOCUS_RING,
      )}
    >
      {children}
    </button>
  );
}
