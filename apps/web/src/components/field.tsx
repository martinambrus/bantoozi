import { useId, type ReactNode } from 'react';

import { FOCUS_RING, cx } from './cx.js';
import { WarningIcon } from './icons.js';

export const CONTROL_CLASSES = cx(
  'min-h-11 w-full rounded-lg border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-500',
  'dark:border-slate-400 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-400',
  'aria-[invalid=true]:border-red-700 dark:aria-[invalid=true]:border-red-300',
  'disabled:cursor-not-allowed disabled:opacity-60',
  FOCUS_RING,
);

export const LABEL_CLASSES = 'text-sm font-medium text-slate-900 dark:text-slate-100';

function isPresent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

export interface FieldMessages {
  hint?: ReactNode;
  error?: ReactNode;
}

/** The control's id and the ids/attributes that tie its hint and error to it (aria-describedby). */
export function useFieldIds(idProp: string | undefined, { hint, error }: FieldMessages) {
  const generated = useId();
  const id = idProp ?? generated;
  const hintId = isPresent(hint) ? `${id}-hint` : undefined;
  const errorId = isPresent(error) ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ');
  return {
    id,
    hintId,
    errorId,
    describedBy: describedBy === '' ? undefined : describedBy,
    invalid: errorId === undefined ? undefined : (true as const),
  };
}

/** The hint and the error of a field. The error carries an icon, so it is not told by colour alone. */
export function FieldHelp({
  hint,
  hintId,
  error,
  errorId,
  className,
}: FieldMessages & {
  hintId: string | undefined;
  errorId: string | undefined;
  className?: string | undefined;
}) {
  return (
    <>
      {hintId === undefined ? null : (
        <p id={hintId} className={cx('text-sm text-slate-600 dark:text-slate-300', className)}>
          {hint}
        </p>
      )}
      {errorId === undefined ? null : (
        <p
          id={errorId}
          className={cx(
            'flex items-start gap-1.5 text-sm font-medium text-red-700 dark:text-red-300',
            className,
          )}
        >
          <WarningIcon className="mt-0.5 size-4" />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}
