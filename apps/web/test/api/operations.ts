import expectedOperations from '../../../api/test/expected-operations.txt?raw';

/** `METHOD /path` of every operation, from the API's own test list. */
export const EXPECTED_OPERATIONS = expectedOperations
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

/**
 * The mutations that carry no Idempotency-Key: the sign-in flow (spec 08 §1.1), the waitlist and
 * the bearer-token ops event, which has its own flow.
 */
export const WITHOUT_IDEMPOTENCY_KEY = new Set([
  'POST /auth/request-code',
  'POST /auth/verify',
  'POST /auth/logout',
  'POST /waitlist',
  'POST /admin/ops-event',
]);

/** Whether the client must send an Idempotency-Key for this operation. */
export function needsIdempotencyKey(operation: string): boolean {
  return !operation.startsWith('GET ') && !WITHOUT_IDEMPOTENCY_KEY.has(operation);
}
