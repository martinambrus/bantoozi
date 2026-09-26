import type { FeedErrorCode } from '@bantoozi/shared';

/** The failure codes the safe client raises itself, before or while reading a response. */
export type InternalFailureCode =
  'FEED_BLOCKED_ADDRESS' | 'FEED_DNS_ERROR' | 'FEED_TOO_LARGE' | 'FEED_DECODE_ERROR';

/**
 * An expected fetch failure raised inside the safe client (spec 03 §4): a blocked or unresolvable
 * destination from `safeLookup`, or a body over the size cap or with a corrupt content encoding.
 * `safeFetch` turns it into its `code`; messages never contain URLs, queries or resolved addresses
 * (so an error shown to a user cannot map internal DNS).
 */
export class SafeFetchError extends Error {
  readonly code: InternalFailureCode;

  constructor(code: InternalFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

/** A network-level failure code with a log-safe message (no URL, no resolved address). */
export interface ClassifiedError {
  code: FeedErrorCode;
  message: string;
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

const TOO_LARGE_CODES = new Set([
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'HPE_HEADER_OVERFLOW',
]);

const DNS_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EAI_NODATA',
  'ENODATA',
  'ESERVFAIL',
  'ENONAME',
  'EBADNAME',
  'EBADRESP',
  'EFORMERR',
  'ENOTIMP',
]);

/** OpenSSL verification results and TLS/SSL error codes as Node reports them. */
const TLS_CODE =
  /^(?:ERR_SSL_|ERR_TLS_|ERR_OSSL_|SSL_)|CERT|CRL|^DEPTH_ZERO_SELF_SIGNED|^UNABLE_TO_|^INVALID_CA$|^PATH_LENGTH_EXCEEDED$|^INVALID_PURPOSE$|^HOSTNAME_MISMATCH$|^EPROTO$/;

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** The error, its `cause` chain and `AggregateError` members (Happy Eyeballs), breadth first. */
function errorChain(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  const chain: unknown[] = [];
  while (queue.length > 0 && chain.length < 16) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (typeof current !== 'object') continue;
    const { cause, errors } = current as { cause?: unknown; errors?: unknown };
    if (cause !== undefined) queue.push(cause);
    if (Array.isArray(errors)) queue.push(...(errors as unknown[]));
  }
  return chain;
}

/** The client's own failure inside `error`'s cause chain, if any. */
export function findSafeFetchError(error: unknown): SafeFetchError | undefined {
  return errorChain(error).find((item): item is SafeFetchError => item instanceof SafeFetchError);
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

function isTlsError(error: unknown, code: string | undefined): boolean {
  if (code !== undefined && TLS_CODE.test(code)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { library } = error as { library?: unknown };
  return typeof library === 'string' && /ssl|tls/i.test(library);
}

const withCode = (text: string, code: string | undefined): string =>
  code === undefined ? text : `${text} (${code})`;

/**
 * Maps a failure thrown while connecting or reading a response to its spec 03 §4.8 code: our own
 * `SafeFetchError`s keep their code; timeouts → `FEED_TIMEOUT`; oversized headers → `FEED_TOO_LARGE`;
 * TLS and certificate failures → `FEED_TLS_ERROR`; resolver failures → `FEED_DNS_ERROR`; refused,
 * reset and every other socket or protocol error → `FEED_CONNECTION_ERROR`. Deadline and caller
 * aborts are decided by the caller, which knows its signals.
 */
export function classifyNetworkError(error: unknown): ClassifiedError {
  const own = findSafeFetchError(error);
  if (own !== undefined) return { code: own.code, message: own.message };
  const chain = errorChain(error);
  const codes = chain.map(codeOf);
  const firstCode = (match: (code: string | undefined, item: unknown) => boolean) => {
    const index = chain.findIndex((item, i) => match(codes[i], item));
    return index === -1 ? undefined : { code: codes[index] };
  };
  const timeout = firstCode((code) => code !== undefined && TIMEOUT_CODES.has(code));
  if (timeout !== undefined) {
    return { code: 'FEED_TIMEOUT', message: withCode('the request timed out', timeout.code) };
  }
  const tooLarge = firstCode((code) => code !== undefined && TOO_LARGE_CODES.has(code));
  if (tooLarge !== undefined) {
    return {
      code: 'FEED_TOO_LARGE',
      message: withCode('the response headers exceed the size limit', tooLarge.code),
    };
  }
  const tls = firstCode((code, item) => isTlsError(item, code));
  if (tls !== undefined) {
    return {
      code: 'FEED_TLS_ERROR',
      message: withCode('TLS handshake or certificate verification failed', tls.code),
    };
  }
  const dns = firstCode((code) => code !== undefined && DNS_CODES.has(code));
  if (dns !== undefined) {
    return { code: 'FEED_DNS_ERROR', message: withCode('DNS lookup failed', dns.code) };
  }
  return {
    code: 'FEED_CONNECTION_ERROR',
    message: withCode(
      'the connection failed',
      codes.find((code) => code !== undefined),
    ),
  };
}
