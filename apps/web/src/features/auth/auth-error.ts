import type { TFunction } from 'i18next';

import { isApiError } from '../../api/errors.js';
import { errorMessage } from '../../components/error-message.js';

const MS_PER_MINUTE = 60_000;

/** The sentence for a failed sign-in or waitlist call; a 429 says how long to wait. */
export function authErrorMessage(t: TFunction, error: unknown): string {
  if (isApiError(error) && error.status === 429 && error.retryAfterMs !== null) {
    const minutes = Math.max(1, Math.ceil(error.retryAfterMs / MS_PER_MINUTE));
    return t('auth:flow.rateLimited', { count: minutes });
  }
  return errorMessage(t, error);
}
