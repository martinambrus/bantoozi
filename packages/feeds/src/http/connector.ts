import { isIP } from 'node:net';

import { buildConnector } from 'undici';

import { isBlockedAddress } from './address.js';
import { SafeFetchError } from './errors.js';
import { resolveSafely, safeLookup, type Resolver } from './lookup.js';

/** Where a validated connection would go: the real hostname, validated address and port. */
export interface DialTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  protocol: 'http:' | 'https:';
}

/**
 * **Test-only seam; production code never sets it.** Rewrites the socket destination of an address
 * that has already passed every address check, e.g. to send a connection for `public.example`
 * (resolved to a public test address) to the local fixture server. The checks still run on the
 * real resolved or literal addresses, so SSRF tests keep `FETCH_ALLOW_PRIVATE` off. It is not part
 * of `SafeFetchOptions` and is not exported from the package entry.
 */
export type Dial = (target: DialTarget) => { host: string; port: number };

/** Wiring of {@link createSafeConnector}; `safeFetch` builds it from its options. */
export interface SafeConnectorOptions {
  resolver: Resolver;
  allowPrivate: boolean;
  connectTimeoutMs: number;
  /** Test-only, see {@link Dial}. */
  dial?: Dial | undefined;
}

const defaultPort = (protocol: string): number => (protocol === 'https:' ? 443 : 80);

/**
 * The undici connector of the safe client (spec 03 §4.2, §4.6). It is undici's own
 * `buildConnector` with `lookup = safeLookup(resolver)`, so every new connection to a hostname is
 * resolved and validated immediately before connecting, and wrapped to validate IP-literal hosts
 * too (Node never calls `lookup` for them; `safeFetch` checks literals before each request as
 * well). TLS verification is always on (`rejectUnauthorized: true` explicitly, so even
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot weaken it); only HTTP/1.1 is offered, so the parser's
 * header-size limit always applies.
 */
export function createSafeConnector(options: SafeConnectorOptions): buildConnector.connector {
  const connect = buildConnector({
    lookup: safeLookup(options.resolver, { allowPrivate: options.allowPrivate }),
    timeout: options.connectTimeoutMs,
    allowH2: false,
    rejectUnauthorized: true,
  });
  const { dial } = options;
  return (connectOptions, callback) => {
    const { hostname } = connectOptions;
    if (!options.allowPrivate && isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
      callback(
        new SafeFetchError('FEED_BLOCKED_ADDRESS', 'the destination address is not public'),
        null,
      );
      return;
    }
    if (dial === undefined) {
      connect(connectOptions, callback);
      return;
    }
    // Test seam: resolve and validate exactly as `safeLookup` would, then connect to the dialled
    // destination (an IP literal, so Node performs no further lookup).
    const protocol = connectOptions.protocol === 'https:' ? 'https:' : 'http:';
    const port = connectOptions.port === '' ? defaultPort(protocol) : Number(connectOptions.port);
    resolveSafely(hostname, options.resolver, options.allowPrivate).then(
      (addresses) => {
        const [first] = addresses;
        if (first === undefined) {
          callback(new SafeFetchError('FEED_DNS_ERROR', 'DNS lookup returned no addresses'), null);
          return;
        }
        try {
          const target = dial({
            hostname,
            address: first.address,
            family: first.family,
            port,
            protocol,
          });
          connect(
            { ...connectOptions, hostname: target.host, port: String(target.port) },
            callback,
          );
        } catch (error) {
          callback(error instanceof Error ? error : new Error('dial failed'), null);
        }
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('lookup failed'), null);
      },
    );
  };
}
