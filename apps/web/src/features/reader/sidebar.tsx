import {
  hasAgreement,
  normalizeText,
  type ArticleCounts,
  type LearningFeedAgreement,
  type Subscription,
} from '@bantoozi/shared';
import { useQueryClient, type RefetchOptions } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidateCoalesced } from '../../api/coalesced-invalidate.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { IconButton } from '../../components/icon-button.js';
import {
  BookmarkIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FeedIcon,
  HelpIcon,
  InboxIcon,
  LightbulbIcon,
  ListIcon,
  SettingsIcon,
  StarIcon,
  WarningIcon,
} from '../../components/icons.js';
import { Tooltip } from '../../components/tooltip.js';
import { useOnline } from '../../components/states/use-online.js';
import { VisuallyHidden } from '../../components/visually-hidden.js';
import { useAccountId, useMe } from '../../session/context.js';
import { LabelDot } from '../article/label-dot.js';
import { useLabels } from '../article/use-labels.js';
import { FeedFavicon } from '../feeds/feed-favicon.js';
import { ReadyForAutomatic } from '../feeds/ready-for-automatic.js';
import { FeedSettingsSheet } from '../feeds/feed-settings-sheet.js';
import { ClassificationBadge } from '../feeds/feed-status.js';
import { displayTitle, groupByFolder, type FolderGroup } from '../feeds/folders.js';
import { useSubscriptions } from '../feeds/subscriptions.js';
import { CardEditor } from '../interests/card-editor.js';
import { useDismissCardHint } from '../learning/use-dismiss-card-hint.js';
import { learningKey, useLearning } from '../learning/use-learning.js';
import { useReconnect } from '../offline/use-connection.js';
import { useSettledActions } from './actions/provider.js';
import { FeedFilter } from './feed-filter.js';
import type { Lane } from './lanes.js';
import { useEverythingOpen, useFeedFilter } from './reader-state.js';
import { countOf } from './view.js';

// The current view is bold, tinted and has a bar, so it never rides on colour alone.
const LINK = cx(
  'flex min-h-11 min-w-0 items-center gap-2 rounded-lg border-s-4 border-transparent px-3 text-sm font-medium text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
  'aria-[current=page]:border-indigo-600 aria-[current=page]:bg-indigo-50 aria-[current=page]:font-semibold aria-[current=page]:text-indigo-900 dark:aria-[current=page]:border-indigo-300 dark:aria-[current=page]:bg-indigo-950 dark:aria-[current=page]:text-indigo-100',
  FOCUS_RING,
);

const HEADING =
  'px-3 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300';
const MUTED = 'px-3 text-sm text-slate-600 dark:text-slate-300';

// Search parameters belong to the view, not to the link that leads to it.
const CURRENT = { exact: true, includeSearch: false } as const;

/** The number of unread (or saved) articles after a name: the words are for assistive technology. */
function Count({ label, value }: { label: string; value: number }) {
  if (value <= 0) return null;
  return (
    <>
      {' '}
      <VisuallyHidden>{label}</VisuallyHidden>{' '}
      <span className="ms-auto rounded-full bg-slate-200 px-2 text-xs font-semibold tabular-nums text-slate-900 dark:bg-slate-700 dark:text-slate-100">
        {value}
      </span>
    </>
  );
}

interface LaneLinkProps {
  lane: Lane;
  counts: ArticleCounts | undefined;
  onNavigate?: (() => void) | undefined;
}

function LaneLink({ lane, counts, onNavigate }: LaneLinkProps) {
  const { t } = useTranslation('reader');
  return (
    <Link
      to="/read/$lane"
      params={{ lane }}
      activeOptions={CURRENT}
      onClick={onNavigate}
      className={LINK}
    >
      <span className="truncate">{t(`lanes.${lane}`)}</span>
      {lane === 'maybe' ? (
        <>
          {' '}
          <Badge tone="info">{t('lanes.helpMeLearn')}</Badge>
        </>
      ) : null}
      <Count
        label={t(lane === 'bookmarks' ? 'sidebar.saved' : 'sidebar.unread')}
        value={counts === undefined ? 0 : countOf(counts, lane)}
      />
    </Link>
  );
}

function EverythingRow({ counts, onNavigate }: Omit<LaneLinkProps, 'lane'>) {
  const { t } = useTranslation('reader');
  const [open, setOpen] = useEverythingOpen();
  return (
    <li className="flex items-center gap-1">
      <div className="min-w-0 flex-1">
        {open ? (
          <LaneLink lane="everything" counts={counts} onNavigate={onNavigate} />
        ) : (
          <span className="flex min-h-11 items-center px-3 text-sm font-medium text-slate-600 dark:text-slate-300">
            {t('lanes.everything')}
          </span>
        )}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('sidebar.everythingToggle')}
        onClick={() => setOpen((current) => !current)}
        className={cx(
          'grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
          FOCUS_RING,
        )}
      >
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
      </button>
    </li>
  );
}

interface LaneListProps {
  counts: ArticleCounts | undefined;
  /** Whether Everything else folds away (the sidebar); the top bar always lists it. */
  foldable: boolean;
  className?: string | undefined;
  onNavigate?: (() => void) | undefined;
}

/** For you, Maybe, Everything else (unless hidden), New and Bookmarks, with their counts. */
function LaneList({ counts, foldable, className, onNavigate }: LaneListProps) {
  const { t } = useTranslation('reader');
  const { hideEverything } = useMe().preferences;
  const lanes = (['for_you', 'maybe', 'everything', 'new', 'bookmarks'] as const).filter(
    (lane) => lane !== 'everything' || !hideEverything,
  );
  return (
    <ul role="list" aria-label={t('sidebar.lanes')} className={className}>
      {lanes.map((lane) =>
        lane === 'everything' && foldable ? (
          <EverythingRow key={lane} counts={counts} onNavigate={onNavigate} />
        ) : (
          <li key={lane} className={cx('min-w-0', !foldable && 'shrink-0')}>
            <LaneLink lane={lane} counts={counts} onNavigate={onNavigate} />
          </li>
        ),
      )}
    </ul>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: (headingId: string) => ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="flex flex-col gap-1">
      <h2 id={headingId} className={HEADING}>
        {title}
      </h2>
      {children(headingId)}
    </section>
  );
}

function Retry({ label, onRetry }: { label: string; onRetry: () => void }) {
  const { t } = useTranslation('reader');
  return (
    <div className="px-3">
      <Button variant="secondary" size="sm" aria-label={label} onClick={onRetry}>
        {t('common:actions.retry')}
      </Button>
    </div>
  );
}

function unreadOf({ unread }: Subscription): number {
  return unread.forYou + unread.maybe + unread.everything + unread.new;
}

/** Whether the analysis of a feed finds likes that every card rates low, with articles to draft from. */
function suggestsInterest(agreement: LearningFeedAgreement | undefined): boolean {
  return (
    agreement !== undefined &&
    agreement.uncovered.suggest &&
    agreement.uncovered.articles.length > 0
  );
}

/** Whether the analysis of a feed finds dislikes that no Never card hides, with articles to draft from. */
function suggestsNever(agreement: LearningFeedAgreement | undefined): boolean {
  return (
    agreement !== undefined && agreement.unwanted.suggest && agreement.unwanted.articles.length > 0
  );
}

/**
 * The analysis of the feeds in training, by feed id. Nothing is asked while no subscription is in
 * training; a settled rating makes the agreement stale.
 */
function useTrainingFeeds(
  subscriptions: readonly Subscription[],
): Map<string, LearningFeedAgreement> {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const training = subscriptions.some((subscription) => subscription.inferenceMode === 'training');
  const learning = useLearning(training);
  useSettledActions((handle) => {
    if (handle.action.type !== 'rate' || !training) return;
    invalidateCoalesced(queryClient, learningKey(accountId));
  });
  return useMemo(() => {
    const trainingIds = new Set(
      subscriptions
        .filter((subscription) => subscription.inferenceMode === 'training')
        .map((subscription) => subscription.feed.id),
    );
    return new Map(
      (training ? (learning.data?.feeds ?? []) : [])
        .filter(hasAgreement)
        .filter((agreement) => trainingIds.has(agreement.feedId))
        .map((agreement) => [agreement.feedId, agreement]),
    );
  }, [training, learning.data, subscriptions]);
}

// `.group` is the feed's row: away from it and without the focus, the button folds to nothing.
// Tailwind finds only whole class names in the source, so each one is written out.
const SETTINGS_BUTTON = cx(
  'shrink-0 text-slate-500 dark:text-slate-400',
  '[@media(hover:hover)]:[.group:not(:hover)_&:not(:focus-visible)]:w-0',
  '[@media(hover:hover)]:[.group:not(:hover)_&:not(:focus-visible)]:min-w-0',
  '[@media(hover:hover)]:[.group:not(:hover)_&:not(:focus-visible)]:overflow-hidden',
  '[@media(hover:hover)]:[.group:not(:hover)_&:not(:focus-visible)]:p-0',
  '[@media(hover:hover)]:[.group:not(:hover)_&:not(:focus-visible)]:opacity-0',
);

/**
 * The lightbulb of a feed whose likes no card covers: says so in a tooltip and opens the card editor
 * drafted from those articles (D-241), the same as "Make an interest from these" in the feed drawer.
 */
function InterestHint({
  agreement,
  feedTitle,
}: {
  agreement: LearningFeedAgreement;
  feedTitle: string;
}) {
  const { t } = useTranslation('reader');
  const [making, setMaking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dismiss = useDismissCardHint();
  return (
    <>
      <Tooltip text={t('sidebar.interestsToAddHint', { count: agreement.uncovered.count })}>
        {(tooltip) => (
          <IconButton
            {...tooltip}
            ref={button}
            label={t('feeds:uncovered.makeLabel', { title: feedTitle })}
            onClick={() => setMaking(true)}
            className="shrink-0 text-amber-700 dark:text-amber-300"
          >
            <LightbulbIcon className="size-4" />
          </IconButton>
        )}
      </Tooltip>
      {making ? (
        <CardEditor
          fromArticles={agreement.uncovered.articles}
          onNotNow={() => dismiss(agreement.feedId, 'interest')}
          returnFocus={() => button.current}
          onClose={() => setMaking(false)}
        />
      ) : null}
    </>
  );
}

/** The eye of a feed whose dislikes no Never card hides: opens the card editor on Never, drafted from those articles. */
function NeverHint({
  agreement,
  feedTitle,
}: {
  agreement: LearningFeedAgreement;
  feedTitle: string;
}) {
  const { t } = useTranslation('reader');
  const [making, setMaking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dismiss = useDismissCardHint();
  return (
    <>
      <Tooltip text={t('sidebar.topicsToAvoidHint', { count: agreement.unwanted.count })}>
        {(tooltip) => (
          <IconButton
            {...tooltip}
            ref={button}
            label={t('feeds:unwanted.makeLabel', { title: feedTitle })}
            onClick={() => setMaking(true)}
            className="shrink-0 text-rose-700 dark:text-rose-300"
          >
            <EyeOffIcon className="size-4" />
          </IconButton>
        )}
      </Tooltip>
      {making ? (
        <CardEditor
          fromArticles={agreement.unwanted.articles}
          initialStrength="never"
          onNotNow={() => dismiss(agreement.feedId, 'never')}
          returnFocus={() => button.current}
          onClose={() => setMaking(false)}
        />
      ) : null}
    </>
  );
}

function FeedLink({
  subscription,
  agreement,
  onNavigate,
  onOpenSettings,
}: {
  subscription: Subscription;
  agreement: LearningFeedAgreement | undefined;
  onNavigate?: (() => void) | undefined;
  onOpenSettings: (feedId: string) => void;
}) {
  const { t } = useTranslation('reader');
  const { feed } = subscription;
  const name = displayTitle(subscription);
  // A long badge would squeeze the name to a few letters: it goes below it, and a line ends the feed.
  const badgeBelow = subscription.inferenceMode !== 'off';
  const badge = <ClassificationBadge mode={subscription.inferenceMode} />;
  return (
    <li
      className={cx(
        'group',
        badgeBelow && 'mb-1 border-b border-slate-200 pb-2 dark:border-slate-700',
      )}
    >
      <div className="flex items-center gap-1">
        <Link
          to="/read/feed/$feedId"
          params={{ feedId: feed.id }}
          activeOptions={CURRENT}
          onClick={onNavigate}
          title={name}
          className={cx(LINK, 'flex-1')}
        >
          <FeedFavicon iconUrl={feed.iconUrl} imagesAllowed={subscription.effectiveImagesAllowed} />
          <span className="truncate">{name}</span>
          <Count label={t('sidebar.unread')} value={unreadOf(subscription)} />
        </Link>
        {badgeBelow ? null : badge}
        {feed.status === 'quarantined' ? (
          <span
            role="img"
            aria-label={`${t('feeds:row.statusLabel')} ${t('feeds:status.quarantined')}`}
            className="grid size-6 shrink-0 place-items-center text-amber-700 dark:text-amber-300"
          >
            <WarningIcon className="size-4" />
          </span>
        ) : null}
        {/* Where a pointer can hover, it takes no room until the feed is hovered or it has the
            focus, so the name keeps its width; on touch screens it is always there. */}
        <IconButton
          label={t('feeds:row.settingsFor', { title: name })}
          title={t('feeds:row.settings')}
          data-feed-settings={feed.id}
          onClick={() => onOpenSettings(feed.id)}
          className={SETTINGS_BUTTON}
        >
          <SettingsIcon className="size-4" />
        </IconButton>
        {/* Last, so the gear appearing on hover does not move it. */}
        {suggestsInterest(agreement) ? (
          <InterestHint agreement={agreement!} feedTitle={name} />
        ) : null}
        {suggestsNever(agreement) ? <NeverHint agreement={agreement!} feedTitle={name} /> : null}
      </div>
      {badgeBelow ? <div className="ps-4">{badge}</div> : null}
      {agreement?.status !== 'ready' ? null : (
        <div className="ps-4 pt-1">
          <ReadyForAutomatic subscription={subscription} agreement={agreement} />
        </div>
      )}
    </li>
  );
}

type Refetch = (options: RefetchOptions) => unknown;

/**
 * Asks for a section's data again while it has none and the browser reports a connection, as its
 * offline text promises. TanStack does that only for a page it saw go offline, not one that started
 * offline.
 */
function useReloadOnReconnect({ data, refetch }: { data: unknown; refetch: Refetch }) {
  const retry = useCallback(() => void refetch({ cancelRefetch: false }), [refetch]);
  useReconnect(data === undefined, retry);
}

/** A folder, and those of its feeds whose titles match the filter. */
interface Shown {
  group: FolderGroup;
  feeds: Subscription[];
}

function FeedsSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t, i18n } = useTranslation('reader');
  const { folderOrder } = useMe().preferences;
  const subscriptions = useSubscriptions();
  const online = useOnline();
  useReloadOnReconnect(subscriptions);
  const learning = useTrainingFeeds(subscriptions.data ?? []);
  const [filter] = useFeedFilter();
  const [settingsFeedId, setSettingsFeedId] = useState<string | null>(null);
  const settings = subscriptions.data?.find(
    (subscription) => subscription.feed.id === settingsFeedId,
  );
  // The settings offer every folder, also those whose feeds are all hidden from the sidebar.
  const folders = useMemo(
    () =>
      groupByFolder(subscriptions.data ?? [], folderOrder, i18n.language).flatMap((group) =>
        group.name === null ? [] : [group.name],
      ),
    [subscriptions.data, folderOrder, i18n.language],
  );
  const groups = useMemo(
    () =>
      groupByFolder(
        (subscriptions.data ?? []).filter((subscription) => !subscription.hidden),
        folderOrder,
        i18n.language,
      ),
    [subscriptions.data, folderOrder, i18n.language],
  );
  const shown = useMemo((): Shown[] => {
    const wanted = normalizeText(filter);
    return groups.flatMap((group) => {
      const feeds =
        wanted === ''
          ? group.feeds
          : group.feeds.filter((subscription) =>
              normalizeText(displayTitle(subscription)).includes(wanted),
            );
      return feeds.length === 0 ? [] : [{ group, feeds }];
    });
  }, [groups, filter]);

  return (
    <>
      <Section title={t('sidebar.feeds')}>
        {(headingId) => {
          if (subscriptions.data === undefined) {
            return !online || subscriptions.isError ? (
              <>
                <p className={MUTED}>
                  {t(online ? 'sidebar.feedsFailed' : 'sidebar.feedsOffline')}
                </p>
                <Retry
                  label={t('sidebar.retryFeeds')}
                  onRetry={() => void subscriptions.refetch()}
                />
              </>
            ) : (
              <p className={MUTED}>{t('common:states.loading')}</p>
            );
          }
          if (groups.length === 0) return <p className={MUTED}>{t('sidebar.noFeeds')}</p>;
          return (
            <>
              <FeedFilter noMatch={shown.length === 0} />
              {shown.length === 0 ? null : (
                <ul role="list" aria-labelledby={headingId} className="flex flex-col">
                  {shown.map(({ group, feeds }) =>
                    group.name === null ? (
                      feeds.map((subscription) => (
                        <FeedLink
                          key={subscription.feed.id}
                          subscription={subscription}
                          agreement={learning.get(subscription.feed.id)}
                          onNavigate={onNavigate}
                          onOpenSettings={setSettingsFeedId}
                        />
                      ))
                    ) : (
                      <li key={group.name}>
                        <Link
                          to="/read/folder/$name"
                          params={{ name: group.name }}
                          activeOptions={CURRENT}
                          onClick={onNavigate}
                          title={group.name}
                          className={LINK}
                        >
                          <span className="truncate">{group.name}</span>
                          <Count
                            label={t('sidebar.unread')}
                            value={group.feeds.reduce(
                              (sum, subscription) => sum + unreadOf(subscription),
                              0,
                            )}
                          />
                        </Link>
                        <ul
                          role="list"
                          className="ms-3 flex flex-col border-s border-slate-200 dark:border-slate-700"
                        >
                          {feeds.map((subscription) => (
                            <FeedLink
                              key={subscription.feed.id}
                              subscription={subscription}
                              agreement={learning.get(subscription.feed.id)}
                              onNavigate={onNavigate}
                              onOpenSettings={setSettingsFeedId}
                            />
                          ))}
                        </ul>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </>
          );
        }}
      </Section>
      {settings === undefined ? null : (
        <FeedSettingsSheet
          key={settings.feed.id}
          subscription={settings}
          folders={folders}
          onSaved={() => {}}
          onClose={() => setSettingsFeedId(null)}
        />
      )}
    </>
  );
}

function LabelsSection({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t } = useTranslation('reader');
  const labels = useLabels(true);
  const online = useOnline();
  useReloadOnReconnect(labels);

  return (
    <Section title={t('sidebar.labels')}>
      {(headingId) => {
        if (labels.data === undefined) {
          return !online || labels.isError ? (
            <>
              <p className={MUTED}>
                {t(online ? 'sidebar.labelsFailed' : 'sidebar.labelsOffline')}
              </p>
              <Retry label={t('sidebar.retryLabels')} onRetry={() => void labels.refetch()} />
            </>
          ) : (
            <p className={MUTED}>{t('common:states.loading')}</p>
          );
        }
        if (labels.data.length === 0) return <p className={MUTED}>{t('sidebar.noLabels')}</p>;
        return (
          <ul role="list" aria-labelledby={headingId} className="flex flex-col">
            {labels.data.map((label) => (
              <li key={label.id}>
                <Link
                  to="/read/label/$labelId"
                  params={{ labelId: label.id }}
                  activeOptions={CURRENT}
                  onClick={onNavigate}
                  title={label.name}
                  className={LINK}
                >
                  <LabelDot color={label.color} />
                  <span className="truncate">{label.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        );
      }}
    </Section>
  );
}

export interface ReaderSidebarProps {
  /** The id of the navigation, for the button that collapses it. */
  id?: string | undefined;
  counts: ArticleCounts | undefined;
  /** The lanes are in the top bar instead (narrow screens). */
  withoutLanes?: boolean;
  /** Called when a link was followed, to close the sheet the sidebar is in. */
  onNavigate?: (() => void) | undefined;
}

/** Lanes, then the feeds by folder, then the labels (spec 09 §3.1). */
export function ReaderSidebar({
  id,
  counts,
  withoutLanes = false,
  onNavigate,
}: ReaderSidebarProps) {
  const { t } = useTranslation('reader');
  return (
    <nav id={id} aria-label={t('sidebar.label')} className="flex flex-col gap-6">
      {withoutLanes ? null : (
        <LaneList counts={counts} foldable className="flex flex-col" onNavigate={onNavigate} />
      )}
      <FeedsSection onNavigate={onNavigate} />
      <LabelsSection onNavigate={onNavigate} />
    </nav>
  );
}

const COMPACT_LINK = cx(
  'relative grid size-11 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
  'aria-[current=page]:bg-indigo-50 aria-[current=page]:text-indigo-900 dark:aria-[current=page]:bg-indigo-950 dark:aria-[current=page]:text-indigo-100',
  FOCUS_RING,
);

const DIVIDER = 'mx-2 border-t border-slate-200 dark:border-slate-700';

const LANE_ICONS = {
  for_you: StarIcon,
  maybe: HelpIcon,
  everything: ListIcon,
  new: InboxIcon,
  bookmarks: BookmarkIcon,
} as const;

/** The name of a collapsed entry with what its full row would say: the number and the states. */
function compactName(name: string, extras: readonly (string | null)[]): string {
  return [name, ...extras.filter((extra) => extra !== null)].join(', ');
}

/** A dot for unread (or saved) articles; the number is in the name of the link. */
function CompactDot({ shown }: { shown: boolean }) {
  return shown ? (
    <span
      aria-hidden="true"
      className="absolute end-1 top-1 size-2 rounded-full bg-indigo-600 dark:bg-indigo-300"
    />
  ) : null;
}

function CompactLanes({ counts }: { counts: ArticleCounts | undefined }) {
  const { t } = useTranslation('reader');
  const { hideEverything } = useMe().preferences;
  const [everythingOpen] = useEverythingOpen();
  const lanes = (['for_you', 'maybe', 'everything', 'new', 'bookmarks'] as const).filter(
    (lane) => lane !== 'everything' || (!hideEverything && everythingOpen),
  );
  return (
    <ul role="list" aria-label={t('sidebar.lanes')} className="flex flex-col items-center gap-1">
      {lanes.map((lane) => {
        const Icon = LANE_ICONS[lane];
        const count = counts === undefined ? 0 : countOf(counts, lane);
        const label = compactName(t(`lanes.${lane}`), [
          count > 0
            ? `${t(lane === 'bookmarks' ? 'sidebar.saved' : 'sidebar.unread')} ${count}`
            : null,
        ]);
        return (
          <li key={lane}>
            <Link
              to="/read/$lane"
              params={{ lane }}
              activeOptions={CURRENT}
              aria-label={label}
              title={label}
              className={COMPACT_LINK}
            >
              <Icon />
              <CompactDot shown={count > 0} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CompactFeeds() {
  const { t, i18n } = useTranslation('reader');
  const { folderOrder } = useMe().preferences;
  const subscriptions = useSubscriptions();
  useReloadOnReconnect(subscriptions);
  const learning = useTrainingFeeds(subscriptions.data ?? []);
  const feeds = useMemo(
    () =>
      groupByFolder(
        (subscriptions.data ?? []).filter((subscription) => !subscription.hidden),
        folderOrder,
        i18n.language,
      ).flatMap((group) => group.feeds),
    [subscriptions.data, folderOrder, i18n.language],
  );
  if (feeds.length === 0) return null;
  return (
    <ul role="list" aria-label={t('sidebar.feeds')} className="flex flex-col items-center gap-1">
      {feeds.map((subscription) => {
        const name = displayTitle(subscription);
        const unread = unreadOf(subscription);
        const label = compactName(name, [
          subscription.inferenceMode === 'off'
            ? null
            : t(`feeds:mode.${subscription.inferenceMode}`),
          subscription.feed.status === 'quarantined' ? t('feeds:status.quarantined') : null,
          learning.get(subscription.feed.id)?.status === 'ready'
            ? t('sidebar.readyForAutomatic')
            : null,
          suggestsInterest(learning.get(subscription.feed.id))
            ? t('sidebar.interestsToAddShort')
            : null,
          suggestsNever(learning.get(subscription.feed.id))
            ? t('sidebar.topicsToAvoidShort')
            : null,
          unread > 0 ? `${t('sidebar.unread')} ${unread}` : null,
        ]);
        return (
          <li key={subscription.feed.id}>
            <Link
              to="/read/feed/$feedId"
              params={{ feedId: subscription.feed.id }}
              activeOptions={CURRENT}
              aria-label={label}
              title={label}
              className={COMPACT_LINK}
            >
              <FeedFavicon
                iconUrl={subscription.feed.iconUrl}
                imagesAllowed={subscription.effectiveImagesAllowed}
              />
              <CompactDot shown={unread > 0} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CompactLabels() {
  const { t } = useTranslation('reader');
  const labels = useLabels(true);
  useReloadOnReconnect(labels);
  if (labels.data === undefined || labels.data.length === 0) return null;
  return (
    <ul role="list" aria-label={t('sidebar.labels')} className="flex flex-col items-center gap-1">
      {labels.data.map((label) => (
        <li key={label.id}>
          <Link
            to="/read/label/$labelId"
            params={{ labelId: label.id }}
            activeOptions={CURRENT}
            aria-label={label.name}
            title={label.name}
            className={COMPACT_LINK}
          >
            <span
              aria-hidden="true"
              className="size-3 rounded-full"
              style={{ backgroundColor: label.color }}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The collapsed sidebar of a wide screen (D-235): the lanes as icons, the feeds as their icons or
 * first letters, the labels as their colours. Every link is named in full, with its count.
 */
export function CompactSidebar({
  id,
  counts,
}: {
  id?: string | undefined;
  counts: ArticleCounts | undefined;
}) {
  const { t } = useTranslation('reader');
  return (
    <nav id={id} aria-label={t('sidebar.label')} className="flex flex-col gap-3">
      <CompactLanes counts={counts} />
      <hr className={DIVIDER} />
      <CompactFeeds />
      <hr className={DIVIDER} />
      <CompactLabels />
    </nav>
  );
}

/** The top bar of a narrow screen: the lanes with their counts, and the button for the rest. */
export function LaneSwitcher({
  counts,
  onBrowse,
}: {
  counts: ArticleCounts | undefined;
  onBrowse: () => void;
}) {
  const { t } = useTranslation('reader');
  return (
    <nav
      aria-label={t('topBar.label')}
      className="flex items-center gap-1 border-b border-slate-200 px-2 py-1 dark:border-slate-800"
    >
      <IconButton label={t('topBar.browse')} aria-haspopup="dialog" onClick={onBrowse}>
        <FeedIcon />
      </IconButton>
      <LaneList
        counts={counts}
        foldable={false}
        className="relative flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      />
    </nav>
  );
}
