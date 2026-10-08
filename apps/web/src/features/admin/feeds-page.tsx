import { FeedStatusSchema, type AdminFeed } from '@bantoozi/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { Select } from '../../components/select.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { useToast } from '../../components/toast/toast-provider.js';
import {
  Alert,
  Cell,
  DataTable,
  Hint,
  LoadMore,
  PageTitle,
  RowHeader,
  SearchForm,
} from './admin-ui.js';
import { FeedOptionsDialog } from './feed-options-dialog.js';
import { Time, useFormat } from './format.js';
import { conflictReason, useAdminPages, useRefresh } from './use-admin.js';

const route = getRouteApi('/_authed/_app/admin/feeds');

const STATUS_TONES: Record<AdminFeed['status'], BadgeTone> = {
  active: 'success',
  quarantined: 'warning',
  dead: 'danger',
  paused: 'neutral',
};

const feedName = (feed: AdminFeed) => feed.title ?? feed.url;

function FeedRow({
  feed,
  resetting,
  onReset,
  onEdit,
}: {
  feed: AdminFeed;
  resetting: boolean;
  onReset: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation('admin');
  const format = useFormat();
  const name = feedName(feed);
  return (
    <tr>
      <RowHeader>
        <div className="font-medium">{name}</div>
        {feed.title === null ? null : (
          <code className="break-all text-xs text-slate-600 dark:text-slate-300">{feed.url}</code>
        )}
      </RowHeader>
      <Cell>
        <Badge tone={STATUS_TONES[feed.status]}>{t(`feeds.status.${feed.status}`)}</Badge>
        {feed.status === 'quarantined' && feed.quarantinedUntil !== null ? (
          <p className="mt-1 text-xs">
            {t('feeds.until')} <Time value={feed.quarantinedUntil} />
          </p>
        ) : null}
        {feed.mergedIntoId === null ? null : (
          <p className="mt-1 text-xs">{t('feeds.mergedInto', { id: feed.mergedIntoId })}</p>
        )}
      </Cell>
      <Cell>{format.number(feed.subscriberCount)}</Cell>
      <Cell>
        {feed.consecutiveErrors === 0
          ? t('feeds.noErrors')
          : t('feeds.errors', {
              code: feed.lastErrorCode ?? t('feeds.unknownError'),
              streak: feed.consecutiveErrors,
            })}
      </Cell>
      <Cell>{feed.lastSuccessAt === null ? '—' : <Time value={feed.lastSuccessAt} />}</Cell>
      <Cell>
        <Time value={feed.nextFetchAt} />
      </Cell>
      <Cell>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('feeds.resetLabel', { name })}
            loading={resetting}
            disabled={feed.mergedIntoId !== null}
            onClick={onReset}
          >
            {t('feeds.reset')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('feeds.optionsLabel', { name })}
            onClick={onEdit}
          >
            {t('feeds.optionsButton')}
          </Button>
        </div>
      </Cell>
    </tr>
  );
}

export function AdminFeedsPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const toast = useToast();
  const refresh = useRefresh();
  const { status, q } = route.useSearch();
  const navigate = route.useNavigate();
  const [notice, setNotice] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminFeed | null>(null);
  const reset = useApiMutation(routes.adminFeedReset);

  const feeds = useAdminPages<AdminFeed>(['feeds', { status, q }], (cursor, signal) =>
    api.call(routes.adminFeedList, { query: { cursor, status, q } }, { signal }),
  );

  async function resetFeed(feed: AdminFeed) {
    setNotice(null);
    setResetting(feed.id);
    try {
      await reset.mutateAsync({ params: { id: feed.id } });
      toast.show({ message: t('feeds.resetDone'), tone: 'success' });
      void refresh('feeds');
    } catch (error) {
      setNotice(
        conflictReason(error) === 'merged' ? t('feeds.resetMerged') : errorMessage(t, error),
      );
      void refresh('feeds');
    } finally {
      setResetting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.feeds')}</PageTitle>
      <div className="flex flex-wrap items-end gap-4">
        <Select
          label={t('feeds.statusFilter')}
          value={status ?? ''}
          onChange={(event) => {
            const parsed = FeedStatusSchema.safeParse(event.target.value);
            void navigate({
              search: (previous) => ({
                ...previous,
                status: parsed.success ? parsed.data : undefined,
              }),
            });
          }}
        >
          <option value="">{t('feeds.allStatuses')}</option>
          {FeedStatusSchema.options.map((option) => (
            <option key={option} value={option}>
              {t(`feeds.status.${option}`)}
            </option>
          ))}
        </Select>
        <SearchForm
          label={t('feeds.search')}
          value={q ?? ''}
          onSearch={(text) =>
            void navigate({
              search: (previous) => ({ ...previous, q: text === '' ? undefined : text }),
            })
          }
        />
      </div>
      <Hint>{t('feeds.resetHint')}</Hint>
      {notice === null ? null : <Alert>{notice}</Alert>}
      <QueryState
        query={feeds.source}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title={t('feeds.empty')} />}
      >
        {(rows) => (
          <>
            <DataTable
              caption={t('nav.feeds')}
              hideCaption
              columns={[
                t('feeds.columns.feed'),
                t('feeds.columns.status'),
                t('feeds.columns.subscribers'),
                t('feeds.columns.errors'),
                t('feeds.columns.lastSuccess'),
                t('feeds.columns.nextFetch'),
                t('feeds.columns.actions'),
              ]}
            >
              {rows.map((feed) => (
                <FeedRow
                  key={feed.id}
                  feed={feed}
                  resetting={resetting === feed.id}
                  onReset={() => void resetFeed(feed)}
                  onEdit={() => setEditing(feed)}
                />
              ))}
            </DataTable>
            <LoadMore
              hasMore={feeds.hasMore}
              loading={feeds.loadingMore}
              onLoadMore={feeds.loadMore}
            />
          </>
        )}
      </QueryState>
      {editing === null ? null : (
        <FeedOptionsDialog
          feed={editing}
          name={feedName(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh('feeds')}
        />
      )}
    </div>
  );
}
