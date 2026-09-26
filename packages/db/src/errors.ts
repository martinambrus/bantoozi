import { AppError, type AppErrorCode } from '@bantoozi/shared';

/**
 * SQLSTATEs raised by the SQL functions and integrity triggers (drizzle 0003/0004) and the
 * PostgreSQL errors repositories expect, mapped to stable application codes. Messages stay generic:
 * database error text can name private values, so it is never passed through.
 */
const SQLSTATE_TO_CODE: Readonly<Record<string, { code: AppErrorCode; message: string }>> = {
  BZ404: { code: 'NOT_FOUND', message: 'Not found' },
  BZ409: { code: 'CONFLICT', message: 'The resource changed or is in a conflicting state' },
  '22023': { code: 'VALIDATION_FAILED', message: 'Invalid parameters' },
  '42501': { code: 'FORBIDDEN', message: 'Not allowed' },
  '23505': { code: 'CONFLICT', message: 'Already exists' },
  '23503': { code: 'CONFLICT', message: 'A referenced resource is missing or still in use' },
  '23514': { code: 'CONFLICT', message: 'The change violates an integrity rule' },
  '40001': { code: 'CONFLICT', message: 'Concurrent update; retry' },
  '40P01': { code: 'CONFLICT', message: 'Concurrent update; retry' },
};

/** The SQLSTATE of a node-postgres error, also when wrapped (e.g. by Drizzle's query error). */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** An {@link AppError} for a known database error, or `undefined` (rethrow the original). */
export function mapDbError(error: unknown): AppError | undefined {
  const state = sqlState(error);
  const mapped = state === undefined ? undefined : SQLSTATE_TO_CODE[state];
  if (mapped === undefined) return undefined;
  return new AppError(mapped.code, mapped.message, {
    details: { sqlState: state },
    cause: error,
  });
}
