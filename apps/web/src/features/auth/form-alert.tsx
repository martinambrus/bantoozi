import type { ReactNode } from 'react';

import { WarningIcon } from '../../components/icons.js';

/** An error about the whole form; the role makes assistive technology read it out when it appears. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-sm font-medium text-red-700 dark:text-red-300"
    >
      <WarningIcon className="mt-0.5 size-4" />
      <span>{children}</span>
    </p>
  );
}
