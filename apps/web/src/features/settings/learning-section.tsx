import type { LearningStatus } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { QueryState } from '../../components/states/query-state.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import { useLearning } from '../learning/use-learning.js';
import { Hint, SettingsSection } from './section.js';

const REASONS = [
  'insufficient_explicit',
  'insufficient_class',
  'low_auc',
  'below_baseline_auc',
  'worse_logloss',
  'rating_fingerprint_changed',
  'context_changed',
] as const;

function LearningStatusLines({ model }: { model: LearningStatus['model'] }) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const { thresholds, counts, active, lastAttempt, deactivated } = model;
  const date = (value: string) => formatDate(value, i18n.language, me.timezone);
  const rejected = active === null && lastAttempt?.status === 'rejected' ? lastAttempt : null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{t('learning.explicit', { explicit: counts.explicit, min: thresholds.minExplicit })}</p>
      <p>{t('learning.likes', { likes: counts.likes, min: thresholds.minEachClass })}</p>
      <p>{t('learning.dislikes', { dislikes: counts.dislikes, min: thresholds.minEachClass })}</p>
      {active === null ? null : (
        <p className="font-medium">
          {t('learning.active', { date: date(active.since), version: active.version })}
        </p>
      )}
      {rejected === null ? null : (
        <>
          <p id="learning-rejected">{t('learning.rejected')}</p>
          <ul
            role="list"
            aria-label={t('learning.rejected')}
            className="list-disc ps-5 text-slate-700 dark:text-slate-200"
          >
            {(rejected.reasons.length === 0 ? ['unknown'] : rejected.reasons).map((reason) => (
              <li key={reason}>
                {t(
                  `learning.reasons.${(REASONS as readonly string[]).includes(reason) ? reason : 'unknown'}`,
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {active !== null || deactivated === null ? null : (
        <Hint>
          {t('learning.deactivated', {
            date: date(deactivated.at),
            reason: t(`learning.deactivatedReasons.${deactivated.reason}`),
          })}
        </Hint>
      )}
    </div>
  );
}

export function LearningSection() {
  const { t } = useTranslation('settings');
  const learning = useLearning();
  return (
    <SettingsSection title={t('learning.title')} description={t('learning.description')}>
      <QueryState query={learning}>
        {({ model }) => <LearningStatusLines model={model} />}
      </QueryState>
    </SettingsSection>
  );
}
