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

export interface ModalProps {
  open: boolean;
  /** Asked for by Escape, the close button and the browser's own close gestures. */
  onClose: () => void;
  /** Names the dialog. */
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  showCloseButton?: boolean | undefined;
  /** False while a request is in flight: every way to close it is ignored. */
  dismissible?: boolean | undefined;
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
  surfaceClassName,
  contentClassName,
  side,
}: Omit<ModalSurfaceProps, 'open'>) {
  const { t } = useTranslation('common');
  const ref = useRef<HTMLDialogElement>(null);
  const toastOutletRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

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
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
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
        {children}
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
