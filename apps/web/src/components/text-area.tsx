import type { ComponentProps, ReactNode } from 'react';

import { cx } from './cx.js';
import { CONTROL_CLASSES, FieldHelp, LABEL_CLASSES, useFieldIds } from './field.js';

export interface TextAreaProps extends Omit<ComponentProps<'textarea'>, 'children'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

/** A labelled textarea; `className` styles the wrapper, every other prop goes to the `<textarea>`. */
export function TextArea({ label, hint, error, id: idProp, className, ...rest }: TextAreaProps) {
  const field = useFieldIds(idProp, { hint, error });
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={field.id} className={LABEL_CLASSES}>
        {label}
      </label>
      <textarea
        {...rest}
        id={field.id}
        aria-describedby={field.describedBy}
        aria-invalid={field.invalid}
        className={cx(CONTROL_CLASSES, 'resize-y')}
      />
      <FieldHelp hint={hint} hintId={field.hintId} error={error} errorId={field.errorId} />
    </div>
  );
}
