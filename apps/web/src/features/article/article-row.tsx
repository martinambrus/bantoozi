import type { ArticleListItem, LabelDto } from '@bantoozi/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeTone } from '../../components/badge.js';
import { Checkbox } from '../../components/checkbox.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { PlusIcon } from '../../components/icons.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import { WaitingToSync } from '../offline/waiting-to-sync.js';
import { useReaderItem, useWaitingChanges } from '../reader/actions/provider.js';
import { BookmarkButton, RateButtons } from './article-buttons.js';
import { Chip, ChipButton } from './chip-button.js';
import { formatRelativeTime } from './format.js';
import { httpUrl } from './http-url.js';
import { LabelDot } from './label-dot.js';
import { SwipeRow } from './swipe-row.js';
import { topReasonText } from './top-reason.js';
import { useArticleActions } from './use-article-actions.js';
import { useLabels } from './use-labels.js';

/** Where the analysis of an article stands in words (spec 09 §3.2); a finished one needs none. */
const ANALYSIS_BADGES: Record<
  ArticleListItem['analysis']['status'],
  { tone: BadgeTone; label: string } | null
> = {
  not_requested: { tone: 'neutral', label: 'row.notAnalyzed' },
  pending: { tone: 'info', label: 'row.analysis.pending' },
  running: { tone: 'info', label: 'row.analysis.running' },
  complete: null,
  failed: { tone: 'danger', label: 'row.analysis.failed' },
  cancelled: { tone: 'neutral', label: 'row.analysis.cancelled' },
};

export interface ArticleRowProps {
  item: ArticleListItem;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Simple mode hides the excerpt (spec 09 §3.2). */
  simple: boolean;
  /** Opens the "Why this?" explanation; the reason chip is a button only when this is given. */
  onWhyThis?: (() => void) | undefined;
  /** A checkbox to select the row for a bulk action; shown only when given. */
  selection?: { selected: boolean; onChange: (selected: boolean) => void } | undefined;
}

/** One article in a list (spec 09 §3.2), showing the displayed state of the reader actions. */
export function ArticleRow({
  item,
  expanded,
  onToggleExpand,
  simple,
  onWhyThis,
  selection,
}: ArticleRowProps) {
  const { t, i18n } = useTranslation('article');
  const shown = useReaderItem(item);
  const actions = useArticleActions(shown);
  const titleId = useId();
  const waitingId = useId();
  const waiting = useWaitingChanges(item.id).length > 0;
  const [clusterOpen, setClusterOpen] = useState(false);

  const labels = useLabels(shown.labelIds.length + shown.labelSuggestions.length > 0);
  const known = new Map<string, LabelDto>((labels.data ?? []).map((label) => [label.id, label]));
  const assigned = shown.labelIds.flatMap((id) => known.get(id) ?? []);
  const suggested = shown.labelSuggestions.flatMap((id) =>
    shown.labelIds.includes(id) ? [] : (known.get(id) ?? []),
  );

  const unread = shown.readAt === null;
  const when = shown.publishedAt ?? shown.firstSeenAt;
  const relative = formatRelativeTime(when, Date.now(), i18n.language);
  const feed = shown.feed;
  const feedIcon = shown.effectiveImagesAllowed ? httpUrl(feed?.iconUrl) : null;
  const thumbnail = shown.effectiveImagesAllowed ? httpUrl(shown.imageUrl) : null;
  const otherSources = shown.cluster === null ? 0 : shown.cluster.size - 1;
  const otherFeeds = shown.cluster?.otherFeeds ?? [];
  const reason = shown.topReason === null ? null : topReasonText(t, i18n.language, shown.topReason);
  const analysis = ANALYSIS_BADGES[shown.analysis.status];

  return (
    <SwipeRow item={shown} actions={actions} labelledBy={titleId}>
      {selection === undefined ? null : (
        <Checkbox
          className="w-11 shrink-0"
          label={<VisuallyHidden>{t('row.select', { title: shown.title })}</VisuallyHidden>}
          checked={selection.selected}
          onChange={(event) => selection.onChange(event.target.checked)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
          {feed === null ? null : (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {feedIcon === null ? null : (
                <img
                  src={feedIcon.href}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="size-4 shrink-0 rounded-sm"
                />
              )}
              <span className="truncate font-medium">{feed.title}</span>
            </span>
          )}
          {relative === '' ? null : <time dateTime={when}>{relative}</time>}
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cx(
                'size-2 rounded-full',
                unread
                  ? 'bg-indigo-600 dark:bg-indigo-300'
                  : 'border border-slate-500 dark:border-slate-400',
              )}
            />
            {unread ? t('row.unread') : t('row.read')}
          </span>
          {shown.translationAvailable ? <Badge>{t('row.translated')}</Badge> : null}
          {analysis === null ? null : <Badge tone={analysis.tone}>{t(analysis.label)}</Badge>}
          {waiting ? <WaitingToSync id={waitingId} /> : null}
        </div>

        <h3 className="text-base leading-snug">
          <button
            id={titleId}
            type="button"
            lang={shown.lang ?? undefined}
            aria-expanded={expanded}
            aria-describedby={waiting ? waitingId : undefined}
            onClick={onToggleExpand}
            className={cx(
              'min-h-11 w-full cursor-pointer rounded-md py-1 text-start',
              unread
                ? 'font-semibold text-slate-900 dark:text-slate-50'
                : 'font-normal text-slate-600 dark:text-slate-300',
              FOCUS_RING,
            )}
          >
            {shown.title}
          </button>
        </h3>

        {simple || shown.excerpt === null || shown.excerpt === '' ? null : (
          <p
            lang={shown.lang ?? undefined}
            className="line-clamp-2 text-sm text-slate-700 dark:text-slate-200"
          >
            {shown.excerpt}
          </p>
        )}

        {reason === null && otherSources <= 0 ? null : (
          <div className="flex flex-wrap items-center gap-x-2">
            {reason === null ? null : onWhyThis === undefined ? (
              <Chip>{reason}</Chip>
            ) : (
              <ChipButton
                aria-label={t('row.reasonChip', { reason, action: t('detail.whyThis') })}
                onClick={onWhyThis}
              >
                {reason}
              </ChipButton>
            )}
            {otherSources <= 0 ? null : otherFeeds.length === 0 ? (
              <Chip>{t('row.cluster', { count: otherSources })}</Chip>
            ) : (
              <ChipButton
                aria-expanded={clusterOpen}
                onClick={() => setClusterOpen((open) => !open)}
              >
                {t('row.cluster', { count: otherSources })}
              </ChipButton>
            )}
          </div>
        )}

        {clusterOpen && otherFeeds.length > 0 ? (
          <ul
            role="list"
            aria-label={t('row.clusterFeeds')}
            className="list-disc ps-5 text-sm text-slate-700 dark:text-slate-200"
          >
            {otherFeeds.map((title, index) => (
              <li key={`${index}:${title}`}>{title}</li>
            ))}
          </ul>
        ) : null}

        {assigned.length + suggested.length === 0 ? null : (
          <ul
            role="list"
            aria-label={t('row.labels')}
            className="flex flex-wrap items-center gap-x-2"
          >
            {assigned.map((label) => (
              <li key={label.id}>
                <Chip>
                  <LabelDot color={label.color} />
                  {label.name}
                </Chip>
              </li>
            ))}
            {suggested.map((label) => (
              <li key={label.id}>
                <ChipButton
                  dashed
                  aria-label={t('row.addLabel', { name: label.name })}
                  onClick={() => actions.addLabel(label.id)}
                >
                  <PlusIcon className="size-3" />
                  {label.name}
                </ChipButton>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-1">
          <RateButtons rating={shown.rating} onRate={actions.rate} />
          <BookmarkButton
            bookmarked={shown.bookmarkedAt !== null}
            onToggle={actions.toggleBookmark}
          />
        </div>
      </div>

      {thumbnail === null ? null : (
        <img
          src={thumbnail.href}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-20 shrink-0 rounded-lg object-cover"
        />
      )}
    </SwipeRow>
  );
}
