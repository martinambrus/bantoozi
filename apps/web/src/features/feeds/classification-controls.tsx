import type { Subscription } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { formatDate } from '../../i18n/dates.js';
import { useMe } from '../../session/context.js';
import { ClassificationBadge } from './feed-status.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';

type Mode = Subscription['inferenceMode'];

/** What the reader can switch to from each mode, in the order the buttons are offered. */
const CHOICES: Record<Mode, ReadonlyArray<{ mode: Mode; label: string }>> = {
  off: [{ mode: 'training', label: 'toTraining' }],
  training: [
    { mode: 'active', label: 'enable' },
    { mode: 'off', label: 'turnOff' },
  ],
  active: [
    { mode: 'training', label: 'backToTraining' },
    { mode: 'off', label: 'turnOff' },
  ],
};

export function ClassificationControls({ subscription }: { subscription: Subscription }) {
  const { t, i18n } = useTranslation('feeds');
  const me = useMe();
  const cache = useSubscriptionsCache();
  const headingId = useId();
  const [changedTo, setChangedTo] = useState<Mode | null>(null);
  const [stale, setStale] = useState(false);
  const change = useApiMutation(routes.subscriptionsSetInference);

  const { feed, inferenceMode: mode } = subscription;

  function switchTo(next: Mode) {
    if (change.isPending) return;
    setChangedTo(null);
    setStale(false);
    change.mutate(
      {
        params: { feedId: feed.id },
        body: { mode: next, expectedVersion: subscription.inferenceVersion },
      },
      {
        onSuccess: ({ subscription: updated }) => {
          cache.replace(updated);
          setChangedTo(updated.inferenceMode);
        },
        onError: (error) => {
          if (isApiError(error) && error.code === 'STALE_STATE') {
            setStale(true);
            void cache.refresh();
          }
        },
      },
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        {t('classification.title')}
      </h3>
      <p>
        <ClassificationBadge mode={mode} named={false} />
      </p>
      <p className="text-sm text-slate-700 dark:text-slate-200">
        {t(`classification.help.${mode}`)}
      </p>
      {mode === 'active' && subscription.inferenceActivatedAt !== null ? (
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {t('classification.since', {
            date: formatDate(subscription.inferenceActivatedAt, i18n.language, me.timezone),
          })}
        </p>
      ) : null}
      {mode === 'off' ? null : (
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {t('classification.switchBack')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {CHOICES[mode].map((choice) => (
          <Button
            key={choice.mode}
            variant="secondary"
            loading={change.isPending && change.variables.body.mode === choice.mode}
            disabled={change.isPending}
            onClick={() => switchTo(choice.mode)}
          >
            {t(`classification.${choice.label}`)}
          </Button>
        ))}
      </div>
      <p role="status" className={changedTo === null ? 'sr-only' : 'text-sm font-medium'}>
        {changedTo === null ? null : t('classification.changed', { mode: t(`mode.${changedTo}`) })}
      </p>
      {stale ? (
        <InlineAlert>{t('classification.stale')}</InlineAlert>
      ) : change.error === null ? null : (
        <InlineAlert>{errorMessage(t, change.error)}</InlineAlert>
      )}
    </section>
  );
}
