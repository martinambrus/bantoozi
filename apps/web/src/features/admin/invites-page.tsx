import {
  ADMIN_INVITE_MAX_COUNT,
  ADMIN_INVITE_MAX_EXPIRES_DAYS,
  AdminCreateInvitesBodySchema,
  AdminInviteStatusSchema,
  INVITE_NOTE_MAX_LENGTH,
  type AdminCreateInvitesResult,
  type AdminInviteSchema,
} from '@bantoozi/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { useApi } from '../../api/context.js';
import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { Select } from '../../components/select.js';
import { EmptyState } from '../../components/states/empty-state.js';
import { QueryState } from '../../components/states/query-state.js';
import { TextField } from '../../components/text-field.js';
import {
  Alert,
  Cell,
  DataTable,
  LoadMore,
  PageTitle,
  RowHeader,
  SectionTitle,
} from './admin-ui.js';
import { Time } from './format.js';
import { InviteResult } from './invite-result.js';
import { useAdminPages, useRefresh } from './use-admin.js';

const route = getRouteApi('/_authed/_app/admin/invites');

type AdminInvite = z.infer<typeof AdminInviteSchema>;

const STATUS_TONES: Record<AdminInvite['status'], BadgeTone> = {
  unused: 'info',
  used: 'neutral',
  expired: 'warning',
};

interface Created {
  invites: AdminCreateInvitesResult['items'];
  emailSent: boolean | undefined;
}

type Field = 'count' | 'email' | 'note' | 'days';

function wholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

function CreateInvites({ onCreated }: { onCreated: (created: Created) => void }) {
  const { t } = useTranslation('admin');
  const refresh = useRefresh();
  const create = useApiMutation(routes.adminInviteCreate);
  const [count, setCount] = useState('1');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<unknown>(null);
  // Counts the edits, so an answer can tell whether the form changed while it was on its way.
  const edits = useRef(0);

  /** The change handler of a field: it takes the value and counts the edit. */
  const editing = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    edits.current += 1;
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Partial<Record<Field, string>> = {};
    const wanted = wholeNumber(count, 1, ADMIN_INVITE_MAX_COUNT);
    const expires =
      days.trim() === '' ? undefined : wholeNumber(days, 1, ADMIN_INVITE_MAX_EXPIRES_DAYS);
    if (wanted === null) {
      found.count = t('invites.form.countInvalid', { max: ADMIN_INVITE_MAX_COUNT });
    } else if (email.trim() !== '' && wanted !== 1) {
      found.count = t('invites.form.countWithEmail');
    }
    if (expires === null) {
      found.days = t('invites.form.daysInvalid', { max: ADMIN_INVITE_MAX_EXPIRES_DAYS });
    }
    const parsed = AdminCreateInvitesBodySchema.safeParse({
      count: wanted ?? 1,
      ...(email.trim() === '' ? {} : { email: email.trim() }),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      ...(typeof expires === 'number' ? { expiresDays: expires } : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'email') found.email = t('invites.form.emailInvalid');
        if (issue.path[0] === 'note') {
          found.note = t('invites.form.noteTooLong', { max: INVITE_NOTE_MAX_LENGTH });
        }
      }
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return;

    const editsSent = edits.current;
    setFailure(null);
    try {
      const result = await create.mutateAsync({ body: parsed.data });
      // A form edited while the invites were on their way is the next ones: it stays as it is.
      if (edits.current === editsSent) {
        setCount('1');
        setEmail('');
        setNote('');
        setDays('');
      }
      onCreated({ invites: result.items, emailSent: result.emailSent });
      void refresh('invites');
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-label={t('invites.form.title')}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <SectionTitle>{t('invites.form.title')}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="numeric"
          label={t('invites.form.count')}
          value={count}
          onChange={editing(setCount)}
          error={errors.count}
        />
        <TextField
          type="email"
          label={t('invites.form.email')}
          value={email}
          onChange={editing(setEmail)}
          error={errors.email}
          autoComplete="off"
        />
        <TextField
          label={t('invites.form.note')}
          value={note}
          onChange={editing(setNote)}
          error={errors.note}
        />
        <TextField
          type="number"
          inputMode="numeric"
          label={t('invites.form.days')}
          value={days}
          onChange={editing(setDays)}
          error={errors.days}
        />
      </div>
      {failure === null ? null : <Alert>{errorMessage(t, failure)}</Alert>}
      <div>
        <Button type="submit" loading={create.isPending}>
          {t('invites.form.submit')}
        </Button>
      </div>
    </form>
  );
}

export function AdminInvitesPage() {
  const { t } = useTranslation('admin');
  const api = useApi();
  const { status } = route.useSearch();
  const navigate = route.useNavigate();
  const [created, setCreated] = useState<Created | null>(null);

  const invites = useAdminPages<AdminInvite>(['invites', { status }], (cursor, signal) =>
    api.call(routes.adminInviteList, { query: { cursor, status } }, { signal }),
  );

  return (
    <div className="flex flex-col gap-4">
      <PageTitle>{t('nav.invites')}</PageTitle>
      <CreateInvites onCreated={setCreated} />
      {created === null ? null : (
        <InviteResult
          title={t('invites.result.title')}
          summary={t('invites.result.created', { count: created.invites.length })}
          invites={created.invites}
          emailSent={created.emailSent}
        />
      )}
      <Select
        label={t('invites.statusFilter')}
        value={status ?? ''}
        onChange={(event) => {
          const parsed = AdminInviteStatusSchema.safeParse(event.target.value);
          void navigate({
            search: () => ({ status: parsed.success ? parsed.data : undefined }),
          });
        }}
        className="max-w-xs"
      >
        <option value="">{t('invites.allStatuses')}</option>
        {AdminInviteStatusSchema.options.map((option) => (
          <option key={option} value={option}>
            {t(`invites.status.${option}`)}
          </option>
        ))}
      </Select>
      <QueryState
        query={invites.source}
        isEmpty={(rows) => rows.length === 0}
        empty={<EmptyState title={t('invites.empty')} />}
      >
        {(rows) => (
          <>
            <DataTable
              caption={t('nav.invites')}
              hideCaption
              columns={[
                t('invites.columns.code'),
                t('invites.columns.email'),
                t('invites.columns.note'),
                t('invites.columns.status'),
                t('invites.columns.created'),
                t('invites.columns.expires'),
              ]}
            >
              {rows.map((invite) => (
                <tr key={invite.code}>
                  <RowHeader>
                    <code>{invite.code}</code>
                  </RowHeader>
                  <Cell>{invite.email ?? '—'}</Cell>
                  <Cell>{invite.note ?? '—'}</Cell>
                  <Cell>
                    <Badge tone={STATUS_TONES[invite.status]}>
                      {t(`invites.status.${invite.status}`)}
                    </Badge>
                    {invite.usedAt === null ? null : (
                      <p className="mt-1 text-xs">
                        <Time value={invite.usedAt} />
                      </p>
                    )}
                  </Cell>
                  <Cell>
                    <Time value={invite.createdAt} />
                  </Cell>
                  <Cell>
                    <Time value={invite.expiresAt} />
                  </Cell>
                </tr>
              ))}
            </DataTable>
            <LoadMore
              hasMore={invites.hasMore}
              loading={invites.loadingMore}
              onLoadMore={invites.loadMore}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}
