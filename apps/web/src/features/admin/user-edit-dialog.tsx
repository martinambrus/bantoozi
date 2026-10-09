import { PLAN_NAMES, type AdminUser, type AdminUserPatch } from '@bantoozi/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { Dialog } from '../../components/dialog.js';
import { errorMessage } from '../../components/error-message.js';
import { Select } from '../../components/select.js';
import { TextField } from '../../components/text-field.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useSession } from '../../session/context.js';
import { Alert } from './admin-ui.js';
import { conflictReason } from './use-admin.js';

const MAX_INVITES = 10_000;

function parseInvites(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_INVITES ? value : null;
}

export interface UserEditDialogProps {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}

/** An answer that comes after the sign-in that asked has ended shows nothing. */
export function UserEditDialog({ user, onClose, onSaved }: UserEditDialogProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const session = useSession();
  const update = useApiMutation(routes.adminUserUpdate);
  const [role, setRole] = useState(user.role);
  const [plan, setPlan] = useState(user.plan);
  const [invites, setInvites] = useState(String(user.invitesLeft));
  const [invitesError, setInvitesError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);

  const dirty =
    role !== user.role || plan !== user.plan || invites.trim() !== String(user.invitesLeft);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invitesLeft = parseInvites(invites);
    if (invitesLeft === null) {
      setInvitesError(t('users.edit.invitesInvalid', { max: MAX_INVITES }));
      return;
    }
    setInvitesError(undefined);
    setFailure(null);
    const patch: AdminUserPatch = {
      ...(role === user.role ? {} : { role }),
      ...(plan === user.plan ? {} : { plan: plan as AdminUserPatch['plan'] }),
      ...(invitesLeft === user.invitesLeft ? {} : { invitesLeft }),
    };
    const signIn = session.currentSignIn();
    try {
      const result = await update.mutateAsync({ params: { id: user.id }, body: patch });
      if (session.currentSignIn() !== signIn) return;
      toast.show({
        message:
          result.sessionsRevoked > 0
            ? t('users.savedSessions', { count: result.sessionsRevoked })
            : t('users.saved'),
        tone: 'success',
      });
      onSaved();
      onClose();
    } catch (error) {
      setFailure(error);
    }
  }

  const failureText =
    failure === null
      ? null
      : conflictReason(failure) === 'last_admin'
        ? t('users.edit.lastAdmin')
        : errorMessage(t, failure);

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!update.isPending}
      title={t('users.edit.title', { email: user.email })}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
        <Select
          label={t('users.edit.role')}
          value={role}
          onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}
          hint={
            user.adminBootstrap && user.role === 'admin' ? t('users.edit.bootstrap') : undefined
          }
        >
          <option value="user">{t('users.roles.user')}</option>
          <option value="admin">{t('users.roles.admin')}</option>
        </Select>
        <Select
          label={t('users.edit.plan')}
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
        >
          {PLAN_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <TextField
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_INVITES}
          label={t('users.edit.invites')}
          value={invites}
          onChange={(event) => setInvites(event.target.value)}
          error={invitesError}
        />
        {failureText === null ? null : <Alert>{failureText}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={update.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            {t('users.edit.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
