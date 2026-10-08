import type { ComponentProps, ReactNode } from 'react';

import { FOCUS_RING, cx } from './cx.js';
import { FieldHelp, useFieldIds } from './field.js';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'children'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** A labelled checkbox; the whole label row is the 44 px target. `className` styles the wrapper. */
export function Checkbox({ label, hint, error, id: idProp, className, ...rest }: CheckboxProps) {
  const field = useFieldIds(idProp, { hint, error });
  return (
    <div className={cx('flex flex-col', className)}>
      <label
        htmlFor={field.id}
        className="flex min-h-11 cursor-pointer items-center gap-3 text-base text-slate-900 dark:text-slate-100"
      >
        <input
          {...rest}
          id={field.id}
          type="checkbox"
          aria-describedby={field.describedBy}
          aria-invalid={field.invalid}
          className={cx(
            'size-5 shrink-0 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed dark:accent-indigo-400',
            FOCUS_RING,
          )}
        />
        <span>{label}</span>
      </label>
      <FieldHelp
        hint={hint}
        hintId={field.hintId}
        error={error}
        errorId={field.errorId}
        className="ps-8"
      />
    </div>
  );
}
