import type { SessionDto } from '@bantoozi/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { isApiError } from '../../api/errors.js';
import { useApiMutation } from '../../api/mutation.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { FOCUS_RING, cx } from '../../components/cx.js';
import { QueryState } from '../../components/states/query-state.js';
import { useAccountId, useSession } from '../../session/context.js';
import { useSignOut } from '../shell/use-sign-out.js';
import { Time, useMoment } from './format.js';
import { SettingsSection } from './section.js';

function useSessionsKey() {
  return accountKey(useAccountId(), 'settings', 'sessions');
}

/** This device first, then the most recently used. */
function byUse(a: SessionDto, b: SessionDto): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
}

function SessionRow({
  session,
  onRevoke,
}: {
  session: SessionDto;
  onRevoke: (session: SessionDto) => void;
}) {
  const { t } = useTranslation('settings');
  const moment = useMoment();
  const device = session.userAgent ?? t('sessions.unknownDevice');
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{device}</span>
          {session.current ? <Badge tone="info">{t('sessions.thisDevice')}</Badge> : null}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {session.ip ?? t('sessions.unknownAddress')}
        </p>
        <p className="flex flex-wrap gap-x-4 text-sm text-slate-600 dark:text-slate-300">
          <span>
            {t('sessions.signedIn')} <Time value={session.createdAt} />
          </span>
          <span>
            {t('sessions.lastActive')} <Time value={session.lastSeenAt} />
          </span>
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        aria-label={t('sessions.revokeLabel', { device, when: moment(session.createdAt) })}
        onClick={() => onRevoke(session)}
      >
        {t('sessions.revoke')}
      </Button>
    </li>
  );
}

function SessionList({ sessions }: { sessions: readonly SessionDto[] }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const session = useSession();
  const signOut = useSignOut();
  const key = useSessionsKey();
  const revoke = useApiMutation(routes.authSessionRevoke);
  const [pending, setPending] = useState<SessionDto | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const revoked = useRef(false);

  // The button that opened the dialog is gone with its session, so the focus is handed on.
  useEffect(() => {
    if (pending === null && revoked.current) {
      revoked.current = false;
      list.current?.focus();
    }
  }, [pending]);

  async function confirmRevoke() {
    if (pending === null) return;
    // This device signs out, which ends its session on the server as revoking it would, in turn
    // with the sign-ins of the other tabs.
    if (pending.current) {
      await signOut();
      return;
    }
    const signIn = session.currentSignIn();
    try {
      await revoke.mutateAsync({ params: { id: pending.id } });
    } catch (error) {
      // Already gone is what was asked for.
      if (!(isApiError(error) && error.status === 404)) throw error;
    }
    if (session.currentSignIn() !== signIn) return;
    revoked.current = true;
    queryClient.setQueryData<SessionDto[]>(key, (items) =>
      items?.filter((item) => item.id !== pending.id),
    );
    void queryClient.invalidateQueries({ queryKey: key });
  }

  const scope = pending?.current === true ? 'current' : 'other';
  return (
    <>
      <ul
        ref={list}
        role="list"
        tabIndex={-1}
        aria-label={t('sessions.listLabel')}
        className={cx(
          'divide-y divide-slate-200 rounded-lg border border-slate-300 px-4 dark:divide-slate-700 dark:border-slate-600',
          FOCUS_RING,
        )}
      >
        {[...sessions].sort(byUse).map((item) => (
          <SessionRow key={item.id} session={item} onRevoke={setPending} />
        ))}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmRevoke}
        title={t(`sessions.${scope}.title`)}
        body={t(`sessions.${scope}.body`)}
        confirmLabel={t(`sessions.${scope}.confirm`)}
        danger
      />
    </>
  );
}

export function SessionsSection() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const key = useSessionsKey();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.call(routes.authSessionList, undefined, { signal }),
  });
  return (
    <SettingsSection title={t('sessions.title')} description={t('sessions.description')}>
      <QueryState query={query}>{(sessions) => <SessionList sessions={sessions} />}</QueryState>
    </SettingsSection>
  );
}
