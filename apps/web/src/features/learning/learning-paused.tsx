import type { LearningStatus } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { InfoIcon } from '../../components/icons.js';
import { formatDateTime } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';

export function LearningPaused({
  classification,
}: {
  classification: LearningStatus['classification'];
}) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  if (classification.state !== 'paused' || classification.reason === null) return null;
  const date =
    classification.since === null
      ? ''
      : formatDateTime(classification.since, i18n.language, me.timezone);
  const key = `learning.paused.${classification.reason}${date === '' ? '_nodate' : ''}`;
  return (
    <p role="status" className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-slate-600 dark:text-slate-300" />
      <span>{t(key, { date })}</span>
    </p>
  );
}
