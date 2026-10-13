import { Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';

import { isApiError } from '../../api/errors.js';
import { Button } from '../../components/button.js';
import { TextField } from '../../components/text-field.js';
import { AuthLayout } from '../auth/auth-layout.js';
import { FormAlert } from '../auth/form-alert.js';
import { useSession } from '../../session/context.js';
import { SETUP_STATE_KEY, useSetupOpen } from './use-setup-open.js';

const MS_PER_MINUTE = 60_000;

/**
 * The first-run screen (M8b-T11): the setup token from the API log and an email make the first
 * admin and sign it in. Every failure reads the same, except being rate limited.
 */
export function SetupPage() {
  const open = useSetupOpen();
  if (open === undefined) return null;
  if (!open) return <Navigate to="/login" replace />;
  return <SetupForm />;
}

function SetupForm() {
  const { t } = useTranslation('setup');
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const tokenInput = useRef<HTMLInputElement>(null);

  const complete = useMutation({
    mutationFn: (input: { token: string; email: string }) => session.completeSetup(input),
    onSuccess: async () => {
      await navigate({ to: '/admin', replace: true });
      // After leaving: while this page is up, a closed state would send it to /login.
      queryClient.setQueryData(SETUP_STATE_KEY, { open: false });
    },
    onError: () => tokenInput.current?.focus(),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = token.trim();
    if (complete.isPending || trimmed === '') return;
    complete.mutate({ token: trimmed, email });
  }

  const error = complete.error;
  const message =
    error === null
      ? null
      : isApiError(error) && error.status === 429 && error.retryAfterMs !== null
        ? t('rateLimited', { count: Math.max(1, Math.ceil(error.retryAfterMs / MS_PER_MINUTE)) })
        : t('invalid');

  return (
    <AuthLayout title={t('title')} lead={t('lead')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          ref={tokenInput}
          label={t('token')}
          name="token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
        />
        <TextField
          label={t('email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
        />
        {message === null ? null : <FormAlert>{message}</FormAlert>}
        <Button type="submit" size="lg" loading={complete.isPending} className="w-full">
          {t('submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
