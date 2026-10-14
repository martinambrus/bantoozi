import type { ArticleCounts, ArticleListItem } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../components/cx.js';
import { IconButton } from '../../components/icon-button.js';
import { SidebarIcon } from '../../components/icons.js';
import { Sheet } from '../../components/sheet.js';
import { useAccountId, useMe } from '../../session/context.js';
import { DeadFeedBanner } from '../feeds/dead-feed-banner.js';
import { WhyThisSheet } from '../why/why-this-sheet.js';
import { useObserveItems, useReaderActions } from './actions/provider.js';
import { ArticleList, useVisibleRows } from './article-list.js';
import { DetailPane } from './detail-pane.js';
import { ReaderHeader } from './header.js';
import type { ScopedLane } from './lanes.js';
import { NewArticlesBanner } from './new-articles-banner.js';
import { unreadKeys, useCounts } from './queries.js';
import { ReaderShortcuts } from './shortcuts/reader-shortcuts.js';
import { useSidebarCollapsed } from './sidebar-collapsed.js';
import { CompactSidebar, LaneSwitcher, ReaderSidebar } from './sidebar.js';
import { useArticleList } from './use-article-list.js';
import { useDesktop } from './use-desktop.js';
import { usePolling } from './use-polling.js';
import { useViewTitle } from './use-view-title.js';
import { countOf, detailScope, scopeOf, viewKey, type ReaderView } from './view.js';

/** How far down the page the reader may be for the list to still count as being at its top. */
const TOP_PX = 80;

export interface ReaderPageProps {
  view: ReaderView;
  /** Narrows a feed, folder or label view to one of its lanes; the lane routes have none. */
  onLaneChange?: ((lane: ScopedLane) => void) | undefined;
}

interface ReaderFrameProps {
  /** The counts of the whole account, which the lanes show. */
  counts: ArticleCounts | undefined;
  children: ReactNode;
}

/** The sidebar and the page beside it on a wide screen; on a narrow one a top bar and a sheet. */
function ReaderFrame({ counts, children }: ReaderFrameProps) {
  const { t } = useTranslation('reader');
  const desktop = useDesktop();
  const [browsing, setBrowsing] = useState(false);
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const sidebarId = useId();

  if (desktop) {
    return (
      <div className="mx-auto flex w-full max-w-[96rem] items-start gap-6 px-4 py-4">
        <div
          className={cx(
            'sticky top-[calc(4rem+var(--update-bar-height,0px))] flex max-h-[calc(100dvh-5rem-var(--update-bar-height,0px))] shrink-0 flex-col gap-2 overflow-y-auto',
            collapsed ? 'w-16 items-center' : 'w-64',
          )}
        >
          <IconButton
            label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
            aria-expanded={!collapsed}
            aria-controls={sidebarId}
            onClick={() => setCollapsed(!collapsed)}
            className={collapsed ? undefined : 'self-end'}
          >
            <SidebarIcon />
          </IconButton>
          {collapsed ? (
            <CompactSidebar id={sidebarId} counts={counts} />
          ) : (
            <ReaderSidebar id={sidebarId} counts={counts} />
          )}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    );
  }

  return (
    <>
      <LaneSwitcher counts={counts} onBrowse={() => setBrowsing(true)} />
      <div className="mx-auto w-full max-w-3xl px-4 py-4">{children}</div>
      <Sheet
        open={browsing}
        onClose={() => setBrowsing(false)}
        title={t('topBar.browseTitle')}
        side="bottom"
      >
        <ReaderSidebar counts={counts} withoutLanes onNavigate={() => setBrowsing(false)} />
      </Sheet>
    </>
  );
}

interface ReaderBodyProps extends ReaderPageProps {
  /** The counts of the whole account. */
  everything: ArticleCounts | undefined;
}

function ReaderBody({ view, onLaneChange, everything }: ReaderBodyProps) {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const store = useReaderActions();
  const desktop = useDesktop();
  const { preferences } = useMe();
  const { title, subscription } = useViewTitle(view);
  const list = useArticleList(view, preferences);
  const rows = useVisibleRows(view, list, preferences.showRead);
  const scoped = useCounts(scopeOf(view), preferences.defaultTier);
  useObserveItems(list.items);

  // The article as the list had it when it was opened, for as long as the list no longer has it.
  const [opened, setOpened] = useState<ArticleListItem | null>(null);
  const expanded =
    opened === null ? null : (list.items.find((candidate) => candidate.id === opened.id) ?? opened);

  function toggle(item: ArticleListItem) {
    if (expanded?.id === item.id) {
      setOpened(null);
      return;
    }
    setOpened(item);
    const shown = store.view(item);
    if (preferences.markReadOnExpand && shown.readAt === null) {
      store.dispatch(shown, { type: 'read', trigger: 'expand' });
    }
  }

  // The article whose "Why this?" drawer is open, as the list had it when the drawer was opened.
  const [explaining, setExplaining] = useState<ArticleListItem | null>(null);
  const explained =
    explaining === null
      ? null
      : (list.items.find((candidate) => candidate.id === explaining.id) ?? explaining);

  function explain(item: ArticleListItem) {
    setExplaining(item);
  }

  const { reload, poll } = list;
  const refreshCounts = useCallback(
    () =>
      Promise.all(
        unreadKeys(accountId).map((queryKey) =>
          queryClient
            .refetchQueries({ queryKey, type: 'active' }, { cancelRefetch: false })
            .catch(() => undefined),
        ),
      ),
    [queryClient, accountId],
  );
  // The button stays busy until both are back, and a second press while they are on the way does
  // nothing.
  const [refreshing, setRefreshing] = useState(false);
  const refreshingNow = useRef(false);
  const refresh = useCallback(() => {
    if (refreshingNow.current) return;
    refreshingNow.current = true;
    setRefreshing(true);
    void Promise.all([reload(), refreshCounts()]).finally(() => {
      refreshingNow.current = false;
      setRefreshing(false);
    });
  }, [reload, refreshCounts]);
  const refreshList = useCallback(() => void poll(), [poll]);

  const busy =
    list.rankingPending ||
    everything?.rankingPending === true ||
    scoped.data?.rankingPending === true ||
    list.items.some(
      ({ analysis }) => analysis.status === 'pending' || analysis.status === 'running',
    );
  const pollCounts = useCallback(() => void refreshCounts(), [refreshCounts]);
  usePolling({ busy, refreshList, refreshCounts: pollCounts });

  // D-243: the number the view's counts held when the list was last loaded, and how many articles
  // the counts have added since, which the list loads by itself at the top and offers otherwise.
  const count =
    scoped.data === undefined || scoped.isPlaceholderData
      ? undefined
      : countOf(scoped.data, view.lane);
  const baseline = useRef<number | null>(null);
  const [added, setAdded] = useState(0);
  const addedNow = useRef(0);
  const offer = useCallback((next: number) => {
    if (addedNow.current === next) return;
    addedNow.current = next;
    setAdded(next);
  }, []);
  const latestCount = useRef(count);
  const expandedNow = useRef(expanded !== null);
  useEffect(() => {
    latestCount.current = count;
    expandedNow.current = expanded !== null;
  });
  const { dataUpdatedAt } = list.query;
  const { defaultTier } = preferences;
  useEffect(() => {
    baseline.current = null;
    offer(0);
  }, [defaultTier, offer]);
  useEffect(() => {
    if (dataUpdatedAt === 0) return;
    baseline.current = latestCount.current ?? null;
    offer(0);
  }, [dataUpdatedAt, offer]);
  useEffect(() => {
    if (count === undefined) return;
    const known = baseline.current;
    if (known === null) {
      baseline.current = count;
      return;
    }
    if (count <= known) {
      offer(0);
      return;
    }
    if (window.scrollY <= TOP_PX && !expandedNow.current) {
      baseline.current = count;
      offer(0);
      void reload();
      return;
    }
    offer(count - known);
  }, [count, reload, offer]);
  const showNew = useCallback(() => {
    window.scrollTo({ top: 0 });
    void reload();
  }, [reload]);

  return (
    <ReaderShortcuts
      rows={rows}
      list={list}
      expanded={expanded}
      onExpand={toggle}
      onWhyThis={explain}
    >
      <div className="flex flex-col gap-4">
        <ReaderHeader
          view={view}
          title={title}
          subscription={subscription}
          counts={scoped.data}
          items={list.items}
          visible={rows.staying}
          onLaneChange={onLaneChange}
          refresh={refresh}
          refreshing={refreshing}
          rankingPending={
            list.rankingPending ||
            everything?.rankingPending === true ||
            scoped.data?.rankingPending === true
          }
        />
        {subscription === undefined ? null : (
          <DeadFeedBanner feed={subscription.feed} title={title} />
        )}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
          <div className="flex min-w-0 flex-col gap-3">
            <NewArticlesBanner count={added} onShow={showNew} />
            <ArticleList
              view={view}
              list={list}
              rows={rows}
              expandedId={expanded?.id ?? null}
              onToggle={toggle}
              onWhyThis={explain}
              simple={preferences.simpleMode}
            />
          </div>
          <DetailPane
            view={view}
            item={expanded}
            desktop={desktop}
            onClose={() => setOpened(null)}
            onWhyThis={explain}
          />
        </div>
        {explained === null ? null : (
          <WhyThisSheet
            item={explained}
            {...detailScope(view, explained)}
            open
            onClose={() => setExplaining(null)}
          />
        )}
      </div>
    </ReaderShortcuts>
  );
}

/**
 * The reader (spec 09 §3.1): the sidebar, and beside it the title and settings of the view, its
 * articles, and the article that is open.
 */
export function ReaderPage({ view, onLaneChange }: ReaderPageProps) {
  const { preferences } = useMe();
  const everything = useCounts({}, preferences.defaultTier);
  return (
    <ReaderFrame counts={everything.data}>
      <ReaderBody
        key={viewKey(view)}
        view={view}
        onLaneChange={onLaneChange}
        everything={everything.data}
      />
    </ReaderFrame>
  );
}
