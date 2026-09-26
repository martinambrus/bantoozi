import { describe, expect, it } from 'vitest';

import { classifyNetworkError, findSafeFetchError, SafeFetchError } from '../../src/http/errors.js';

const coded = (code: string, message = 'failure'): Error =>
  Object.assign(new Error(message), { code });

describe('spec 03 §4.8 error-code mapping', () => {
  it.each([
    ['UND_ERR_CONNECT_TIMEOUT', 'FEED_TIMEOUT'],
    ['UND_ERR_HEADERS_TIMEOUT', 'FEED_TIMEOUT'],
    ['UND_ERR_BODY_TIMEOUT', 'FEED_TIMEOUT'],
    ['ETIMEDOUT', 'FEED_TIMEOUT'],
    ['UND_ERR_HEADERS_OVERFLOW', 'FEED_TOO_LARGE'],
    ['UND_ERR_RES_EXCEEDED_MAX_SIZE', 'FEED_TOO_LARGE'],
    ['CERT_HAS_EXPIRED', 'FEED_TLS_ERROR'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'FEED_TLS_ERROR'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'FEED_TLS_ERROR'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'FEED_TLS_ERROR'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'FEED_TLS_ERROR'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'FEED_TLS_ERROR'],
    ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'FEED_TLS_ERROR'],
    ['EPROTO', 'FEED_TLS_ERROR'],
    ['ENOTFOUND', 'FEED_DNS_ERROR'],
    ['EAI_AGAIN', 'FEED_DNS_ERROR'],
    ['ECONNREFUSED', 'FEED_CONNECTION_ERROR'],
    ['ECONNRESET', 'FEED_CONNECTION_ERROR'],
    ['EHOSTUNREACH', 'FEED_CONNECTION_ERROR'],
    ['UND_ERR_SOCKET', 'FEED_CONNECTION_ERROR'],
    ['HPE_INVALID_CONSTANT', 'FEED_CONNECTION_ERROR'],
    ['UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'FEED_CONNECTION_ERROR'],
  ])('%s → %s', (code, expected) => {
    const result = classifyNetworkError(coded(code));
    expect(result.code).toBe(expected);
    expect(result.message).toContain(code);
  });

  it('recognises TLS failures by the OpenSSL library field', () => {
    const error = Object.assign(new Error('handshake failure'), { library: 'SSL routines' });
    expect(classifyNetworkError(error).code).toBe('FEED_TLS_ERROR');
  });

  it('walks cause chains and Happy Eyeballs AggregateErrors', () => {
    const aggregate = new AggregateError([coded('ECONNREFUSED'), coded('ETIMEDOUT')], 'all failed');
    expect(classifyNetworkError(aggregate).code).toBe('FEED_TIMEOUT');
    const wrapped = new Error('outer', { cause: coded('CERT_HAS_EXPIRED') });
    expect(classifyNetworkError(wrapped).code).toBe('FEED_TLS_ERROR');
    const cyclic: Error & { cause?: unknown } = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(classifyNetworkError(cyclic).code).toBe('FEED_CONNECTION_ERROR');
  });

  it('keeps the client’s own failures, even when wrapped', () => {
    const own = new SafeFetchError('FEED_BLOCKED_ADDRESS', 'the destination address is not public');
    expect(classifyNetworkError(own)).toEqual({
      code: 'FEED_BLOCKED_ADDRESS',
      message: own.message,
    });
    const wrapped = new Error('connect failed', { cause: own });
    expect(findSafeFetchError(wrapped)).toBe(own);
    expect(classifyNetworkError(wrapped).code).toBe('FEED_BLOCKED_ADDRESS');
  });

  it('unknown failures are connection errors; odd codes are never echoed', () => {
    expect(classifyNetworkError(new Error('?'))).toEqual({
      code: 'FEED_CONNECTION_ERROR',
      message: 'the connection failed',
    });
    expect(classifyNetworkError('a string')).toMatchObject({ code: 'FEED_CONNECTION_ERROR' });
    expect(classifyNetworkError(null)).toMatchObject({ code: 'FEED_CONNECTION_ERROR' });
    const odd = classifyNetworkError(coded('http://internal/secret?token=x'));
    expect(odd.message).toBe('the connection failed');
  });

  it('SafeFetchError keeps its code and cause', () => {
    const cause = new Error('inner');
    const error = new SafeFetchError('FEED_DNS_ERROR', 'DNS lookup failed', { cause });
    expect(error).toMatchObject({ name: 'SafeFetchError', code: 'FEED_DNS_ERROR', cause });
    expect(new SafeFetchError('FEED_TOO_LARGE', 'x').cause).toBeUndefined();
  });
});
