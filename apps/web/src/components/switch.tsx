import type { ReactNode } from 'react';

import { FOCUS_RING, cx } from './cx.js';
import { FieldHelp, useFieldIds } from './field.js';
import { CheckIcon } from './icons.js';

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  hint?: ReactNode;
  error?: ReactNode;
  disabled?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
}

/** An on/off setting. The thumb moves and shows a check when on, so the state is not colour alone. */
export function Switch({
  label,
  checked,
  onCheckedChange,
  hint,
  error,
  disabled,
  id: idProp,
  className,
}: SwitchProps) {
  const field = useFieldIds(idProp, { hint, error });
  return (
    <div className={cx('flex flex-col', className)}>
      <div className="flex min-h-11 items-center justify-between gap-4">
        <label
          htmlFor={field.id}
          className="flex-1 cursor-pointer text-base text-slate-900 dark:text-slate-100"
        >
          {label}
        </label>
        <button
          type="button"
          role="switch"
          id={field.id}
          aria-checked={checked}
          aria-describedby={field.describedBy}
          aria-invalid={field.invalid}
          disabled={disabled}
          onClick={() => onCheckedChange(!checked)}
          className={cx(
            'inline-flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          <span
            aria-hidden="true"
            className={cx(
              'relative inline-block h-7 w-12 rounded-full border-2 transition-colors',
              checked
                ? 'border-indigo-600 bg-indigo-600 dark:border-indigo-400 dark:bg-indigo-400'
                : 'border-slate-500 bg-slate-500 dark:border-slate-400 dark:bg-slate-400',
            )}
          >
            <span
              className={cx(
                'absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full bg-white text-indigo-600 transition-transform dark:bg-slate-950 dark:text-indigo-400',
                checked ? 'translate-x-5.5' : 'translate-x-0.5',
              )}
            >
              {checked ? <CheckIcon className="size-3.5" /> : null}
            </span>
          </span>
        </button>
      </div>
      <FieldHelp hint={hint} hintId={field.hintId} error={error} errorId={field.errorId} />
    </div>
  );
}
