import { CARD_LIMITS } from '@bantoozi/shared';
import type { TFunction } from 'i18next';

import { errorMessage } from '../../components/error-message.js';
import { conflictReason, fieldIssue, type FieldIssue } from '../interests/card-errors.js';

export const LABEL_FIELDS = ['name', 'definition', 'notFor', 'color'] as const;

export type LabelField = (typeof LABEL_FIELDS)[number];

export function isLabelField(field: string): field is LabelField {
  return (LABEL_FIELDS as readonly string[]).includes(field);
}

const FIELD_MAX: Partial<Record<LabelField, number>> = {
  name: CARD_LIMITS.titleMax,
  definition: CARD_LIMITS.interestMax,
  notFor: CARD_LIMITS.notForMax,
};

/** What a rejected label field says to the person, in the words of the editor. */
export function labelFieldMessage(t: TFunction, { field, reason }: FieldIssue): string {
  const max = isLabelField(field) ? FIELD_MAX[field] : undefined;
  switch (reason) {
    case 'too_long':
      if (max !== undefined) return t('labels:editor.errors.tooLong', { max });
      break;
    case 'characters':
      return t('labels:editor.errors.characters');
    case 'required':
      if (field === 'name') return t('labels:editor.errors.nameRequired');
      if (field === 'definition') return t('labels:editor.errors.definitionRequired');
      break;
    case 'too_short':
      if (field === 'definition') {
        return t('labels:editor.errors.definitionTooShort', { min: CARD_LIMITS.interestMin });
      }
      break;
    case 'color':
      return t('labels:editor.errors.colorInvalid');
  }
  return t('labels:editor.errors.invalid');
}

/** Saving a label: conflicts are explained, anything else is the general text. */
export function labelSaveMessage(t: TFunction, error: unknown): string {
  switch (conflictReason(error)) {
    case 'already_held':
      return t('labels:editor.conflicts.alreadyHeld');
    case 'card_contention':
      return t('labels:editor.conflicts.contention');
    case 'target_held':
      return t('labels:editor.conflicts.targetHeld');
  }
  return errorMessage(t, error);
}

/** The label field a 400 names, if it names one. */
export function labelFieldIssue(error: unknown): (FieldIssue & { field: LabelField }) | null {
  const issue = fieldIssue(error);
  return issue !== null && isLabelField(issue.field)
    ? { field: issue.field, reason: issue.reason }
    : null;
}
