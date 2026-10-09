import type { Subscription } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { QueryState } from '../../components/states/query-state.js';
import { AddFeedForm } from '../feeds/add-feed-form.js';
import { ClassificationBadge } from '../feeds/feed-status.js';
import { displayTitle } from '../feeds/folders.js';
import { OpmlSection } from '../feeds/opml-section.js';
import { useSubscriptions } from '../feeds/subscriptions.js';
import { StarterBundles } from './starter-bundles.js';
import { StepFooter } from './step-footer.js';
import type { StepProps } from './steps.js';

/** How many feeds the list shows before the rest is asked for; a large OPML import is long. */
const SHOWN_FEEDS = 10;

function YourFeeds({ subscriptions }: { subscriptions: readonly Subscription[] }) {
  const { t } = useTranslation('onboarding');
  const headingId = useId();
  const listId = useId();
  const [all, setAll] = useState(false);
  const folds = subscriptions.length > SHOWN_FEEDS;
  const shown = folds && !all ? subscriptions.slice(0, SHOWN_FEEDS) : subscriptions;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('feeds.yours')}
      </h2>
      {subscriptions.length === 0 ? null : (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('feeds.count', { count: subscriptions.length })}
          </p>
          <ul
            id={listId}
            role="list"
            aria-labelledby={headingId}
            className="divide-y divide-slate-200 dark:divide-slate-700"
          >
            {shown.map((subscription) => (
              <li
                key={subscription.feed.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
              >
                <span className="break-words font-medium">{displayTitle(subscription)}</span>
                <ClassificationBadge mode={subscription.inferenceMode} />
              </li>
            ))}
          </ul>
          {folds ? (
            <div>
              <Button
                variant="secondary"
                aria-expanded={all}
                aria-controls={listId}
                onClick={() => {
                  setAll(!all);
                }}
              >
                {all ? t('feeds.showFewer') : t('feeds.showAll', { count: subscriptions.length })}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function Feeds({ subscriptions, go }: StepProps & { subscriptions: readonly Subscription[] }) {
  const { t } = useTranslation('onboarding');
  const hintId = useId();
  const none = subscriptions.length === 0;
  return (
    <>
      <p className="text-base">{t('feeds.lead')}</p>
      <AddFeedForm />
      <StarterBundles />
      <OpmlSection exportable={false} />
      <YourFeeds subscriptions={subscriptions} />
      {none ? (
        <p id={hintId} className="text-sm font-medium">
          {t('feeds.needOne')}
        </p>
      ) : null}
      <StepFooter step="feeds" go={go}>
        <Button
          disabled={none}
          aria-describedby={none ? hintId : undefined}
          onClick={() => {
            go('interests');
          }}
        >
          {t('continue')}
        </Button>
      </StepFooter>
    </>
  );
}

export function FeedsStep({ go }: StepProps) {
  const subscriptions = useSubscriptions();
  return (
    <QueryState query={subscriptions}>
      {(list) => <Feeds subscriptions={list} go={go} />}
    </QueryState>
  );
}
