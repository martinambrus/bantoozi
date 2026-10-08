import type {
  ArticleCounts,
  ArticleListItem,
  Subscription,
  UserPreferences,
} from '@bantoozi/shared';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/button.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { LABEL_CLASSES } from '../../components/field.js';
import { IconButton } from '../../components/icon-button.js';
import { MoreIcon, RefreshIcon } from '../../components/icons.js';
import { Menu, MenuItem } from '../../components/menu.js';
import { SegmentedControl } from '../../components/segmented-control.js';
import { Select } from '../../components/select.js';
import { Switch } from '../../components/switch.js';
import { useMe } from '../../session/context.js';
import { ClassificationBadge } from '../feeds/feed-status.js';
import { MarkAllRead } from './mark-all-read.js';
import { SCOPED_LANES, type ScopedLane } from './lanes.js';
import { useSettingsWriter } from './reader-state.js';
import { countOf, markReadLane, scopeOf, usesSort, usesTier, type ReaderView } from './view.js';

type Tier = 1 | 2 | 3 | 4 | 5;

interface TierSliderProps {
  preferences: UserPreferences;
  onChange: (tier: Tier) => void;
}

/**
 * The account follows a move of the slider a moment later than the hand, and a slider that waits
 * for it jumps back and forth. So it shows where the hand put it until the account has changed,
 * which a refusal does too.
 */
function TierSlider({ preferences, onChange }: TierSliderProps) {
  const { t } = useTranslation('reader');
  const id = useId();
  const [moved, setMoved] = useState<{ basis: UserPreferences; tier: Tier } | null>(null);
  if (moved !== null && moved.basis !== preferences) setMoved(null);
  const tier = moved?.basis === preferences ? moved.tier : preferences.defaultTier;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL_CLASSES}>
        {t('header.tier')}
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={1}
          max={5}
          step={1}
          value={tier}
          aria-valuetext={t('header.tierValue', { tier })}
          onChange={(event) => {
            const next = Number(event.target.value) as Tier;
            setMoved({ basis: preferences, tier: next });
            onChange(next);
          }}
          className={cx(
            'h-11 w-40 cursor-pointer accent-indigo-600 dark:accent-indigo-400',
            FOCUS_RING,
          )}
        />
        <span aria-hidden="true" className="w-8 text-sm font-semibold tabular-nums">
          {t('header.tierShort', { tier })}
        </span>
      </div>
    </div>
  );
}

export interface ReaderHeaderProps {
  view: ReaderView;
  /** What the view is called. */
  title: string;
  /** The subscription of a feed view. */
  subscription: Subscription | undefined;
  /** The counts of the view's scope. */
  counts: ArticleCounts | undefined;
  /** The articles of the view that are loaded. */
  items: readonly ArticleListItem[];
  /** Changes the lane of a feed, folder or label view. */
  onLaneChange: ((lane: ScopedLane) => void) | undefined;
  /** Starts the list and the counts again. */
  refresh: () => void;
}

/** The title and count of the view, and what the reader can do with it (spec 09 §3.1). */
export function ReaderHeader({
  view,
  title,
  subscription,
  counts,
  items,
  onLaneChange,
  refresh,
}: ReaderHeaderProps) {
  const { t } = useTranslation('reader');
  const navigate = useNavigate();
  const { preferences } = useMe();
  const settings = useSettingsWriter();
  const lane = markReadLane(view.lane);
  const count = counts === undefined ? undefined : countOf(counts, view.lane);
  const countKey =
    view.lane === 'bookmarks'
      ? 'header.saved'
      : view.lane === 'hidden'
        ? 'header.hidden'
        : 'header.unread';
  const laneName = t(`lanes.${view.lane}`);
  const titleId = useId();

  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 id={titleId} className="min-w-0 break-words text-2xl font-bold">
          {title}
        </h1>
        {subscription === undefined ? null : (
          <ClassificationBadge mode={subscription.inferenceMode} />
        )}
        {count === undefined ? null : (
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
            {t(countKey, { value: count })}
          </p>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={refresh}>
            <RefreshIcon className="size-4" />
            {t('header.refresh')}
          </Button>
          {lane === null ? null : (
            <MarkAllRead
              lane={lane}
              scope={scopeOf(view)}
              name={
                view.kind === 'lane' || view.lane === 'all'
                  ? title
                  : t('markAll.view', { name: title, lane: laneName })
              }
              count={count}
              items={items}
              onChanged={refresh}
            />
          )}
          <Menu
            align="end"
            trigger={(props) => (
              <IconButton {...props} label={t('common:actions.more')}>
                <MoreIcon />
              </IconButton>
            )}
          >
            <MenuItem
              onSelect={() => void navigate({ to: '/read/$lane', params: { lane: 'hidden' } })}
            >
              {t('header.showHidden')}
            </MenuItem>
          </Menu>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        {view.kind === 'lane' || onLaneChange === undefined ? null : (
          <Select
            label={t('header.show')}
            value={view.lane}
            onChange={(event) => onLaneChange(event.target.value as ScopedLane)}
            className="w-44"
          >
            {SCOPED_LANES.map((option) => (
              <option key={option} value={option}>
                {t(`lanes.${option}`)}
              </option>
            ))}
          </Select>
        )}
        {usesTier(view.lane) ? (
          <TierSlider
            preferences={preferences}
            onChange={(defaultTier) => settings.change({ defaultTier })}
          />
        ) : null}
        {usesSort(view.lane) ? (
          <SegmentedControl
            label={t('header.sort')}
            options={[
              { value: 'score', label: t('header.sortScore') },
              { value: 'date', label: t('header.sortDate') },
            ]}
            value={preferences.sort}
            onValueChange={(sort) => settings.change({ sort })}
          />
        ) : null}
        <Switch
          label={t('header.simple')}
          checked={preferences.simpleMode}
          onCheckedChange={(simpleMode) => settings.change({ simpleMode })}
        />
      </div>
    </div>
  );
}
