import type { ComponentProps, ReactNode } from 'react';

import { cx } from './cx.js';
import { CONTROL_CLASSES, FieldHelp, LABEL_CLASSES, useFieldIds } from './field.js';

export interface SelectProps extends ComponentProps<'select'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** A labelled native select (its `<option>` children); `className` styles the wrapper. */
export function Select({
  label,
  hint,
  error,
  id: idProp,
  className,
  children,
  ...rest
}: SelectProps) {
  const field = useFieldIds(idProp, { hint, error });
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={field.id} className={LABEL_CLASSES}>
        {label}
      </label>
      <select
        {...rest}
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid}
        className={CONTROL_CLASSES}
      >
        {children}
      </select>
      <FieldHelp hint={hint} hintId={field.hintId} error={error} errorId={field.errorId} />
    </div>
  );
}
