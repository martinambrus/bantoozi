import { randomBytes } from 'node:crypto';

/**
 * The scenarios share one database for the whole run, and what one appends to a fixture feed stays
 * in it, so every scenario signs in with accounts of its own and titles no other scenario uses.
 */

/** Eight hex digits, to make a title or an address unique within the run. */
export function uniqueTag(): string {
  return randomBytes(4).toString('hex');
}

/** A sign-in address nobody else uses; open signup creates the account on first use. */
export function newAccount(label: string): string {
  return `${label}-${uniqueTag()}@example.com`;
}
