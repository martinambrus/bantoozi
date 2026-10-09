import type { Subscription } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';
import { useLabels } from '../article/use-labels.js';
import { displayTitle } from '../feeds/folders.js';
import { subscriptionsKey } from '../feeds/subscriptions.js';
import type { ReaderView } from './view.js';

/** The subscription of a feed; the cache entry is the one every screen with feeds shares. */
function useSubscription(feedId: string | null): Subscription | undefined {
  const api = useApi();
  const accountId = useAccountId();
  const { data } = useQuery({
    queryKey: subscriptionsKey(accountId),
    queryFn: ({ signal }) => api.call(routes.subscriptionsList, undefined, { signal }),
    enabled: feedId !== null,
    select: (subscriptions) => subscriptions.find((candidate) => candidate.feed.id === feedId),
  });
  return data;
}

/** What the view is called: a lane's name, or the title the reader gave the feed, folder or label. */
export function useViewTitle(view: ReaderView): {
  title: string;
  /** The subscription of a feed view. */
  subscription: Subscription | undefined;
} {
  const { t } = useTranslation('reader');
  const subscription = useSubscription(view.kind === 'feed' ? view.feedId : null);
  const labels = useLabels(view.kind === 'label');

  switch (view.kind) {
    case 'lane':
      return { title: t(`lanes.${view.lane}`), subscription: undefined };
    case 'feed':
      return {
        title: subscription === undefined ? t('header.feed') : displayTitle(subscription),
        subscription,
      };
    case 'folder':
      return { title: view.name, subscription: undefined };
    case 'label':
      return {
        title: labels.data?.find((label) => label.id === view.labelId)?.name ?? t('header.label'),
        subscription: undefined,
      };
  }
}
