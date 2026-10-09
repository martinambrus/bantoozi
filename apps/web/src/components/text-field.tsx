import type { ComponentProps, ReactNode } from 'react';

import { cx } from './cx.js';
import { CONTROL_CLASSES, FieldHelp, LABEL_CLASSES, useFieldIds } from './field.js';

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'children'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** A labelled input; `className` styles the wrapper, every other prop goes to the `<input>`. */
export function TextField({ label, hint, error, id: idProp, className, ...rest }: TextFieldProps) {
  const field = useFieldIds(idProp, { hint, error });
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={field.id} className={LABEL_CLASSES}>
        {label}
      </label>
      <input
        {...rest}
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid}
        className={CONTROL_CLASSES}
      />
      <FieldHelp hint={hint} hintId={field.hintId} error={error} errorId={field.errorId} />
    </div>
  );
}
