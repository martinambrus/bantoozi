import type { ComponentProps } from 'react';

import { cx } from '../../../components/cx.js';

/** A key cap: the key as it is written on the keyboard. */
export function Kbd({ className, ...rest }: ComponentProps<'kbd'>) {
  return (
    <kbd
      {...rest}
      className={cx(
        'inline-flex min-w-6 items-center justify-center rounded-md border border-slate-400 bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100',
        className,
      )}
    />
  );
}
