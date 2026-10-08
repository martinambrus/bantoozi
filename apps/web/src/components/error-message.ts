import { APP_ERROR_CODES, QUOTA_LIMIT_NAMES, type QuotaLimitName } from '@bantoozi/shared';
import type { TFunction } from 'i18next';

import { isApiError } from '../api/errors.js';

export interface QuotaDetails {
  limit: QuotaLimitName;
  used: number;
  max: number;
}

const FEED_HTTP_CODE = /^FEED_HTTP_(\d{3})$/;

function isQuotaLimitName(value: unknown): value is QuotaLimitName {
  return typeof value === 'string' && (QUOTA_LIMIT_NAMES as readonly string[]).includes(value);
}

/**
 * The `{limit, used, max}` of a QUOTA_EXCEEDED answer, or null for any other shape: the invites
 * quota answers with `{limit: 'invites', invitesLeft}` and must not print a half-filled sentence.
 */
export function quotaDetails(error: unknown): QuotaDetails | null {
  if (!isApiError(error) || error.code !== 'QUOTA_EXCEEDED') return null;
  const limit = error.details?.['limit'];
  const used = error.details?.['used'];
  const max = error.details?.['max'];
  if (!isQuotaLimitName(limit) || !Number.isFinite(used) || !Number.isFinite(max)) return null;
  return { limit, used: used as number, max: max as number };
}

export function quotaMessage(t: TFunction, { limit, used, max }: QuotaDetails): string {
  return t('common:errors.QUOTA_EXCEEDED', { limit: t(`common:quota.${limit}`), used, max });
}

/** The user-facing sentence for anything a call can throw (spec 09 §1); never the raw server text. */
export function errorMessage(t: TFunction, error: unknown): string {
  if (!isApiError(error)) return t('common:errors.UNKNOWN');
  switch (error.kind) {
    case 'network':
      return t('common:errors.NETWORK');
    case 'invalid_response':
      return t('common:errors.INVALID_RESPONSE');
    case 'aborted':
      return t('common:errors.ABORTED');
    case 'http':
      break;
  }

  const feedHttpStatus = FEED_HTTP_CODE.exec(error.code)?.[1];
  if (feedHttpStatus !== undefined) return t('common:errors.FEED_HTTP', { status: feedHttpStatus });
  if (!(APP_ERROR_CODES as readonly string[]).includes(error.code)) {
    return t('common:errors.UNKNOWN');
  }
  if (error.code === 'QUOTA_EXCEEDED') {
    const quota = quotaDetails(error);
    return quota === null ? t('common:errors.QUOTA_EXCEEDED_GENERIC') : quotaMessage(t, quota);
  }
  return t(`common:errors.${error.code}`);
}
