import { useTranslation } from 'react-i18next';

import { quotaMessage, type QuotaDetails } from '../error-message.js';
import { InfoIcon } from '../icons.js';

export type QuotaLimitStateProps = QuotaDetails;

/** Shown instead of the content or the action when the plan's limit is reached (spec 08 §6). */
export function QuotaLimitState(props: QuotaLimitStateProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center"
    >
      <InfoIcon className="size-8 text-slate-600 dark:text-slate-300" />
      <p className="text-lg font-semibold">{t('states.quotaTitle')}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{quotaMessage(t, props)}</p>
    </div>
  );
}
