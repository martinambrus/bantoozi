import { hasAgreement, type Subscription } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { Fragment, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidateCoalesced } from '../../api/coalesced-invalidate.js';
import { IconButton } from '../../components/icon-button.js';
import { InfoIcon } from '../../components/icons.js';
import { Tooltip } from '../../components/tooltip.js';
import { useAccountId, useMe } from '../../session/context.js';
import { ReadyForAutomatic } from '../feeds/ready-for-automatic.js';
import { useSettledActions } from '../reader/actions/provider.js';
import { chipState, type CardsSegment, type EstimateSegment } from './chip-state.js';
import { LearningPaused } from './learning-paused.js';
import { learningKey, useLearning } from './use-learning.js';

const CHIP = 'rounded border border-slate-300 px-2.5 py-1.5 text-sm dark:border-slate-600';
const TEXT = 'text-slate-700 dark:text-slate-200';

function estimateText(segment: EstimateSegment, t: TFunction<'learning'>): string[] {
  switch (segment.kind) {
    case 'off':
      return [t('chip.off')];
    case 'gate':
      return [t('chip.gate', { count: segment.needed })];
    case 'starting':
      return [t('chip.starting')];
    case 'on':
      return [
        t('chip.on'),
        segment.ratedHere === null
          ? t('chip.ratedAll', { count: segment.total })
          : t('chip.rated', { count: segment.ratedHere }),
      ];
  }
}

function cardsText(
  segment: CardsSegment,
  t: TFunction<'learning'>,
  number: (value: number) => string,
  weak: string,
): string | null {
  switch (segment.kind) {
    case 'agree':
      return t('chip.interestsAgree', {
        value: number(segment.value),
        threshold: number(segment.threshold),
      });
    case 'weak':
      return weak;
    case 'ready':
    case 'none':
      return null;
  }
}

/**
 * How the estimates and, for a feed in training, the interests are learning in this feed
 * (visible-learning §4.5). Nothing shows for an automatic feed or until the data is here.
 */
export function FeedLearningChip({ subscription }: { subscription: Subscription }) {
  const { t, i18n } = useTranslation('learning');
  const { t: tFeeds } = useTranslation('feeds');
  const me = useMe();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const shown = subscription.inferenceMode !== 'active';
  const learning = useLearning(shown);
  useSettledActions((handle) => {
    if (handle.action.type !== 'rate' || !shown) return;
    // The sidebar asks the same question for a feed in training in the same turn: one refetch is
    // enough for both, so this one waits for the turn to end and only asks if nobody has.
    queueMicrotask(() => {
      const key = learningKey(accountId);
      if (queryClient.isFetching({ queryKey: key }) === 0) invalidateCoalesced(queryClient, key);
    });
  });

  const status = learning.data;
  const feedId = subscription.feed.id;
  const state = useMemo(
    () =>
      status === undefined || !shown
        ? null
        : chipState({
            learning: status,
            feedId,
            inferenceMode: subscription.inferenceMode,
            estimatesPreference: me.preferences.estimates,
          }),
    [status, shown, feedId, subscription.inferenceMode, me.preferences.estimates],
  );
  if (state === null || status === undefined) return null;

  if (state.kind === 'paused') {
    return (
      <div role="group" aria-label={t('chip.label')} className={CHIP}>
        <LearningPaused classification={state.classification} />
      </div>
    );
  }

  const number = (value: number) =>
    new Intl.NumberFormat(i18n.language, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  const percent = (value: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(value);

  const parts: ReactNode[] = estimateText(state.estimate, t);
  if (state.estimate.kind === 'on' && state.estimate.quality !== null) {
    parts.push(
      <span key="quality" className="inline-flex items-center">
        {t('chip.quality', { value: percent(state.estimate.quality) })}
        <Tooltip text={t('chip.qualityHelp')}>
          {(tooltip) => (
            <IconButton {...tooltip} label={t('chip.qualityHelpLabel')} className="shrink-0">
              <InfoIcon className="size-4" />
            </IconButton>
          )}
        </Tooltip>
      </span>,
    );
  }
  const cards = cardsText(state.cards, t, number, tFeeds('agreement.short.not_yet'));
  if (cards !== null) parts.push(cards);

  const agreement = status.feeds.filter(hasAgreement).find((entry) => entry.feedId === feedId);

  return (
    <div role="group" aria-label={t('chip.label')} className={`${CHIP} ${TEXT}`}>
      <p className="flex flex-wrap items-center">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index === 0 ? null : (
              <span aria-hidden="true" className="px-1.5">
                {' · '}
              </span>
            )}
            {part}
          </Fragment>
        ))}
      </p>
      {state.cards.kind === 'ready' && agreement !== undefined ? (
        <ReadyForAutomatic
          subscription={subscription}
          agreement={agreement}
          label={t('chip.interestsReady')}
        />
      ) : null}
    </div>
  );
}
