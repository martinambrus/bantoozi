import type { FeedInfo } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { WarningIcon } from '../../components/icons.js';
import { useMe } from '../../session/context.js';
import { dismissNotice, useNoticeDismissed } from './dead-feed-dismissals.js';
import { feedErrorReason, formatDate } from './feed-format.js';
import { feedTitle } from './folders.js';
import { UnsubscribeDialog } from './unsubscribe-dialog.js';

export interface DeadFeedBannerProps {
  feed: FeedInfo;
  /** The title to call the feed by; the feed's own when absent. */
  title?: string | undefined;
}

/**
 * Says that a dead feed stopped working, when and why. Dismissing hides the notice for this
 * failure only (a later failure shows it again) and is kept in the browser for the account.
 */
export function DeadFeedBanner({ feed, title }: DeadFeedBannerProps) {
  const { t, i18n } = useTranslation('feeds');
  const me = useMe();
  const dismissed = useNoticeDismissed(me.id, feed);
  const [asking, setAsking] = useState(false);
  const messageId = useId();

  if (feed.status !== 'dead' || dismissed) return null;

  const reason = feedErrorReason(t, feed.lastErrorCode);
  const message =
    feed.lastErrorAt === null
      ? t('deadFeed.messageUndated', { reason })
      : t('deadFeed.message', {
          date: formatDate(feed.lastErrorAt, i18n.language, me.timezone),
          reason,
        });

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-950 sm:flex-row sm:items-center sm:justify-between dark:border-red-700 dark:bg-red-950 dark:text-red-100">
      <p id={messageId} className="flex items-start gap-2 text-sm">
        <WarningIcon className="mt-0.5 size-4" />
        <span>{message}</span>
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-describedby={messageId}
          onClick={() => setAsking(true)}
        >
          {t('unsubscribe.action')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-describedby={messageId}
          onClick={() => dismissNotice(me.id, feed)}
        >
          {t('common:actions.dismiss')}
        </Button>
      </div>
      <UnsubscribeDialog
        open={asking}
        onClose={() => setAsking(false)}
        feedId={feed.id}
        title={title ?? feedTitle(feed)}
      />
    </div>
  );
}
