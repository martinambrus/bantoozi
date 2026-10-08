import type { AdminWaitlistInviteResult, AdminWaitlistEntrySchema } from '@bantoozi/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { useApi } from '../../api/context.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { Alert, Cell, DataTable, LoadMore, PageTitle, RowHeader } from './admin-ui.js';
import { Time } from './format.js';
import { InviteResult } from './invite-result.js';
import { conflictReason, useAdminPages, useRefresh } from './use-admin.js';

type WaitlistEntry = z.infer<typeof AdminWaitlistEntrySchema>;

export function AdminWaitlistPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const refresh = useRefresh();
  const invite = useApiMutation(routes.adminWaitlistInvite);
  const [inviting, setInviting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invited, setInvited] = useState<AdminWaitlistInviteResult | null>(null);

  const entries = useAdminPages<WaitlistEntry>(['waitlist'], (cursor, signal) =>
    api.call(routes.adminWaitlistList, { query: { cursor } }, { signal }),
  );

  async function inviteEntry(entry: WaitlistEntry) {
    setNotice(null);
    setInviting(entry.id);
    try {
      setInvited(await invite.mutateAsync({ params: { id: entry.id } }));
      void refresh('waitlist');
    } catch (error) {
      setNotice(
        conflictReason(error) === 'account_exists'
          ? t('waitlist.accountExists')
          : errorMessage(t, error),
      );
    } finally {
      setInviting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.waitlist')}</PageTitle>
      {notice === null ? null : <Alert>{notice}</Alert>}
      {invited === null ? null : (
        <InviteResult
          title={t('waitlist.result.title')}
          summary={t('waitlist.result.for', { email: invited.entry.email })}
          invites={[invited.invite]}
          emailSent={invited.emailSent}
        />
      )}
      <QueryState
        query={entries.source}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title={t('waitlist.empty')} />}
      >
        {(rows) => (
          <>
            <DataTable
              caption={t('nav.waitlist')}
              hideCaption
              columns={[
                t('waitlist.columns.email'),
                t('waitlist.columns.language'),
                t('waitlist.columns.note'),
                t('waitlist.columns.joined'),
                t('waitlist.columns.status'),
                t('waitlist.columns.actions'),
              ]}
            >
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <RowHeader className="break-all font-medium">{entry.email}</RowHeader>
                  <Cell>{t(`waitlist.locales.${entry.locale}`)}</Cell>
                  <Cell>{entry.note ?? '—'}</Cell>
                  <Cell>
                    <Time value={entry.createdAt} />
                  </Cell>
                  <Cell>
                    {entry.invitedAt === null ? (
                      <Badge tone="info">{t('waitlist.waiting')}</Badge>
                    ) : (
                      <>
                        <Badge tone="success">{t('waitlist.invited')}</Badge>
                        <p className="mt-1 text-xs">
                          <Time value={entry.invitedAt} />
                        </p>
                        {entry.inviteCode === null ? null : <code>{entry.inviteCode}</code>}
                      </>
                    )}
                  </Cell>
                  <Cell>
                    {entry.invitedAt !== null ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t('waitlist.inviteLabel', { email: entry.email })}
                        loading={inviting === entry.id}
                        disabled={inviting !== null}
                        onClick={() => void inviteEntry(entry)}
                      >
                        {t('waitlist.invite')}
                      </Button>
                    )}
                  </Cell>
                </tr>
              ))}
            </DataTable>
            <LoadMore
              hasMore={entries.hasMore}
              loading={entries.loadingMore}
              onLoadMore={entries.loadMore}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}
