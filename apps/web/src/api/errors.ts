import type { AppErrorCode } from '@bantoozi/shared';

/**
 * How a call failed:
 * - `http`: the API answered with its error envelope (spec 08 §1); `code` is the API's code;
 * - `network`: no response (offline, DNS, connection reset);
 * - `invalid_response`: a 2xx body that does not match the response schema, or a non-JSON body;
 * - `aborted`: the caller's AbortSignal fired.
 */
export type ApiErrorKind = 'http' | 'network' | 'invalid_response' | 'aborted';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  /** HTTP status; null without a response. */
  status: number | null;
  /** The envelope's `error.code`; the kind in upper case for non-HTTP failures. */
  code: AppErrorCode | 'NETWORK' | 'INVALID_RESPONSE' | 'ABORTED' | (string & {});
  message: string;
  /** The envelope's `error.details`, untouched. */
  details?: Readonly<Record<string, unknown>> | undefined;
  /** From `Retry-After` (seconds or an HTTP date) on 429/503, in milliseconds. */
  retryAfterMs?: number | null | undefined;
  cause?: unknown;
}

/** The only error type the API client throws (spec 09 §1, spec 08 §1). */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: ApiErrorInit['code'];
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly retryAfterMs: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  /** The `details.reason` string many 400/409 answers carry, if any. */
  get reason(): string | undefined {
    const reason = this.details?.['reason'];
    return typeof reason === 'string' ? reason : undefined;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Spec 09 §1: retry network failures, 5xx and 429 (with bounded backoff honouring Retry-After);
 * never retry 400/401/403/404/409 or an invalid response blindly.
 */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.kind === 'network') return true;
  if (error.kind !== 'http' || error.status === null) return false;
  return error.status === 429 || error.status >= 500;
}
