import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '../button.js';
import { cx } from '../cx.js';
import { IconButton } from '../icon-button.js';
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from '../icons.js';
import { focusFallback } from '../modal.js';
import { toastControls } from './toast-outlets.js';
import { useToastOutlets, useToastStore } from './toast-provider.js';
import type { Toast, ToastTone } from './toast-store.js';

// Each tone has its own icon, so the tone never rides on colour alone.
const TONES: Record<ToastTone, { icon: typeof InfoIcon; classes: string }> = {
  info: {
    icon: InfoIcon,
    classes:
      'border-slate-500 bg-white text-slate-900 dark:border-slate-400 dark:bg-slate-800 dark:text-slate-100',
  },
  success: {
    icon: CheckIcon,
    classes:
      'border-emerald-700 bg-emerald-50 text-emerald-950 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-100',
  },
  error: {
    icon: WarningIcon,
    classes:
      'border-red-700 bg-red-50 text-red-950 dark:border-red-400 dark:bg-red-950 dark:text-red-100',
  },
};

/**
 * Counts a toast down while neither hovered nor focused. The time already spent is kept in the
 * store, so the item that replaces this one when the region moves between the page and a modal
 * carries on where it stopped; a toast shown again under its id starts over.
 */
function useAutoDismiss(toast: Toast, paused: boolean, dismiss: () => void) {
  const store = useToastStore();
  const { id } = toast;
  useEffect(() => {
    if (paused) return;
    const left = store.resume(id);
    if (left === null) return;
    const timer = setTimeout(dismiss, left);
    return () => {
      clearTimeout(timer);
      store.pause(id);
    };
  }, [store, id, toast, paused, dismiss]);
}

// The element a dismissed toast gave the focus back to, for as long as the focus stays on it.
let handedBack: Element | null = null;

/** Whether the focus is where a dismissed toast put it back, not where the person moved it. */
export function isHandedBack(element: Element | null): boolean {
  return element !== null && element === handedBack;
}

// The toast that held the focus is gone: back to what had it, else to the dialog or the page.
function handBack(origin: HTMLElement | null) {
  const before = document.activeElement;
  if (before !== null && before !== document.body) return;
  focusFallback(() => origin);
  const to = document.activeElement;
  if (to === null || to === document.body) return;
  handedBack = to;
  to.addEventListener(
    'focusout',
    () => {
      if (handedBack === to) handedBack = null;
    },
    { once: true },
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
  /** The person took away a toast while one of its controls had the focus. */
  onLeave: () => void;
}

function ToastItem({ toast, onDismiss, onLeave }: ToastItemProps) {
  const { t } = useTranslation('common');
  const outlets = useToastOutlets();
  const root = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const { id, actions } = toast;
  const dismiss = useCallback(() => onDismiss(id), [onDismiss, id]);
  useAutoDismiss(toast, hovered || focused, dismiss);

  function close(run?: () => void) {
    const held = root.current?.contains(document.activeElement) === true;
    run?.();
    if (held) onLeave();
    dismiss();
  }

  // This item took the place of one in the other outlet that had the focus, and the focus goes on.
  useLayoutEffect(() => {
    const control = outlets.takeFocus(id);
    if (control !== null && root.current !== null) toastControls(root.current)[control]?.focus();
  }, [outlets, id]);

  const { icon: Icon, classes } = TONES[toast.tone];
  const wraps = actions.length > 1;

  return (
    <div
      ref={root}
      data-toast-id={id}
      data-tone={toast.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cx(
        'pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg border-2 py-1 pl-3 pr-1 shadow-lg motion-safe:animate-toast-in',
        wraps && 'flex-wrap',
        classes,
      )}
    >
      <Icon className="size-5" />
      <p className="flex-1 py-2 text-sm font-medium">{toast.message}</p>
      {actions.length === 0 ? null : (
        <div
          data-toast-actions
          className={wraps ? 'order-last flex w-full flex-wrap items-center gap-2' : 'contents'}
        >
          {actions.map((action, index) => (
            <Button
              key={index}
              size="sm"
              variant="secondary"
              onClick={() => close(() => action.onAction())}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      <IconButton label={t('actions.dismiss')} onClick={() => close()}>
        <CloseIcon />
      </IconButton>
    </div>
  );
}

/**
 * The live region toasts appear in. It stays in the page while empty, so assistive technology
 * announces what is added. While a modal is open the page is inert and nothing in it is announced,
 * so the one region moves into the topmost modal.
 */
export function Toaster() {
  const store = useToastStore();
  const outlets = useToastOutlets();
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const outlet = useSyncExternalStore(outlets.subscribe, outlets.getSnapshot, outlets.getSnapshot);
  // Where the focus was before the toasts, and whether a toast that held it was just closed.
  const memory = useRef<{ origin: HTMLElement | null; leaving: boolean }>({
    origin: null,
    leaving: false,
  });

  // The items in a new outlet have had their turn to take a focus that was passed on; no other will.
  useLayoutEffect(() => {
    outlets.dropFocus();
  }, [outlets, outlet]);

  useLayoutEffect(() => {
    if (!memory.current.leaving) return;
    memory.current.leaving = false;
    handBack(memory.current.origin);
  }, [toasts]);

  const region = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      onFocus={(event) => {
        const from = event.relatedTarget;
        if (from instanceof Node && event.currentTarget.contains(from)) return;
        memory.current.origin = from instanceof HTMLElement ? from : null;
      }}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pt-4 pb-[calc(max(1rem,env(safe-area-inset-bottom))+var(--reason-bar-height,0px))]"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={store.dismiss}
          onLeave={() => {
            memory.current.leaving = true;
          }}
        />
      ))}
    </div>
  );
  return outlet === null ? region : createPortal(region, outlet);
}
