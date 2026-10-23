import { hasAgreement, type LearningFeedAgreement, type LearningStatus } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { QueryState } from '../../components/states/query-state.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import { displayTitle } from '../feeds/folders.js';
import { useSubscriptions } from '../feeds/subscriptions.js';
import { UncoveredSuggestion, UnwantedSuggestion } from '../learning/agreement-text.js';
import { LearningPaused } from '../learning/learning-paused.js';
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
  'upgrade_regression',
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

function WordEstimates({ estimates }: { estimates: LearningStatus['estimates'] }) {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  if (estimates === null) return null;
  const date = formatDate(estimates.trainedAt, i18n.language, me.timezone);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{t('learning.estimates', { count: estimates.n, date })}</p>
      {me.preferences.estimates === 'off' ? <Hint>{t('learning.estimatesOff')}</Hint> : null}
    </div>
  );
}

/** The training feeds whose likes the cards miss, each with the offer to make an interest from them. */
function InterestsToAdd({ feeds }: { feeds: readonly LearningFeedAgreement[] }) {
  const { t } = useTranslation('settings');
  const subscriptions = useSubscriptions();
  const items = feeds.flatMap((agreement) => {
    const subscription = subscriptions.data?.find((item) => item.feed.id === agreement.feedId);
    return agreement.uncovered.suggest && subscription !== undefined
      ? [{ agreement, title: displayTitle(subscription) }]
      : [];
  });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('learning.uncoveredTitle')}</h3>
      <ul role="list" aria-label={t('learning.uncoveredTitle')} className="flex flex-col gap-3">
        {items.map(({ agreement, title }) => (
          <li key={agreement.feedId} className="flex flex-col gap-1">
            <span className="text-sm font-medium">{title}</span>
            <UncoveredSuggestion agreement={agreement} feedTitle={title} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The training feeds whose dislikes no Never card hides, each with the offer to make one from them. */
function TopicsToAvoid({ feeds }: { feeds: readonly LearningFeedAgreement[] }) {
  const { t } = useTranslation('settings');
  const subscriptions = useSubscriptions();
  const items = feeds.flatMap((agreement) => {
    const subscription = subscriptions.data?.find((item) => item.feed.id === agreement.feedId);
    return agreement.unwanted.suggest && subscription !== undefined
      ? [{ agreement, title: displayTitle(subscription) }]
      : [];
  });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{t('learning.unwantedTitle')}</h3>
      <ul role="list" aria-label={t('learning.unwantedTitle')} className="flex flex-col gap-3">
        {items.map(({ agreement, title }) => (
          <li key={agreement.feedId} className="flex flex-col gap-1">
            <span className="text-sm font-medium">{title}</span>
            <UnwantedSuggestion agreement={agreement} feedTitle={title} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LearningSection() {
  const { t } = useTranslation('settings');
  const learning = useLearning();
  return (
    <SettingsSection title={t('learning.title')} description={t('learning.description')}>
      <QueryState query={learning}>
        {({ model, feeds, classification, estimates }) => (
          <div className="flex flex-col gap-4">
            <LearningPaused classification={classification} />
            <LearningStatusLines model={model} />
            <WordEstimates estimates={estimates} />
            <InterestsToAdd feeds={feeds.filter(hasAgreement)} />
            <TopicsToAvoid feeds={feeds.filter(hasAgreement)} />
          </div>
        )}
      </QueryState>
    </SettingsSection>
  );
}
