import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

import { isBlockedAddress } from './address.js';
import { SafeFetchError } from './errors.js';

/** One DNS answer. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Injectable DNS (spec 03 §4.2(b)): maps a hostname to its addresses. Tests inject a map, so SSRF
 * tests never touch real DNS; production uses {@link systemResolver}.
 */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** `dns.lookup(hostname, { all: true })` in resolver order: the operating system's resolver. */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
};

/**
 * Resolves `hostname` and validates the complete answer (spec 03 §4.2(b)): an IP literal is checked
 * directly (no resolver call); otherwise it fails with `FEED_DNS_ERROR` when the resolver fails,
 * answers nothing or answers something that is not an IP address, and with `FEED_BLOCKED_ADDRESS`
 * when **any** answer is blocked, even if others are public. `allowPrivate` (FETCH_ALLOW_PRIVATE)
 * skips only the blocked-range check. Messages never name the resolved addresses.
 */
export async function resolveSafely(
  hostname: string,
  resolver: Resolver,
  allowPrivate: boolean,
): Promise<ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new SafeFetchError('FEED_BLOCKED_ADDRESS', 'the destination address is not public');
    }
    return [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }];
  }
  let answers: unknown;
  try {
    answers = await resolver(hostname);
  } catch (error) {
    const code = errorCode(error);
    throw new SafeFetchError(
      'FEED_DNS_ERROR',
      code === undefined ? 'DNS lookup failed' : `DNS lookup failed (${code})`,
      { cause: error },
    );
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new SafeFetchError('FEED_DNS_ERROR', 'DNS lookup returned no addresses');
  }
  const validated: ResolvedAddress[] = [];
  for (const answer of answers as unknown[]) {
    const address =
      typeof answer === 'object' && answer !== null
        ? (answer as { address?: unknown }).address
        : undefined;
    const family = typeof address === 'string' ? isIP(address) : 0;
    if (typeof address !== 'string' || family === 0) {
      throw new SafeFetchError('FEED_DNS_ERROR', 'DNS lookup returned an invalid address');
    }
    if (!allowPrivate && isBlockedAddress(address)) {
      throw new SafeFetchError('FEED_BLOCKED_ADDRESS', 'the host resolves to a non-public address');
    }
    validated.push({ address, family: family === 6 ? 6 : 4 });
  }
  return validated;
}

const wantedFamily = (family: LookupOptions['family']): 0 | 4 | 6 =>
  family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : 0;

/**
 * A Node-style `lookup` for an undici `Agent`'s `connect.lookup` (spec 03 §4.2(b)). Node calls it
 * for every new connection to a hostname, so each connection (including pooled replacements) is
 * re-validated, and the socket connects to exactly the validated addresses: no DNS rebinding
 * between check and connect. It honours `options.all` (Node 22's `autoSelectFamily` asks for
 * all answers: the full array of allowed addresses; otherwise the first) and `options.family`.
 * Errors are {@link SafeFetchError}s with code `FEED_BLOCKED_ADDRESS` or `FEED_DNS_ERROR`.
 */
export function safeLookup(
  resolver: Resolver = systemResolver,
  options: { allowPrivate?: boolean } = {},
): LookupFunction {
  const allowPrivate = options.allowPrivate === true;
  return (hostname, lookupOptions, callback) => {
    const opts: LookupOptions =
      typeof lookupOptions === 'object' && lookupOptions !== null ? lookupOptions : {};
    const family = wantedFamily(opts.family);
    resolveSafely(hostname, resolver, allowPrivate).then(
      (addresses) => {
        const usable =
          family === 0 ? addresses : addresses.filter((entry) => entry.family === family);
        const [first] = usable;
        if (first === undefined) {
          callback(new SafeFetchError('FEED_DNS_ERROR', `no IPv${family} address`), []);
        } else if (opts.all === true) {
          callback(
            null,
            usable.map((entry): LookupAddress => ({
              address: entry.address,
              family: entry.family,
            })),
          );
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(
          error instanceof SafeFetchError
            ? error
            : new SafeFetchError('FEED_DNS_ERROR', 'DNS lookup failed', { cause: error }),
          [],
        );
      },
    );
  };
}
