import { useTranslation } from 'react-i18next';

import { Button } from '../button.js';
import { errorMessage } from '../error-message.js';
import { RefreshIcon, WarningIcon } from '../icons.js';

export interface ErrorStateProps {
  /** Whatever a call threw: the user sees a translated sentence, never the raw error. */
  error: unknown;
  onRetry?: (() => void) | undefined;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <WarningIcon className="size-8 text-red-700 dark:text-red-300" />
      <p className="text-lg font-semibold">{t('states.errorTitle')}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{errorMessage(t, error)}</p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshIcon className="size-4" />
          {t('actions.retry')}
        </Button>
      )}
    </div>
  );
}
