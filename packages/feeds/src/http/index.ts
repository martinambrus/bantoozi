/** Safe HTTP client and charset decoding (spec 03 §4) — M1-T1. */
export {
  ALLOWED_PORTS,
  isBlockedAddress,
  SPECIAL_PURPOSE_RANGES,
  type SpecialPurposeRange,
} from './address.js';
export {
  decodeBody,
  DECLARATION_PROBE_BYTES,
  REPLACEMENT_RATIO_LIMIT,
  supportedEncoding,
  type DecodeResult,
} from './decode-body.js';
export { SafeFetchError, type InternalFailureCode } from './errors.js';
export {
  resolveSafely,
  safeLookup,
  systemResolver,
  type ResolvedAddress,
  type Resolver,
} from './lookup.js';
export { MAX_RETRY_AFTER_MS, parseRetryAfter } from './retry-after.js';
export {
  ACCEPT_HEADERS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  LEASE_MARGIN_MS,
  MAX_RESPONSE_HEADER_BYTES,
  safeFetch,
  type FetchPurpose,
  type RedirectHop,
  type SafeFetchErrorCode,
  type SafeFetchFailure,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SafeFetchSuccess,
} from './safe-fetch.js';
export { MAX_URL_BYTES, originOf, redactUrl } from './url.js';
