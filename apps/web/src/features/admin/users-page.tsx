import type { AdminUser } from '@bantoozi/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { Cell, DataTable, LoadMore, PageTitle, RowHeader, SearchForm } from './admin-ui.js';
import { Time, useFormat } from './format.js';
import { UserEditDialog } from './user-edit-dialog.js';
import { useAdminPages, useRefresh } from './use-admin.js';

const route = getRouteApi('/_authed/_app/admin/users');

export function AdminUsersPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const format = useFormat();
  const refresh = useRefresh();
  const { q } = route.useSearch();
  const navigate = route.useNavigate();
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const users = useAdminPages<AdminUser>(['users', { q }], (cursor, signal) =>
    api.call(routes.adminUserList, { query: { cursor, q } }, { signal }),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.users')}</PageTitle>
      <SearchForm
        label={t('users.search')}
        value={q ?? ''}
        onSearch={(text) =>
          void navigate({
            search: (previous) => ({ ...previous, q: text === '' ? undefined : text }),
          })
        }
      />
      <QueryState
        query={users.source}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title={t('users.empty')} />}
      >
        {(rows) => (
          <>
            <DataTable
              caption={t('nav.users')}
              hideCaption
              columns={[
                t('users.columns.user'),
                t('users.columns.role'),
                t('users.columns.plan'),
                t('users.columns.invites'),
                t('users.columns.lastActive'),
                t('users.columns.joined'),
                t('users.columns.actions'),
              ]}
            >
              {rows.map((user) => (
                <tr key={user.id}>
                  <RowHeader>
                    <div className="break-all font-medium">{user.email}</div>
                    {user.displayName === null ? null : <div>{user.displayName}</div>}
                    {user.deletedAt === null ? null : (
                      <Badge tone="danger">{t('users.deleted')}</Badge>
                    )}
                  </RowHeader>
                  <Cell>
                    <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>
                      {t(`users.roles.${user.role}`)}
                    </Badge>
                  </Cell>
                  <Cell>{user.plan}</Cell>
                  <Cell>{format.number(user.invitesLeft)}</Cell>
                  <Cell>
                    {user.lastActiveAt === null ? '—' : <Time value={user.lastActiveAt} />}
                  </Cell>
                  <Cell>
                    <Time value={user.createdAt} />
                  </Cell>
                  <Cell>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t('users.editLabel', { email: user.email })}
                      disabled={user.deletedAt !== null}
                      onClick={() => setEditing(user)}
                    >
                      {t('common:actions.edit')}
                    </Button>
                  </Cell>
                </tr>
              ))}
            </DataTable>
            <LoadMore
              hasMore={users.hasMore}
              loading={users.loadingMore}
              onLoadMore={users.loadMore}
            />
          </>
        )}
      </QueryState>
      {editing === null ? null : (
        <UserEditDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh('users')}
        />
      )}
    </div>
  );
}
