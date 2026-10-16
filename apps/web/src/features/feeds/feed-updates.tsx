import type { FeedInfo } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';
import { formatInterval } from '../../i18n/duration.js';
import { useMe } from '../../session/context.js';

/** The server supplies account-specific release times, never the shared fetch schedule. */
export function FeedUpdates({ feed }: { feed: FeedInfo }) {
  const { t, i18n } = useTranslation('feeds');
  const me = useMe();
  if (feed.updateIntervalS === undefined) return null;
  const time =
    feed.nextUpdateAt == null
      ? null
      : new Intl.DateTimeFormat(i18n.language, {
          timeZone: me.timezone,
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(feed.nextUpdateAt));
  return (
    <div className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
      <p>
        {t('updates.every', { interval: formatInterval(feed.updateIntervalS, i18n.language) })}
        {feed.intervalReason === 'source'
          ? ` — ${t('updates.source')}`
          : feed.intervalReason === 'publisher'
            ? ` — ${t('updates.publisher')}`
            : ''}
      </p>
      {time === null ? null : (
        <p>
          <time dateTime={feed.nextUpdateAt!}>{t('updates.next', { time })}</time>
        </p>
      )}
    </div>
  );
}
