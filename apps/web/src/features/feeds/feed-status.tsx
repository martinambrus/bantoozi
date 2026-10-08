import type { FeedInfo, Subscription, SubscriptionUnread } from '@bantoozi/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../components/badge.js';
import { CheckIcon, CloseIcon, WarningIcon } from '../../components/icons.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';

function PauseIcon({ className }: { className?: string | undefined }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M9 6v12M15 6v12" />
    </svg>
  );
}

type Icon = (props: { className?: string }) => ReactNode;

const HEALTH: Record<FeedInfo['status'], { tone: BadgeTone; Icon: Icon }> = {
  active: { tone: 'success', Icon: CheckIcon },
  quarantined: { tone: 'warning', Icon: WarningIcon },
  dead: { tone: 'danger', Icon: CloseIcon },
  paused: { tone: 'neutral', Icon: PauseIcon },
};

/** The feed's state in words, with an icon of its own: the colour only tints it. */
export function HealthBadge({ status }: { status: FeedInfo['status'] }) {
  const { t } = useTranslation('feeds');
  const { tone, Icon } = HEALTH[status];
  return (
    <Badge tone={tone}>
      <Icon className="size-3.5" />
      <VisuallyHidden>{t('row.statusLabel')}</VisuallyHidden> {t(`status.${status}`)}
    </Badge>
  );
}

const MODE_TONE: Record<Subscription['inferenceMode'], BadgeTone> = {
  off: 'neutral',
  training: 'info',
  active: 'success',
};

export function ClassificationBadge({
  mode,
  named = true,
}: {
  mode: Subscription['inferenceMode'];
  /** Whether assistive technology is told what the badge is about; off where a heading says so. */
  named?: boolean;
}) {
  const { t } = useTranslation('feeds');
  return (
    <Badge tone={MODE_TONE[mode]}>
      {named ? (
        <>
          <VisuallyHidden>{t('row.classificationLabel')}</VisuallyHidden>{' '}
        </>
      ) : null}
      {t(`mode.${mode}`)}
    </Badge>
  );
}

const LANES = ['forYou', 'maybe', 'everything', 'new'] as const;

/** The unread articles per lane; lanes without any are left out. */
export function UnreadCounts({ unread }: { unread: SubscriptionUnread }) {
  const { t } = useTranslation('feeds');
  const lanes = LANES.filter((lane) => unread[lane] > 0);
  if (lanes.length === 0) {
    return <p className="text-sm text-slate-600 dark:text-slate-300">{t('row.noUnread')}</p>;
  }
  return (
    <ul role="list" aria-label={t('row.unreadLabel')} className="flex flex-wrap gap-x-4 gap-y-1">
      {lanes.map((lane) => (
        <li key={lane} className="text-sm">
          <span className="text-slate-600 dark:text-slate-300">{t(`row.unread.${lane}`)}</span>{' '}
          <span className="font-semibold tabular-nums">{unread[lane]}</span>
        </li>
      ))}
    </ul>
  );
}
