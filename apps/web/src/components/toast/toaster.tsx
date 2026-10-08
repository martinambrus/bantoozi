import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '../button.js';
import { cx } from '../cx.js';
import { IconButton } from '../icon-button.js';
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from '../icons.js';
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
 * Counts a toast down while neither hovered nor focused. Time already spent is kept across pauses,
 * and a toast shown again under its id (a new object) starts over.
 */
function useAutoDismiss(toast: Toast, paused: boolean, dismiss: () => void) {
  const clock = useRef<{ toast: Toast; remaining: number | null } | null>(null);
  useEffect(() => {
    if (clock.current?.toast !== toast) clock.current = { toast, remaining: toast.durationMs };
    const state = clock.current;
    const remaining = state.remaining;
    if (paused || remaining === null) return;
    const startedAt = Date.now();
    const timer = setTimeout(dismiss, remaining);
    return () => {
      clearTimeout(timer);
      state.remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
  }, [toast, paused, dismiss]);
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const { t } = useTranslation('common');
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const { id, actions } = toast;
  const dismiss = useCallback(() => onDismiss(id), [onDismiss, id]);
  useAutoDismiss(toast, hovered || focused, dismiss);
  const { icon: Icon, classes } = TONES[toast.tone];
  const wraps = actions.length > 1;

  return (
    <div
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
              onClick={() => {
                action.onAction();
                dismiss();
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      <IconButton label={t('actions.dismiss')} onClick={dismiss}>
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
  const region = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pt-4 pb-[calc(max(1rem,env(safe-area-inset-bottom))+var(--reason-bar-height,0px))]"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={store.dismiss} />
      ))}
    </div>
  );
  return outlet === null ? region : createPortal(region, outlet);
}
