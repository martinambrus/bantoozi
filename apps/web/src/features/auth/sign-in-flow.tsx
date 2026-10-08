import { LoginCodeSchema } from '@bantoozi/shared';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors.js';
import { Button } from '../../components/button.js';
import { TextField } from '../../components/text-field.js';
import { useSession } from '../../session/context.js';
import { authErrorMessage } from './auth-error.js';
import { FormAlert } from './form-alert.js';
import { safeRedirect } from './safe-redirect.js';

export interface SignInFlowProps {
  /** The `redirect` search parameter of /login; an unsafe one is ignored. */
  redirect?: string | undefined;
  /** Set on /join: asks for the invite code, starting from the one in the link, and sends it. */
  invite?: { code: string | undefined } | undefined;
}

function isInvalidCode(error: unknown): boolean {
  return isApiError(error) && error.code === 'INVALID_CODE';
}

/**
 * Sign in with an emailed code (spec 09 §2): the email first, then the code. The server answers a
 * code request the same way whether or not the account exists, so the second step never claims
 * more than that a code was sent.
 */
export function SignInFlow({ redirect, invite }: SignInFlowProps) {
  const { t, i18n } = useTranslation('auth');
  const session = useSession();
  const navigate = useNavigate();
  const codeInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState(invite?.code ?? '');
  const [code, setCode] = useState('');
  const [malformed, setMalformed] = useState(false);
  // Focus moves to the email only when the visitor comes back to it, not when the page opens.
  const [cameBack, setCameBack] = useState(false);

  const sendCode = useMutation({
    mutationFn: (_input: { resend: boolean }) =>
      session.requestCode({
        email,
        inviteCode: invite === undefined ? undefined : inviteCode.trim(),
        locale: i18n.language,
      }),
    onSuccess: () => {
      setStep('code');
      setCode('');
    },
  });
  const verify = useMutation({
    mutationFn: () => session.verifyCode({ email, code: code.replace(/\s/g, '') }),
    onSuccess: () => navigate({ href: safeRedirect(redirect), replace: true }),
    onError: (error) => {
      if (isInvalidCode(error)) {
        codeInput.current?.focus();
        codeInput.current?.select();
      }
    },
  });

  const sending = sendCode.isPending;
  const verifying = verify.isPending;
  const codeRejected = isInvalidCode(verify.error);
  const failure = codeRejected ? null : (verify.error ?? sendCode.error);
  const resent = sendCode.isSuccess && sendCode.variables.resend;

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sending) sendCode.mutate({ resend: false });
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifying || sending) return;
    sendCode.reset();
    // Anything but six digits is refused by the API as a malformed request, not as a wrong code.
    const wellFormed = LoginCodeSchema.safeParse(code).success;
    setMalformed(!wellFormed);
    if (!wellFormed) {
      verify.reset();
      codeInput.current?.focus();
      return;
    }
    verify.mutate();
  }

  function sendNewCode() {
    verify.reset();
    setMalformed(false);
    sendCode.mutate({ resend: true }, { onSuccess: () => codeInput.current?.focus() });
  }

  function changeEmail() {
    sendCode.reset();
    verify.reset();
    setMalformed(false);
    setCode('');
    setCameBack(true);
    setStep('email');
  }

  const failureAlert =
    failure === null ? null : <FormAlert>{authErrorMessage(t, failure)}</FormAlert>;

  if (step === 'email') {
    return (
      <form key="email" onSubmit={submitEmail} className="flex flex-col gap-4">
        {invite === undefined ? null : (
          <TextField
            label={t('flow.inviteCode')}
            name="inviteCode"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        )}
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
          autoFocus={cameBack}
        />
        {failureAlert}
        <Button type="submit" size="lg" loading={sending} className="w-full">
          {t('flow.sendCode')}
        </Button>
      </form>
    );
  }

  return (
    <form key="code" onSubmit={submitCode} className="flex flex-col gap-4">
      <p role="status" className="text-slate-600 dark:text-slate-300">
        {resent ? t('flow.newCodeSent', { email }) : t('flow.codeSent', { email })}
      </p>
      <TextField
        ref={codeInput}
        label={t('flow.code')}
        name="code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        error={
          malformed ? (
            <span role="alert">{t('flow.codeFormat')}</span>
          ) : codeRejected ? (
            <span role="alert">{t('flow.invalidCode')}</span>
          ) : undefined
        }
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        autoFocus
      />
      {failureAlert}
      <Button type="submit" size="lg" loading={verifying} disabled={sending} className="w-full">
        {t('flow.signIn')}
      </Button>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="ghost"
          loading={sending}
          disabled={verifying}
          onClick={sendNewCode}
        >
          {t('flow.sendNewCode')}
        </Button>
        <Button type="button" variant="ghost" disabled={sending || verifying} onClick={changeEmail}>
          {t('flow.differentEmail')}
        </Button>
      </div>
    </form>
  );
}
