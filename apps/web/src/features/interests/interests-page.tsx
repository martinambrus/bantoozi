import { Link } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/badge.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { useKeptOffers } from './kept-updates.js';
import { Library } from './library.js';
import { LibraryUpdates } from './library-updates.js';
import { MyInterests } from './my-interests.js';
import { PublicationRequests } from './publication-requests.js';
import { useRequests, useUpdates } from './queries.js';
import { Suggestions } from './suggestions.js';
import { DEFAULT_TAB, TABS, type InterestsTab } from './tabs.js';

// The current tab is underlined and bold as well as coloured, so it never rides on colour alone.
const TAB_LINK = cx(
  'inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
  'aria-[current=page]:font-semibold aria-[current=page]:text-indigo-700 aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-4 dark:aria-[current=page]:text-indigo-300',
  FOCUS_RING,
);

const SECTIONS: Record<InterestsTab, ComponentType> = {
  mine: MyInterests,
  suggestions: Suggestions,
  library: Library,
  updates: LibraryUpdates,
  requests: PublicationRequests,
};

export interface InterestsPageProps {
  /** The section the address names; the person's own cards when it names none. */
  tab: InterestsTab | undefined;
}

export function InterestsPage({ tab }: InterestsPageProps) {
  const { t } = useTranslation('interests');
  const updates = useUpdates();
  const requests = useRequests();
  const kept = useKeptOffers();
  // What waits for the person is counted on its tab, whichever tab is open.
  const waiting: Partial<Record<InterestsTab, number>> = {
    updates: updates.data?.filter((offer) => !kept.isKept(offer)).length ?? 0,
    requests: requests.data?.filter((request) => request.status === 'pending').length ?? 0,
  };
  const Section = SECTIONS[tab ?? DEFAULT_TAB];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('lead')}</p>
      </header>
      <nav aria-label={t('tabs.label')}>
        <ul role="list" className="flex gap-1 overflow-x-auto">
          {TABS.map((name) => {
            const count = waiting[name] ?? 0;
            return (
              <li key={name}>
                <Link
                  to="/interests"
                  search={name === DEFAULT_TAB ? {} : { tab: name }}
                  activeOptions={{ exact: true }}
                  className={TAB_LINK}
                >
                  {t(`tabs.${name}`)}
                  {count === 0 ? null : (
                    <>
                      {' '}
                      <Badge tone="info">{count}</Badge>
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <Section />
    </div>
  );
}
