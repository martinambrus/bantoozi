import type { ComponentProps } from 'react';

import { FOCUS_RING, cx } from './cx.js';
import { Spinner } from './spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// Every size keeps the 44 px touch target of spec 09 §1; sizes only change padding and type.
export const BUTTON_BASE = cx(
  'inline-flex min-h-11 cursor-pointer select-none items-center justify-center gap-2 rounded-lg font-medium transition-colors',
  'disabled:cursor-not-allowed disabled:opacity-60',
  FOCUS_RING,
);

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-400 dark:text-slate-950 dark:hover:bg-indigo-300',
  secondary:
    'border border-slate-500 bg-white text-slate-900 hover:bg-slate-100 dark:border-slate-400 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
  ghost: 'text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
  danger:
    'bg-red-700 text-white hover:bg-red-800 dark:bg-red-400 dark:text-slate-950 dark:hover:bg-red-300',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 text-sm',
  md: 'px-4 text-sm',
  lg: 'px-5 text-base',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Disables the button and marks it busy; the label stays, so its name does not change. */
  loading?: boolean | undefined;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], SIZES[size], className)}
    >
      {loading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}
