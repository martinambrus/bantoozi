import type { Subscription } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidateCoalesced } from '../../api/coalesced-invalidate.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { Spinner } from '../../components/spinner.js';
import { formatDate } from '../../i18n/dates.js';
import { useAccountId, useMe } from '../../session/context.js';
import { learningKey } from '../learning/use-learning.js';
import { ClassificationBadge } from './feed-status.js';
import { InlineAlert } from './inline-alert.js';
import { useSubscriptionsCache } from './subscriptions.js';

type Mode = Subscription['inferenceMode'];

const isStale = (error: unknown) => isApiError(error) && error.code === 'STALE_STATE';

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
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const cache = useSubscriptionsCache();
  const headingId = useId();
  const [changedTo, setChangedTo] = useState<Mode | null>(null);
  const [stale, setStale] = useState(false);
  const choices = useRef<HTMLDivElement>(null);
  // The list learns the outcome even when the answer comes after these controls are gone (their
  // sheet was closed); only what they say about it needs them. Only the classification is taken
  // from the answer: a settings save made while it was on its way is newer than the rest of it.
  const change = useApiMutation(routes.subscriptionsSetInference, {
    onSuccess: ({ subscription: updated }) => {
      cache.mergeInference(updated);
      invalidateCoalesced(queryClient, learningKey(accountId));
    },
    onError: (error) => {
      if (isStale(error)) void cache.refresh();
    },
  });

  // The button that was pressed is gone once the list shows the new mode: the focus moves to the
  // first of the new choices instead of dropping to the page.
  const { inferenceMode: mode } = subscription;
  useEffect(() => {
    if (changedTo !== mode || change.isPending) return;
    if (document.activeElement === null || document.activeElement === document.body) {
      choices.current?.querySelector('button')?.focus();
    }
  }, [changedTo, mode, change.isPending]);

  const { feed } = subscription;

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
        onSuccess: ({ subscription: updated }) => setChangedTo(updated.inferenceMode),
        onError: (error) => setStale(isStale(error)),
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
      <div ref={choices} className="flex flex-wrap gap-2">
        {CHOICES[mode].map((choice) => (
          <Button
            key={choice.mode}
            variant="secondary"
            aria-disabled={change.isPending || undefined}
            aria-busy={
              (change.isPending && change.variables.body.mode === choice.mode) || undefined
            }
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            onClick={() => switchTo(choice.mode)}
          >
            {change.isPending && change.variables.body.mode === choice.mode ? (
              <Spinner className="size-4" />
            ) : null}
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
