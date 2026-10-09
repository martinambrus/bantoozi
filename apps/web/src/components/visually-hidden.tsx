import type { ComponentProps } from 'react';

import { cx } from './cx.js';

export function VisuallyHidden({ className, ...rest }: ComponentProps<'span'>) {
  return <span {...rest} className={cx('sr-only', className)} />;
}
