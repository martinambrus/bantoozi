import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { BatchProgress } from './use-batch-progress.js';

/** Where the analysis of the selected articles stands, in two sentences that update as it goes. */
export function ProgressReport({ progress }: { progress: BatchProgress }) {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const { summary, counts } = progress;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('calibrate.progress.title')}
      </h2>
      <div role="status" className="flex flex-col gap-1 text-sm font-medium">
        <p>{t('calibrate.progress.analyzed', { done: summary.analyzed, count: summary.total })}</p>
        {counts === undefined ? null : (
          <p>{t('calibrate.progress.scored', { scored: counts.scored, total: counts.total })}</p>
        )}
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('calibrate.progress.note')}</p>
    </section>
  );
}
