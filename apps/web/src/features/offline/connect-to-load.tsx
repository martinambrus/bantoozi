import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { OfflineIcon, RefreshIcon } from '../../components/icons.js';

/** What the opened article says when it was never opened before and there is no connection. */
export function ConnectToLoad({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('offline');
  const { t: tCommon } = useTranslation('common');
  return (
    <div role="status" className="flex flex-col items-start gap-3">
      <p className="flex items-start gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <OfflineIcon className="mt-0.5 size-4 shrink-0" />
        {t('article.connect')}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        <RefreshIcon className="size-4" />
        {tCommon('actions.retry')}
      </Button>
    </div>
  );
}
