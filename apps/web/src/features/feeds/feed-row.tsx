import type { Subscription } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { formatRelativeTime } from '../../i18n/dates.js';
import { DeadFeedBanner } from './dead-feed-banner.js';
import { feedErrorReason, showsLastError } from './feed-format.js';
import { ClassificationBadge, HealthBadge, UnreadCounts } from './feed-status.js';
import { displayTitle } from './folders.js';

export interface FeedRowProps {
  subscription: Subscription;
  onOpenSettings: (feedId: string) => void;
}

export function FeedRow({ subscription, onOpenSettings }: FeedRowProps) {
  const { t, i18n } = useTranslation('feeds');
  const { feed } = subscription;
  const title = displayTitle(subscription);

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="break-words text-base font-semibold">{title}</h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <HealthBadge status={feed.status} />
            <ClassificationBadge mode={subscription.inferenceMode} />
            {feed.lastSuccessAt === null ? (
              <span className="text-sm text-slate-600 dark:text-slate-300">
                {t('row.neverUpdated')}
              </span>
            ) : (
              <time
                dateTime={feed.lastSuccessAt}
                className="text-sm text-slate-600 dark:text-slate-300"
              >
                {t('row.updated', {
                  when: formatRelativeTime(feed.lastSuccessAt, Date.now(), i18n.language),
                })}
              </time>
            )}
          </div>
          {showsLastError(feed) ? (
            <p className="text-sm text-slate-700 dark:text-slate-200">
              {t('row.lastError', { reason: feedErrorReason(t, feed.lastErrorCode) })}
            </p>
          ) : null}
          <UnreadCounts unread={subscription.unread} />
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('row.settingsFor', { title })}
          data-feed-settings={feed.id}
          onClick={() => onOpenSettings(feed.id)}
        >
          {t('row.settings')}
        </Button>
      </div>
      <DeadFeedBanner feed={feed} title={title} />
    </li>
  );
}
