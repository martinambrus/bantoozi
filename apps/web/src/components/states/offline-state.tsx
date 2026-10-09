import { useTranslation } from 'react-i18next';

import { Button } from '../button.js';
import { OfflineIcon, RefreshIcon } from '../icons.js';

export interface OfflineStateProps {
  onRetry?: (() => void) | undefined;
}

export function OfflineState({ onRetry }: OfflineStateProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <OfflineIcon className="size-8 text-slate-600 dark:text-slate-300" />
      <p className="text-lg font-semibold">{t('states.offlineTitle')}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('states.offlineBody')}</p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshIcon className="size-4" />
          {t('actions.retry')}
        </Button>
      )}
    </div>
  );
}
