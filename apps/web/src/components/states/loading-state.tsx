import { useTranslation } from 'react-i18next';

import { Spinner } from '../spinner.js';

export interface LoadingStateProps {
  /** What is loading, e.g. "Loading feeds…"; defaults to a generic "Loading…". */
  label?: string | undefined;
}

export function LoadingState({ label }: LoadingStateProps) {
  const { t } = useTranslation('common');
  const name = label ?? t('states.loading');
  return (
    <div
      role="status"
      aria-label={name}
      className="flex items-center justify-center gap-3 px-4 py-12 text-slate-600 dark:text-slate-300"
    >
      <Spinner className="size-6" />
      <span aria-hidden="true" className="text-sm font-medium">
        {name}
      </span>
    </div>
  );
}
