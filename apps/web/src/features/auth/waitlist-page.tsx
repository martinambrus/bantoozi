import { INVITE_NOTE_MAX_LENGTH } from '@bantoozi/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { TextArea } from '../../components/text-area.js';
import { TextField } from '../../components/text-field.js';
import { authErrorMessage } from './auth-error.js';
import { AuthFooterRow, AuthLayout } from './auth-layout.js';
import { FormAlert } from './form-alert.js';

export function WaitlistPage() {
  const { t, i18n } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const confirmation = useRef<HTMLHeadingElement>(null);
  const join = useApiMutation(routes.waitlistJoin);
  const joined = join.isSuccess;

  useEffect(() => {
    if (joined) confirmation.current?.focus();
  }, [joined]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (join.isPending) return;
    const trimmedNote = note.trim();
    join.mutate({
      body: {
        email,
        locale: i18n.language,
        ...(trimmedNote === '' ? {} : { note: trimmedNote }),
      },
    });
  }

  const footer = (
    <AuthFooterRow text={t('waitlist.haveAccount')} to="/login">
      {t('waitlist.signIn')}
    </AuthFooterRow>
  );

  // The answer is the same whether or not the address was already listed, and so is this text. It
  // names the address that was sent, which the field may have changed from since.
  if (join.isSuccess) {
    return (
      <AuthLayout
        title={t('waitlist.doneTitle')}
        lead={t('waitlist.doneBody', { email: join.variables.body.email })}
        headingRef={confirmation}
        footer={footer}
      />
    );
  }

  return (
    <AuthLayout title={t('waitlist.title')} lead={t('waitlist.lead')} footer={footer}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label={t('flow.email')}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
        />
        <TextArea
          label={t('waitlist.note')}
          name="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint={t('waitlist.noteHint', { max: INVITE_NOTE_MAX_LENGTH })}
          maxLength={INVITE_NOTE_MAX_LENGTH}
          rows={4}
        />
        {join.error === null ? null : <FormAlert>{authErrorMessage(t, join.error)}</FormAlert>}
        <Button type="submit" size="lg" loading={join.isPending} className="w-full">
          {t('waitlist.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
