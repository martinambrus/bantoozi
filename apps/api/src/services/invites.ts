import { createInvites, takeInviteSlot, type InviteRow, type TenantTx } from '@bantoozi/db';
import { AppError, type InviteDto, type Locale } from '@bantoozi/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { ApiConfig, ApiServices } from '../context.js';
import { deliverEmail, publicBase } from './auth.js';

/**
 * Invites (spec 08 §2.2). Creation runs inside the caller's mutation transaction; the invite email
 * is sent only after that transaction committed, with bounded synchronous delivery and no outbox
 * intent (the code never enters a job payload). A failed send keeps the invite: the inviter shares
 * the returned link instead. `POST /admin/invites` and `POST /admin/waitlist/:id/invite` reuse
 * {@link sendInviteEmail} and `createInvites` from `@bantoozi/db`.
 */

/** `PUBLIC_BASE_URL + '/join?code=' + code` (spec 08 §2.2, spec 09 `/join`). */
export function inviteUrl(config: ApiConfig, code: string): string {
  return `${publicBase(config)}/join?code=${encodeURIComponent(code)}`;
}

export function toInviteDto(config: ApiConfig, row: InviteRow): InviteDto {
  return {
    code: row.code,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    url: inviteUrl(config, row.code),
  };
}

/**
 * Take one of the tenant's invite slots and create the invite, in the caller's transaction
 * (spec 08 §2.2): `invites_left > 0` is required and decremented atomically under the user row
 * lock, so two requests for the last slot cannot both succeed.
 */
export async function createUserInvite(
  tx: TenantTx,
  input: { userId: string; email?: string | undefined; note?: string | undefined },
): Promise<{ invite: InviteRow; inviterName: string | null }> {
  const slot = await takeInviteSlot(tx);
  if (slot === null) {
    throw new AppError('QUOTA_EXCEEDED', 'No invites left', {
      details: { limit: 'invites', invitesLeft: 0 },
    });
  }
  const [invite] = await createInvites(tx, {
    createdBy: input.userId,
    email: input.email ?? null,
    note: input.note ?? null,
  });
  if (invite === undefined) throw new Error('invite insert returned no row');
  return { invite, inviterName: slot.displayName };
}

export interface InviteEmail {
  to: string;
  code: string;
  expiresAt: Date;
  /** Locale of the email; the recipient has none yet, so callers pass the inviter's (or `en`). */
  locale: Locale;
  inviterName: string | null;
}

/**
 * Send an invite email after the invite committed (spec 08 §2.2). Returns `false` on failure,
 * never throws; logs only the failure class, never the address or the code.
 */
export async function sendInviteEmail(
  services: Pick<ApiServices, 'mailer' | 'config'>,
  input: InviteEmail,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  return deliverEmail(
    services,
    input.to,
    {
      kind: 'invite',
      inviterName: input.inviterName,
      link: inviteUrl(services.config, input.code),
      expiresAt: input.expiresAt,
    },
    input.locale,
    log,
  );
}
