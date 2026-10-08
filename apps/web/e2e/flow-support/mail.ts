import type { APIRequestContext } from '@playwright/test';

import { callJson } from '../support/api.js';
import { expect } from '../support/test.js';

/**
 * The mail the test environment's log transport keeps (`GET /api/v1/dev/last-email`, only when
 * `NODE_ENV=test`). It keeps one mail for the whole server, whoever it was for, so a reader of it
 * has to look at the recipient before it trusts the code.
 */

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

const LOGIN_CODE = /\b(\d{6})\b/;

/** The last mail the server sent, or null before it has sent any. */
export async function lastMail(request: APIRequestContext): Promise<SentMail | null> {
  const body = await callJson<{ email: SentMail | null }>(request, 'GET', '/api/v1/dev/last-email');
  return body.email;
}

/** The 6-digit code in the text of a sign-in or sign-up mail; null when the text has none. */
export function codeIn(mail: SentMail): string | null {
  return LOGIN_CODE.exec(mail.text)?.[1] ?? null;
}

/**
 * The mail sent to `email`: polls the log until its last mail is addressed to `email`, so a mail
 * that was left there by another account is never taken for the one that is awaited.
 */
export async function mailTo(request: APIRequestContext, email: string): Promise<SentMail> {
  const found: { mail?: SentMail } = {};
  await expect
    .poll(
      async () => {
        const last = await lastMail(request);
        if (last !== null && last.to.toLowerCase() === email.toLowerCase()) found.mail = last;
        return found.mail !== undefined;
      },
      { message: `a mail to ${email}`, timeout: 15_000, intervals: [200, 500, 1_000] },
    )
    .toBe(true);
  if (found.mail === undefined) throw new Error(`no mail to ${email}`);
  return found.mail;
}
