import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError, canonicalJson } from '@bantoozi/shared';
import { sha256Hex } from '@bantoozi/shared/server';

/**
 * Signed pagination cursors (spec 08 §1 "Pagination"): base64url JSON carrying a version, the
 * complete sort-key tuple, a normalized filter hash, the user id and an expiry, authenticated with
 * an HMAC keyed from `SESSION_PEPPER`. A cursor for another user or query, an expired one or a bad
 * signature is `VALIDATION_FAILED`. A cursor is never an authorization grant: the query that
 * consumes it still applies every scope/access predicate.
 */

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;

export interface CursorPayload<K = unknown, E = unknown> {
  /** Sort-key tuple of the last row of the previous page (nulls and the final id included). */
  key: K;
  /** Hash of the normalized query (filters/sort) the cursor belongs to. */
  query: string;
  /** Extra per-endpoint state, e.g. `asOf`/`datasetVersion` of the article list (spec 08 §5.1). */
  extra?: E;
}

export interface CursorCodec {
  encode<K, E>(payload: CursorPayload<K, E>, input: { userId: string; ttlSeconds: number }): string;
  /** Throws `VALIDATION_FAILED` unless the cursor is genuine, unexpired, this user's and this query's. */
  decode<K, E>(cursor: string, input: { userId: string; query: string }): CursorPayload<K, E>;
}

interface Envelope {
  v: number;
  u: string;
  q: string;
  k: unknown;
  x?: unknown;
  exp: number;
}

const invalid = () => new AppError('VALIDATION_FAILED', 'Invalid cursor');

/** `now` is injected so tests can expire cursors deterministically. */
export function createCursorCodec(secret: string, now: () => Date = () => new Date()): CursorCodec {
  // A dedicated key derived from the pepper, so a cursor MAC can never be replayed as a code hash.
  const key = createHmac('sha256', secret).update('bantoozi:cursor:v1').digest();
  const sign = (data: string) => createHmac('sha256', key).update(data).digest();

  return {
    encode(payload, input) {
      const envelope: Envelope = {
        v: CURSOR_VERSION,
        u: input.userId,
        q: payload.query,
        k: payload.key,
        ...(payload.extra === undefined ? {} : { x: payload.extra }),
        exp: Math.floor(now().getTime() / 1000) + input.ttlSeconds,
      };
      const data = Buffer.from(canonicalJson(envelope), 'utf8').toString('base64url');
      return `${data}.${sign(data).toString('base64url')}`;
    },
    decode<K, E>(cursor: string, input: { userId: string; query: string }) {
      if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw invalid();
      const dot = cursor.indexOf('.');
      if (dot <= 0 || dot !== cursor.lastIndexOf('.')) throw invalid();
      const data = cursor.slice(0, dot);
      const mac = Buffer.from(cursor.slice(dot + 1), 'base64url');
      const expected = sign(data);
      if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw invalid();
      let envelope: Envelope;
      try {
        envelope = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Envelope;
      } catch {
        throw invalid();
      }
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        envelope.v !== CURSOR_VERSION ||
        envelope.u !== input.userId ||
        envelope.q !== input.query ||
        typeof envelope.exp !== 'number' ||
        envelope.exp * 1000 <= now().getTime()
      ) {
        throw invalid();
      }
      return {
        key: envelope.k as K,
        query: envelope.q,
        ...(envelope.x === undefined ? {} : { extra: envelope.x as E }),
      };
    },
  };
}

/** The normalized hash of a query object (filters and sort), for {@link CursorPayload.query}. */
export function queryHash(query: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(query).filter(([name, value]) => value !== undefined && name !== 'cursor'),
  );
  return sha256Hex(canonicalJson(normalized));
}
