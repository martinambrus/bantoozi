import { CreateInviteBodySchema, INVITE_NOTE_MAX_LENGTH, type InviteDto } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { accountKey, meKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { QueryState } from '../../components/states/query-state.js';
import { TextField } from '../../components/text-field.js';
import { useAccountId } from '../../session/context.js';
import { Time } from './format.js';
import { Alert, Hint, SettingsSection } from './section.js';

type InviteStatus = 'active' | 'used' | 'expired';

const STATUS_TONES: Record<InviteStatus, BadgeTone> = {
  active: 'info',
  used: 'neutral',
  expired: 'warning',
};

interface NewInvite {
  code: string;
  url: string;
  email: string | undefined;
  emailSent: boolean | undefined;
}

type Notice = 'created' | 'copied';

const NOTICE_KEYS = {
  created: 'invites.result.created',
  copied: 'invites.copied',
} as const satisfies Record<Notice, string>;

function useInvitesKey() {
  return accountKey(useAccountId(), 'settings', 'invites');
}

function statusOf(invite: InviteDto, asOf: number): InviteStatus {
  if (invite.usedAt !== null) return 'used';
  return Date.parse(invite.expiresAt) <= asOf ? 'expired' : 'active';
}

/** The answer to a create when the account has no invites left; its details are not a plan quota. */
function isInviteQuota(error: unknown): boolean {
  return (
    isApiError(error) && error.code === 'QUOTA_EXCEEDED' && error.details?.['limit'] === 'invites'
  );
}

function InviteForm({ left, onCreated }: { left: number; onCreated: (invite: NewInvite) => void }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const key = useInvitesKey();
  const create = useApiMutation(routes.inviteCreate);
  const titleId = useId();
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // A request that failed is sent again under its key, so the server never makes two of one invite.
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending || left === 0) return;
    const parsed = CreateInviteBodySchema.safeParse({
      ...(email.trim() === '' ? {} : { email }),
      ...(note.trim() === '' ? {} : { note }),
    });
    if (!parsed.success) {
      setEmailInvalid(parsed.error.issues.some((issue) => issue.path[0] === 'email'));
      return;
    }
    const signature = JSON.stringify(parsed.data);
    const sending =
      attempt.current?.signature === signature
        ? attempt.current
        : { signature, key: crypto.randomUUID() };
    attempt.current = sending;

    setFailure(null);
    try {
      const created = await create.mutateAsync({ body: parsed.data, idempotencyKey: sending.key });
      attempt.current = null;
      setEmail('');
      setNote('');
      onCreated({
        code: created.code,
        url: created.url,
        email: parsed.data.email,
        emailSent: created.emailSent,
      });
    } catch (error) {
      setFailure(error);
      if (!isInviteQuota(error)) return;
    }
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: meKey() });
  }

  const quotaReached = failure !== null && isInviteQuota(failure);
  return (
    <form
      noValidate
      aria-labelledby={titleId}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
    >
      <h3 id={titleId} className="text-base font-semibold">
        {t('invites.form.title')}
      </h3>
      <TextField
        type="email"
        autoComplete="off"
        label={t('invites.form.email')}
        hint={t('invites.form.emailHint')}
        error={emailInvalid ? t('invites.form.emailInvalid') : undefined}
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
          setEmailInvalid(false);
          setFailure(null);
        }}
      />
      <TextField
        label={t('invites.form.note')}
        hint={t('invites.form.noteHint')}
        maxLength={INVITE_NOTE_MAX_LENGTH}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setFailure(null);
        }}
      />
      {failure === null ? null : (
        <Alert>{quotaReached ? t('invites.none') : errorMessage(t, failure)}</Alert>
      )}
      {left === 0 && !quotaReached ? <Hint>{t('invites.none')}</Hint> : null}
      <div>
        <Button type="submit" loading={create.isPending} disabled={left === 0}>
          {t('invites.form.submit')}
        </Button>
      </div>
    </form>
  );
}

function NewInviteResult({ invite, onCopy }: { invite: NewInvite; onCopy: (url: string) => void }) {
  const { t } = useTranslation('settings');
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <h3 id={headingId} className="text-base font-semibold">
        {t('invites.result.title')}
      </h3>
      <p className="flex flex-wrap items-center gap-2">
        <span>{t('invites.result.code')}</span>
        <code className="font-semibold">{invite.code}</code>
      </p>
      <TextField
        readOnly
        label={t('invites.result.link')}
        value={invite.url}
        onFocus={(event) => event.target.select()}
      />
      <div>
        <Button variant="secondary" onClick={() => onCopy(invite.url)}>
          {t('invites.copyLink')}
        </Button>
      </div>
      {invite.emailSent === true && invite.email !== undefined ? (
        <Hint>{t('invites.result.emailed', { email: invite.email })}</Hint>
      ) : null}
      {invite.emailSent === false ? <Hint>{t('invites.result.emailFailed')}</Hint> : null}
    </div>
  );
}

function InviteRow({
  invite,
  asOf,
  onCopy,
}: {
  invite: InviteDto;
  asOf: number;
  onCopy: (url: string) => void;
}) {
  const { t } = useTranslation('settings');
  const status = statusOf(invite, asOf);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <code className="font-semibold break-all">{invite.code}</code>
          <Badge tone={STATUS_TONES[status]}>{t(`invites.status.${status}`)}</Badge>
        </p>
        <p className="text-sm break-words text-slate-600 dark:text-slate-300">
          {invite.email === null
            ? t('invites.row.anyone')
            : t('invites.row.sentTo', { email: invite.email })}
        </p>
        <p className="flex flex-wrap gap-x-4 text-sm text-slate-600 dark:text-slate-300">
          <span>
            {t('invites.row.created')} <Time value={invite.createdAt} />
          </span>
          {invite.usedAt === null ? (
            <>
              <span>
                {status === 'expired' ? t('invites.row.expiredOn') : t('invites.row.expires')}{' '}
                <Time value={invite.expiresAt} />
              </span>
              <span>{t('invites.row.notUsed')}</span>
            </>
          ) : (
            <span>
              {t('invites.row.usedOn')} <Time value={invite.usedAt} />
            </span>
          )}
        </p>
      </div>
      {status === 'active' ? (
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('invites.copyLinkFor', { code: invite.code })}
          onClick={() => onCopy(invite.url)}
        >
          {t('invites.copyLink')}
        </Button>
      ) : null}
    </li>
  );
}

function InviteList({
  invites,
  asOf,
  onCopy,
}: {
  invites: readonly InviteDto[];
  asOf: number;
  onCopy: (url: string) => void;
}) {
  const { t } = useTranslation('settings');
  const headingId = useId();
  return (
    <div className="flex flex-col gap-2">
      <h3 id={headingId} className="text-base font-semibold">
        {t('invites.listTitle')}
      </h3>
      {invites.length === 0 ? (
        <Hint>{t('invites.empty')}</Hint>
      ) : (
        <ul
          role="list"
          aria-labelledby={headingId}
          className="divide-y divide-slate-200 rounded-lg border border-slate-300 px-4 dark:divide-slate-700 dark:border-slate-600"
        >
          {invites.map((invite) => (
            <InviteRow key={invite.code} invite={invite} asOf={asOf} onCopy={onCopy} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Invites({
  invites,
  left,
  asOf,
}: {
  invites: readonly InviteDto[];
  left: number;
  asOf: number;
}) {
  const { t } = useTranslation('settings');
  const [created, setCreated] = useState<NewInvite | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copyFailure, setCopyFailure] = useState<string | null>(null);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setNotice(null);
      setCopyFailure(url);
      return;
    }
    setCopyFailure(null);
    setNotice('copied');
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="font-medium">{t('invites.left', { left })}</p>
      <InviteForm
        left={left}
        onCreated={(invite) => {
          setCreated(invite);
          setCopyFailure(null);
          setNotice('created');
        }}
      />
      {created === null ? null : (
        <NewInviteResult invite={created} onCopy={(url) => void copy(url)} />
      )}
      <p
        role="status"
        className={
          notice === null ? 'sr-only' : 'text-sm font-medium text-emerald-800 dark:text-emerald-300'
        }
      >
        {notice === null ? null : t(NOTICE_KEYS[notice])}
      </p>
      {copyFailure === null ? null : <Alert>{t('invites.copyFailed', { url: copyFailure })}</Alert>}
      <InviteList invites={invites} asOf={asOf} onCopy={(url) => void copy(url)} />
    </div>
  );
}

export function InvitesSection() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const key = useInvitesKey();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.call(routes.inviteList, undefined, { signal }),
  });
  return (
    <SettingsSection title={t('invites.title')} description={t('invites.description')}>
      <QueryState query={query}>
        {({ items, invitesLeft }) => (
          <Invites invites={items} left={invitesLeft} asOf={query.dataUpdatedAt} />
        )}
      </QueryState>
    </SettingsSection>
  );
}
