import type { ComponentProps } from 'react';

import { FOCUS_RING, cx } from '../../components/cx.js';

const CHIP_CLASSES =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium';

const SOLID =
  'border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100';
const DASHED =
  'border-dashed border-slate-500 bg-transparent text-slate-800 dark:border-slate-400 dark:text-slate-100';

/** The pill of a chip that is not a control. */
export function Chip({ className, ...rest }: ComponentProps<'span'>) {
  return <span {...rest} className={cx(CHIP_CLASSES, SOLID, className)} />;
}

export interface ChipButtonProps extends ComponentProps<'button'> {
  /** A dashed outline marks a suggestion that is not applied yet (spec 09 §3.2). */
  dashed?: boolean | undefined;
}

/**
 * A chip that is a button. The pill stays small while the button around it keeps the 44 px target
 * (spec 09 §1), and the focus ring follows the button.
 */
export function ChipButton({
  dashed = false,
  type = 'button',
  className,
  children,
  ...rest
}: ChipButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        'group inline-flex min-h-11 cursor-pointer items-center rounded-full',
        FOCUS_RING,
        className,
      )}
    >
      <span
        className={cx(
          CHIP_CLASSES,
          dashed ? DASHED : SOLID,
          'group-hover:bg-slate-200 dark:group-hover:bg-slate-700',
        )}
      >
        {children}
      </span>
    </button>
  );
}
