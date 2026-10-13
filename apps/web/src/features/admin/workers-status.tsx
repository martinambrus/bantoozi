import type { AdminSettings } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Hint } from './admin-ui.js';
import { BackgroundWork } from './queue-watch.js';

/** How many live workers there are and how many of them wait for a restart to apply a setting. */
export function WorkersStatus({ workers }: { workers: AdminSettings['workers'] }) {
  const { t } = useTranslation('admin');
  const pending = workers.filter((worker) => worker.pendingRestart).length;
  return (
    <div
      role="status"
      aria-label={t('settings.workers.title')}
      className="flex flex-col gap-1 rounded-lg border border-slate-300 p-3 dark:border-slate-600"
    >
      <p className="text-sm font-semibold">
        {workers.length === 0
          ? t('settings.workers.none')
          : t('settings.workers.live', { count: workers.length })}
      </p>
      {pending === 0 ? null : (
        <>
          <Hint>{t('settings.workers.pendingRestart', { pending, total: workers.length })}</Hint>
          <BackgroundWork status={false} label={t('settings.workers.restarting')} />
        </>
      )}
    </div>
  );
}
