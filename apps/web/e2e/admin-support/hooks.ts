import type { Control } from '../support/control.js';
import { expect } from '../support/test.js';

/**
 * Typed calls of the admin SQL hooks (packages/testing/src/e2e/hooks-admin.ts). Each states what it
 * does in the scenario's own terms and checks that the hook found the row it was meant to change.
 */

export type AuthorizationKind = 'creator_approval' | 'creator_inactive_30d';

export interface PublicationAudit {
  status: string;
  version: string;
  respondedAt: string | null;
  promotedAt: string | null;
  authorizationKind: AuthorizationKind | null;
  authorizationEvidence: Record<string, unknown> | null;
  cardVisibility: string;
  vetoed: boolean;
}

/**
 * Makes the account's last activity `daysAgo` days old. Any later sign-in of the account sets it
 * to now again; nothing the account does through a session younger than five minutes does.
 */
export async function setLastActive(
  control: Control,
  email: string,
  daysAgo: number,
): Promise<void> {
  const done = await control.sql<{ updated: number }>('setLastActive', { email, daysAgo });
  expect(done.updated, `${email} is a live account`).toBe(1);
}

/** The pending request an administrator made `daysOld` days ago for a shared card. */
export async function createOldPublicationRequest(
  control: Control,
  cardId: string,
  daysOld: number,
): Promise<{ requestId: string; version: string }> {
  const made = await control.sql<{ requestId: string; version: string } | null>(
    'createOldPublicationRequest',
    { cardId, daysOld },
  );
  expect(made, `card ${cardId} is shared, has a known creator and no open request`).not.toBeNull();
  return made!;
}

/** Changes the public title of an open request the way the database accepts it: a new version. */
export async function reviseProposalTitle(
  control: Control,
  requestId: string,
  title: string,
): Promise<string> {
  const revised = await control.sql<{ version: string } | null>('reviseProposalTitle', {
    requestId,
    title,
  });
  expect(revised, `request ${requestId} is open`).not.toBeNull();
  return revised!.version;
}

/** Makes the validation of the staged key `hours` hours old. */
export async function ageCredentialValidation(
  control: Control,
  provider: 'typesafe' | 'ollama',
  hours: number,
): Promise<void> {
  const done = await control.sql<{ updated: number }>('ageCredentialValidation', {
    provider,
    hours,
  });
  expect(done.updated, `the staged key of ${provider} is valid`).toBe(1);
}

/** One publication request as the database records it. */
export async function publicationAudit(
  control: Control,
  requestId: string,
): Promise<PublicationAudit> {
  const audit = await control.sql<PublicationAudit | null>('publicationAudit', { requestId });
  expect(audit, `request ${requestId} exists`).not.toBeNull();
  return audit!;
}

export interface FeedbackEvent {
  id: string;
  kind: string;
  articleId: string;
}

/** The feedback events one account has written, oldest first. */
export function feedbackEvents(control: Control, email: string): Promise<FeedbackEvent[]> {
  return control.sql<FeedbackEvent[]>('feedbackEvents', { email });
}
