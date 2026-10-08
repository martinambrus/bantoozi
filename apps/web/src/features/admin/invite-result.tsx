import type { InviteDto } from '@bantoozi/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Hint, SectionTitle } from './admin-ui.js';

export interface InviteResultProps {
  title: string;
  summary: string;
  invites: readonly InviteDto[];
  /** What the server said about the email it was asked to send; absent when none was asked for. */
  emailSent: boolean | undefined;
}

/** The codes and links of invites just made, which the administrator hands on. */
export function InviteResult({ title, summary, invites, emailSent }: InviteResultProps) {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const email = invites[0]?.email ?? null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-slate-300 p-4 dark:border-slate-600"
    >
      <SectionTitle id={headingId}>{title}</SectionTitle>
      <p>{summary}</p>
      <ul role="list" className="flex flex-col gap-2">
        {invites.map((invite) => (
          <li key={invite.code} className="flex flex-col gap-1">
            <code className="font-semibold">{invite.code}</code>
            <code className="break-all text-sm">{invite.url}</code>
          </li>
        ))}
      </ul>
      {emailSent === true && email !== null ? (
        <Hint>{t('invites.result.emailed', { email })}</Hint>
      ) : null}
      {emailSent === false ? <Hint>{t('invites.result.emailFailed')}</Hint> : null}
    </section>
  );
}
