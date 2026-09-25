import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

/** New user id (UUID v7, generated in code; spec 01 §5, spec 02 §2). */
export function newUserId(): string {
  return uuidv7();
}

/** New time-ordered UUID (v7) for other server-generated ids (analysis requests, reservations). */
export function newUuid(): string {
  return uuidv7();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Canonical lower-case UUID string. */
export const UuidSchema = z
  .string()
  .regex(UUID_PATTERN, 'must be a UUID')
  .transform((s) => s.toLowerCase());

/**
 * Bigint ids and revision counters travel as decimal strings in JSON, cursors and job payloads
 * (spec 01 §5). They are never round-tripped through JS `number`.
 */
export const BIGINT_MIN = -(2n ** 63n);
export const BIGINT_MAX = 2n ** 63n - 1n;

const DECIMAL = /^(0|-?[1-9]\d*)$/;

/** True for a canonical decimal string within PostgreSQL `bigint` range. */
export function isBigIntString(value: string): boolean {
  if (!DECIMAL.test(value) || value === '-0') return false;
  const n = BigInt(value);
  return n >= BIGINT_MIN && n <= BIGINT_MAX;
}

/** A canonical decimal `bigint` string (any sign). */
export const BigIntStringSchema = z
  .string()
  .refine(isBigIntString, 'must be a decimal bigint string');

/** A positive database id (identity columns start at 1). */
export const IdSchema = BigIntStringSchema.refine((s) => BigInt(s) > 0n, 'must be a positive id');

/** A non-negative revision counter. */
export const RevisionSchema = BigIntStringSchema.refine(
  (s) => BigInt(s) >= 0n,
  'must be a non-negative revision',
);

export function toBigIntString(value: bigint | string): string {
  const s = typeof value === 'bigint' ? value.toString() : value;
  if (!isBigIntString(s)) throw new RangeError('not a decimal bigint string');
  return s;
}

export function parseBigIntString(value: string): bigint {
  if (!isBigIntString(value)) throw new RangeError('not a decimal bigint string');
  return BigInt(value);
}

export function compareBigIntStrings(a: string, b: string): -1 | 0 | 1 {
  const x = parseBigIntString(a);
  const y = parseBigIntString(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The next revision after `value` (`value + 1`), as a string. */
export function nextRevision(value: string): string {
  return toBigIntString(parseBigIntString(value) + 1n);
}
