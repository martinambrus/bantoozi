import { z } from 'zod';

/** Feed/fetch error codes of the safe HTTP client and discovery (spec 03 §4, §10). */
export const FEED_ERROR_CODES = [
  'FEED_BLOCKED_ADDRESS',
  'FEED_DNS_ERROR',
  'FEED_TIMEOUT',
  'FEED_TLS_ERROR',
  'FEED_CONNECTION_ERROR',
  'FEED_TOO_LARGE',
  'FEED_TOO_MANY_REDIRECTS',
  'FEED_INVALID_URL',
  'FEED_DECODE_ERROR',
  'FEED_NOT_A_FEED',
  'FEED_PARSE_ERROR',
  /**
   * No request was sent: the origin is cooling down after a 429/503, or its politeness throttle
   * cannot grant a start before the request deadline (spec 03 §4, §8.2). Callers defer the work.
   */
  'FEED_ORIGIN_COOLDOWN',
] as const;

/** `FEED_HTTP_<status>` carries the upstream HTTP status (spec 03 §4). */
export type FeedHttpErrorCode = `FEED_HTTP_${number}`;
export type FeedErrorCode = (typeof FEED_ERROR_CODES)[number] | FeedHttpErrorCode;

/** Stable application error codes (spec 01 §5, spec 08 §1). */
export const APP_ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CODE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_CURSOR',
  'STALE_STATE',
  'IDEMPOTENCY_CONFLICT',
  'QUOTA_EXCEEDED',
  'INVITE_REQUIRED',
  'RATE_LIMITED',
  'ENGINE_UNAVAILABLE',
  /** An unimplemented pipeline stage: the durable intent is kept, never acknowledged (PLAN §0.5). */
  'STAGE_UNAVAILABLE',
  'INTERNAL',
  ...FEED_ERROR_CODES,
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number] | FeedHttpErrorCode;

const FEED_HTTP_CODE = /^FEED_HTTP_[1-5]\d\d$/;

export function isAppErrorCode(value: string): value is AppErrorCode {
  return (APP_ERROR_CODES as readonly string[]).includes(value) || FEED_HTTP_CODE.test(value);
}

export function feedHttpErrorCode(status: number): FeedHttpErrorCode {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError('HTTP status must be an integer between 100 and 599');
  }
  return `FEED_HTTP_${status}`;
}

const STATUS_BY_CODE: Record<(typeof APP_ERROR_CODES)[number], number> = {
  VALIDATION_FAILED: 400,
  INVALID_CODE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_CURSOR: 409,
  STALE_STATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  QUOTA_EXCEEDED: 409,
  INVITE_REQUIRED: 403,
  RATE_LIMITED: 429,
  ENGINE_UNAVAILABLE: 503,
  STAGE_UNAVAILABLE: 503,
  INTERNAL: 500,
  FEED_BLOCKED_ADDRESS: 422,
  FEED_DNS_ERROR: 422,
  FEED_TIMEOUT: 422,
  FEED_TLS_ERROR: 422,
  FEED_CONNECTION_ERROR: 422,
  FEED_TOO_LARGE: 422,
  FEED_TOO_MANY_REDIRECTS: 422,
  FEED_INVALID_URL: 422,
  FEED_DECODE_ERROR: 422,
  FEED_NOT_A_FEED: 422,
  FEED_PARSE_ERROR: 422,
  FEED_ORIGIN_COOLDOWN: 422,
};

/** The single code → HTTP status mapping used by `apps/api/src/plugins/errors.ts` (spec 08 §1). */
export function httpStatusForCode(code: AppErrorCode): number {
  if (FEED_HTTP_CODE.test(code)) return 422;
  return STATUS_BY_CODE[code as (typeof APP_ERROR_CODES)[number]] ?? 500;
}

export type AppErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Base class for expected application errors. `message` is human text (English) for logs and API
 * clients; clients localize by `code`. Never put secrets or private text into `message`/`details`.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: AppErrorDetails | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    options?: { details?: AppErrorDetails; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options?.details;
  }

  get httpStatus(): number {
    return httpStatusForCode(this.code);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** `409 QUOTA_EXCEEDED {limit, used, max}` (spec 08 §6). */
export class QuotaExceededError extends AppError {
  constructor(limit: string, used: number, max: number) {
    super('QUOTA_EXCEEDED', `Quota ${limit} exceeded`, { details: { limit, used, max } });
    this.name = 'QuotaExceededError';
  }
}

/** Error envelope of every API error response (spec 08 §1). */
export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().max(2000),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
