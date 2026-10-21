import { activeAdminEmails } from '@bantoozi/db';
import type { EmailMessage, Mailer } from '@bantoozi/shared/server';

import type { WorkerDeps } from '../handlers/deps.js';
import { safeText } from './types.js';

const JOB = 'house.alerts' as const;

/**
 * Alert recipients (M8b-T7): the active admins in the database; `ADMIN_EMAILS` only while there is
 * none. A failed lookup also falls back to the list rather than dropping the alerts.
 */
export async function alertRecipients(
  deps: Pick<WorkerDeps, 'db' | 'logger' | 'adminEmails'>,
): Promise<readonly string[]> {
  try {
    const emails = await activeAdminEmails(deps.db);
    if (emails.length > 0) return emails;
  } catch (error) {
    deps.logger.warn(
      { job: JOB, error: safeText(error instanceof Error ? error.message : error, 200) },
      'admin recipients lookup failed; using ADMIN_EMAILS',
    );
  }
  return deps.adminEmails ?? [];
}

/** Sends one message to each admin; delivered when at least one address accepted it. Never throws. */
export async function deliver(
  deps: Pick<WorkerDeps, 'logger'>,
  mailer: Mailer,
  admins: readonly string[],
  content: Pick<EmailMessage, 'subject' | 'text'>,
): Promise<boolean> {
  let accepted = 0;
  for (const to of admins) {
    try {
      await mailer.send({ to, ...content });
      accepted += 1;
    } catch (error) {
      deps.logger.warn(
        { job: JOB, error: safeText(error instanceof Error ? error.message : error, 200) },
        'alert email not delivered',
      );
    }
  }
  return accepted > 0;
}
