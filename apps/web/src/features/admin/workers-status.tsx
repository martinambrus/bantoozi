import { ADMIN_PATCHABLE_SETTING_KEYS, type AdminSettings } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Hint } from './admin-ui.js';
import { BackgroundWork } from './queue-watch.js';

/** Live workers, pending restarts and problems that have no settings editor. */
export function WorkersStatus({ workers }: { workers: AdminSettings['workers'] }) {
  const { t } = useTranslation('admin');
  const pending = workers.filter((worker) => worker.pendingRestart).length;
  const problems = [
    ...new Set(
      workers.flatMap((worker) =>
        worker.problems
          .filter(
            (problem) => !(ADMIN_PATCHABLE_SETTING_KEYS as readonly string[]).includes(problem.key),
          )
          .map((problem) => problem.message),
      ),
    ),
  ];
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
      {problems.map((message) => (
        <p key={message} className="text-sm text-red-700 dark:text-red-300">
          {t('settings.workers.generalProblem', { message })}
        </p>
      ))}
      {pending === 0 ? null : (
        <>
          <Hint>{t('settings.workers.pendingRestart', { pending, total: workers.length })}</Hint>
          <BackgroundWork status={false} label={t('settings.workers.restarting')} />
        </>
      )}
    </div>
  );
}
