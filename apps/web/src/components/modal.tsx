import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from './cx.js';
import { IconButton } from './icon-button.js';
import { CloseIcon } from './icons.js';
import { lockScroll } from './scroll-lock.js';
import { useRegisterToastOutlet } from './toast/toast-provider.js';

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The first control that really takes the focus: the selector cannot tell a hidden one from the rest.
function focusFirst(dialog: HTMLDialogElement) {
  for (const element of dialog.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    element.focus();
    if (document.activeElement === element) return;
  }
  dialog.focus();
}

/** How long after a modal closes its opener is still watched for leaving the page. */
const OPENER_WATCH_MS = 1000;

// A fallback target is somewhere to be, not something to scroll to.
const STAY = { preventScroll: true };

function focusIfPossible(element: HTMLElement | null | undefined, options?: FocusOptions): boolean {
  if (element === null || element === undefined || !element.isConnected) return false;
  element.focus(options);
  return document.activeElement === element;
}

type ReturnFocus = (() => HTMLElement | null) | undefined;

// Where the focus goes when the opener cannot have it: what the page names, else the modal that is
// still open (the page behind it is inert), else its main landmark. It is never left on the body,
// which a keyboard or a screen reader cannot read from. A focus that the page or the person has
// already put somewhere stays there.
export function focusFallback(returnFocus: ReturnFocus) {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  if (focusIfPossible(returnFocus?.(), STAY)) return;
  const inner = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
  if (inner === undefined) focusIfPossible(document.querySelector('main'), STAY);
  else focusFirst(inner);
}

// A list can re-render only when its query settles, after the modal that edited it has closed and
// handed the focus back; the focus is lost with the opener then.
function watchOpener(opener: HTMLElement, onGone: () => void) {
  const observer = new MutationObserver(() => {
    if (opener.isConnected) return;
    stop();
    onGone();
  });
  const timer = setTimeout(stop, OPENER_WATCH_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}

export interface ModalProps {
  open: boolean;
  /** Asked for by Escape, the close button and the browser's own close gestures. */
  onClose: () => void;
  /** Names the dialog. */
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  showCloseButton?: boolean | undefined;
  /**
   * False while a request is in flight: every way to close it is ignored, and its controls take no
   * input, so nothing is changed after what was sent and then dropped when it closes.
   */
  dismissible?: boolean | undefined;
  /**
   * Where the focus goes on closing when the element that opened the modal is gone (its row was
   * deleted or replaced). Without one, or when it names nothing that can take the focus, the
   * page's `<main>` does.
   */
  returnFocus?: ReturnFocus;
}

interface ModalSurfaceProps extends ModalProps {
  /** Position and size of the `<dialog>`, which Tailwind's preflight leaves unstyled. */
  surfaceClassName: string;
  /** Spacing of the content inside it. */
  contentClassName?: string | undefined;
  side?: 'right' | 'bottom' | 'auto' | undefined;
}

/**
 * A native modal `<dialog>`: the browser makes the rest of the page inert (the focus trap) and puts
 * the dialog in the top layer. It is mounted only while open, so each opening starts from scratch.
 * While open it also stops the page behind it from scrolling and hosts the toast region, which the
 * inert page could not announce.
 */
export function Modal({ open, ...props }: ModalSurfaceProps) {
  return open ? <OpenModal {...props} /> : null;
}

function OpenModal({
  onClose,
  title,
  description,
  children,
  showCloseButton = true,
  dismissible = true,
  returnFocus,
  surfaceClassName,
  contentClassName,
  side,
}: Omit<ModalSurfaceProps, 'open'>) {
  const { t } = useTranslation('common');
  const ref = useRef<HTMLDialogElement>(null);
  const toastOutletRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    returnFocusRef.current = returnFocus;
  });

  useEffect(() => lockScroll(), []);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const opener = document.activeElement;
    dialog.showModal();
    // Browsers focus a descendant themselves; this covers the ones that do not (and jsdom).
    if (!dialog.contains(document.activeElement)) focusFirst(dialog);
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener !== document.body && focusIfPossible(opener)) {
        watchOpener(opener, () => focusFallback(returnFocusRef.current));
      } else {
        focusFallback(returnFocusRef.current);
      }
    };
  }, []);

  useRegisterToastOutlet(toastOutletRef);

  // The control that started the work is disabled while it runs, which drops the focus to the page
  // behind: Escape would then reach the browser instead of this dialog. The dialog holds the focus
  // until the work is over, then hands it back to the first control.
  const wasDismissible = useRef(true);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dismissible) dialog.focus();
    else if (!wasDismissible.current) focusFirst(dialog);
    wasDismissible.current = dismissible;
  }, [dismissible]);

  function requestClose() {
    if (dismissible) onClose();
  }

  // Escape is handled on keydown, which also stops the browser's own cancel; a close request that
  // does not come from the keyboard (Android back, assistive technology) arrives as `cancel`.
  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    requestClose();
  }

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      data-side={side}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      className={cx(
        'overscroll-contain bg-white text-slate-900 shadow-xl outline-none backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-slate-100',
        surfaceClassName,
      )}
    >
      <div className={cx('flex flex-col gap-4 p-5', contentClassName)}>
        <div className={cx('flex flex-col gap-1', showCloseButton && 'pr-12')}>
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description === undefined ? null : (
            <div id={descriptionId} className="text-sm text-slate-600 dark:text-slate-300">
              {description}
            </div>
          )}
        </div>
        <fieldset disabled={!dismissible} role="none" className="contents">
          {children}
        </fieldset>
      </div>
      {showCloseButton ? (
        <IconButton
          label={t('actions.close')}
          disabled={!dismissible}
          onClick={requestClose}
          className="absolute right-2 top-2"
        >
          <CloseIcon />
        </IconButton>
      ) : null}
      <div ref={toastOutletRef} />
    </dialog>
  );
}
