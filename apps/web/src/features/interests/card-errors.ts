import { CARD_LIMITS } from '@bantoozi/shared';
import type { TFunction } from 'i18next';

import { isApiError } from '../../api/errors.js';
import { errorMessage } from '../../components/error-message.js';

export const CARD_FIELDS = ['title', 'interest', 'notFor', 'scopeFeedId'] as const;

export type CardField = (typeof CARD_FIELDS)[number];

export function isCardField(field: string): field is CardField {
  return (CARD_FIELDS as readonly string[]).includes(field);
}

export interface FieldIssue {
  field: string;
  reason: string;
}

/**
 * The field a 400 names. The card repository answers `{field, reason}`; the schema validator in
 * front of it lists `issues` whose `path` is `body/<field>` and says nothing more precise.
 */
export function fieldIssue(error: unknown): FieldIssue | null {
  if (!isApiError(error) || error.status !== 400) return null;
  const field = error.details?.['field'];
  const reason = error.details?.['reason'];
  if (typeof field === 'string' && typeof reason === 'string') return { field, reason };
  const issues = error.details?.['issues'];
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    const path = (issue as { path?: unknown } | null)?.path;
    if (typeof path !== 'string') continue;
    const [part, name] = path.split('/');
    if (part === 'body' && name !== undefined && name !== '') {
      return { field: name, reason: 'invalid' };
    }
  }
  return null;
}

/** The card field a 400 names, if it names one the editor has. */
export function cardFieldIssue(error: unknown): (FieldIssue & { field: CardField }) | null {
  const issue = fieldIssue(error);
  return issue !== null && isCardField(issue.field)
    ? { field: issue.field, reason: issue.reason }
    : null;
}

/** The `reason` of a 409 CONFLICT, which names what clashed. */
export function conflictReason(error: unknown): string | undefined {
  return isApiError(error) && error.code === 'CONFLICT' ? error.reason : undefined;
}

const FIELD_MAX: Partial<Record<CardField, number>> = {
  title: CARD_LIMITS.titleMax,
  interest: CARD_LIMITS.interestMax,
  notFor: CARD_LIMITS.notForMax,
};

/** What a rejected card field says to the person, in the words of the editor. */
export function cardFieldMessage(t: TFunction, { field, reason }: FieldIssue): string {
  const max = isCardField(field) ? FIELD_MAX[field] : undefined;
  switch (reason) {
    case 'too_long':
      if (max !== undefined) return t('interests:editor.errors.tooLong', { max });
      break;
    case 'characters':
      return t('interests:editor.errors.characters');
    case 'required':
      return t(
        field === 'interest'
          ? 'interests:editor.errors.interestRequired'
          : 'interests:editor.errors.required',
      );
    case 'too_short':
      if (field === 'interest') {
        return t('interests:editor.errors.interestTooShort', { min: CARD_LIMITS.interestMin });
      }
      break;
    case 'not_subscribed':
      return t('interests:editor.errors.notSubscribed');
  }
  return t('interests:editor.errors.invalid');
}

/** Saving, creating or changing a card: conflicts are explained, anything else is the general text. */
export function saveMessage(t: TFunction, error: unknown): string {
  switch (conflictReason(error)) {
    case 'already_held':
      return t('interests:editor.conflicts.alreadyHeld');
    case 'card_contention':
      return t('interests:editor.conflicts.contention');
    case 'target_held':
      return t('interests:editor.conflicts.targetHeld');
  }
  const issue = cardFieldIssue(error);
  return issue === null ? errorMessage(t, error) : cardFieldMessage(t, issue);
}
