import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { QueryState } from '../../components/states/query-state.js';
import { useAccountId } from '../../session/context.js';
import { Hint, LINK } from './section.js';

interface ImageException {
  feedId: string;
  /** Null when the person no longer follows the feed. */
  name: string | null;
  policy: 'allow' | 'block';
}

function useImageExceptions() {
  const api = useApi();
  const accountId = useAccountId();
  return useQuery({
    queryKey: accountKey(accountId, 'settings', 'image-exceptions'),
    queryFn: async ({ signal }): Promise<ImageException[]> => {
      const [preferences, subscriptions] = await Promise.all([
        api.call(routes.feedPreferenceList, undefined, { signal }),
        api.call(routes.subscriptionsList, undefined, { signal }),
      ]);
      const names = new Map(
        subscriptions.map(({ feed, titleOverride }) => [
          feed.id,
          titleOverride ?? feed.title ?? feed.url,
        ]),
      );
      return preferences.flatMap(({ feedId, imagePolicy }) =>
        imagePolicy === 'inherit'
          ? []
          : [{ feedId, name: names.get(feedId) ?? null, policy: imagePolicy }],
      );
    },
  });
}

function ExceptionList({
  items,
  headingId,
}: {
  items: readonly ImageException[];
  headingId: string;
}) {
  const { t, i18n } = useTranslation('settings');
  const rows = useMemo(() => {
    const collator = new Intl.Collator(i18n.language);
    return items
      .map((item) => ({ ...item, label: item.name ?? t('preferences.images.unknownFeed') }))
      .sort((a, b) => collator.compare(a.label, b.label));
  }, [items, i18n.language, t]);
  return (
    <ul
      role="list"
      aria-labelledby={headingId}
      className="divide-y divide-slate-200 rounded-lg border border-slate-300 px-4 dark:divide-slate-700 dark:border-slate-600"
    >
      {rows.map(({ feedId, label, policy }) => (
        <li key={feedId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Link to="/feeds" className={LINK}>
            {label}
          </Link>
          <Badge tone={policy === 'allow' ? 'info' : 'neutral'}>
            {t(`preferences.images.${policy}`)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** The feeds that decide for themselves whether to load images, whatever the setting above says. */
export function ImageExceptions() {
  const { t } = useTranslation('settings');
  const headingId = useId();
  const query = useImageExceptions();
  return (
    <div className="flex flex-col gap-2">
      <h4 id={headingId} className="text-sm font-medium text-slate-900 dark:text-slate-100">
        {t('preferences.images.exceptions')}
      </h4>
      <QueryState
        query={query}
        isEmpty={(items) => items.length === 0}
        empty={<Hint>{t('preferences.images.none')}</Hint>}
      >
        {(items) => <ExceptionList items={items} headingId={headingId} />}
      </QueryState>
    </div>
  );
}
