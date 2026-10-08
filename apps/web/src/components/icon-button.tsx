import type { ComponentProps } from 'react';

import { BUTTON_BASE, BUTTON_VARIANTS, type ButtonVariant } from './button.js';
import { cx } from './cx.js';

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label'> {
  /** The accessible name (required): the icon child is decorative. */
  label: string;
  variant?: ButtonVariant | undefined;
}

export function IconButton({
  label,
  variant = 'ghost',
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      data-variant={variant}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], 'min-w-11 p-2', className)}
    />
  );
}
