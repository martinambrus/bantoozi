import type { ArticleCounts, ArticleListItem } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Sheet } from '../../components/sheet.js';
import { useAccountId, useMe } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { DeadFeedBanner } from '../feeds/dead-feed-banner.js';
import { useObserveItems, useReaderActions } from './actions/provider.js';
import { ArticleList } from './article-list.js';
import { DetailPane } from './detail-pane.js';
import { ReaderHeader } from './header.js';
import type { ScopedLane } from './lanes.js';
import { useCounts } from './queries.js';
import { LaneSwitcher, ReaderSidebar } from './sidebar.js';
import { useArticleList } from './use-article-list.js';
import { useDesktop } from './use-desktop.js';
import { usePolling } from './use-polling.js';
import { useViewTitle } from './use-view-title.js';
import { scopeOf, viewKey, type ReaderView } from './view.js';

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

  if (desktop) {
    return (
      <div className="mx-auto flex w-full max-w-[96rem] items-start gap-6 px-4 py-4">
        <div className="sticky top-16 max-h-[calc(100dvh-5rem)] w-64 shrink-0 overflow-y-auto">
          <ReaderSidebar counts={counts} />
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

  const { reload, poll } = list;
  const refreshCounts = useCallback(() => {
    void queryClient.refetchQueries(
      { queryKey: articleKeys.counts(accountId), type: 'active' },
      { cancelRefetch: false },
    );
  }, [queryClient, accountId]);
  const refresh = useCallback(() => {
    void reload();
    refreshCounts();
  }, [reload, refreshCounts]);
  const refreshList = useCallback(() => void poll(), [poll]);

  const busy =
    list.rankingPending ||
    everything?.rankingPending === true ||
    scoped.data?.rankingPending === true ||
    list.items.some(
      ({ analysis }) => analysis.status === 'pending' || analysis.status === 'running',
    );
  usePolling({ busy, refreshList, refreshCounts });

  return (
    <div className="flex flex-col gap-4">
      <ReaderHeader
        view={view}
        title={title}
        subscription={subscription}
        counts={scoped.data}
        items={list.items}
        onLaneChange={onLaneChange}
        refresh={refresh}
      />
      {subscription === undefined ? null : (
        <DeadFeedBanner feed={subscription.feed} title={title} />
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <ArticleList
          view={view}
          list={list}
          expandedId={expanded?.id ?? null}
          onToggle={toggle}
          simple={preferences.simpleMode}
        />
        <DetailPane view={view} item={expanded} desktop={desktop} onClose={() => setOpened(null)} />
      </div>
    </div>
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
