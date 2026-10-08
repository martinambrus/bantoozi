import type { TFunction } from 'i18next';

import { isApiError } from '../../api/errors.js';
import { errorMessage } from '../../components/error-message.js';

/** One example per line; blank lines do not count. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Topic ids typed as a comma separated list. */
export function topicList(text: string): string[] {
  return text
    .split(',')
    .map((topic) => topic.trim())
    .filter((topic) => topic !== '');
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type FieldName =
  | 'slug'
  | 'title'
  | 'interest'
  | 'notFor'
  | 'examplesYes'
  | 'examplesNo'
  | 'topicIds'
  | 'skTitle'
  | 'skInterest';

/** The form field a schema issue belongs to, from the path of the issue. */
export function fieldOf(path: readonly PropertyKey[]): FieldName | null {
  const [first, second, third] = path;
  if (first === 'i18n' && second === 'sk') {
    if (third === 'title') return 'skTitle';
    if (third === 'interest') return 'skInterest';
    return null;
  }
  switch (first) {
    case 'slug':
    case 'title':
    case 'interest':
    case 'notFor':
    case 'examplesYes':
    case 'examplesNo':
    case 'topicIds':
      return first;
    case 'titleSk':
      return 'skTitle';
    default:
      return null;
  }
}

/** What to tell about a field the schema rejected. */
export function fieldMessage(t: TFunction, field: FieldName): string {
  switch (field) {
    case 'skTitle':
      return t('library.fieldErrors.title');
    case 'skInterest':
      return t('library.fieldErrors.interest');
    default:
      return t(`library.fieldErrors.${field}`);
  }
}

/** The sentence for a refused library request; the generic ones come from the shared messages. */
export function libraryProblem(t: TFunction, error: unknown): string {
  if (isApiError(error)) {
    const details = error.details;
    if (error.status === 409) {
      switch (error.reason) {
        case 'slug_taken':
          return t('library.problems.slugTaken');
        case 'text_exists':
          return t('library.problems.textExists');
        case 'not_latest_version':
          return t('library.problems.notLatest');
        case 'not_shared':
          return t('library.problems.notShared');
        case 'insufficient_holders':
          return t('library.problems.insufficientHolders', {
            count: Number(details?.['holders'] ?? 0),
            min: Number(details?.['min'] ?? 0),
          });
      }
    }
    const unknown = details?.['unknown'];
    if (error.status === 400 && details?.['field'] === 'topicIds' && Array.isArray(unknown)) {
      return t('library.problems.unknownTopics', { topics: unknown.map(String).join(', ') });
    }
  }
  return errorMessage(t, error);
}
