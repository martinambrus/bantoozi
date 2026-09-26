import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';

/**
 * Destination ports the safe client may connect to (spec 03 §4.1). Any other port, explicit in the
 * URL or implied by its scheme, fails with `FEED_BLOCKED_ADDRESS` unless `FETCH_ALLOW_PRIVATE` is set.
 */
export const ALLOWED_PORTS: readonly number[] = Object.freeze([80, 443, 8080, 8443]);

/** One entry of the pinned special-purpose range table. */
export interface SpecialPurposeRange {
  /** CIDR notation, e.g. `10.0.0.0/8`. */
  readonly cidr: string;
  readonly name: string;
}

const range = (cidr: string, name: string): SpecialPurposeRange => Object.freeze({ cidr, name });

/**
 * The pinned special-purpose table (spec 03 §4.2): no address inside these ranges is ever a fetch
 * destination. It starts with the spec's list and adds further IANA special-purpose entries, so an
 * `ipaddr.js` upgrade can never silently shrink the blocked set. `::ffff:0:0/96` (IPv4-mapped) is
 * deliberately absent: those addresses are judged by their embedded IPv4 address instead.
 */
export const SPECIAL_PURPOSE_RANGES: {
  readonly ipv4: readonly SpecialPurposeRange[];
  readonly ipv6: readonly SpecialPurposeRange[];
} = Object.freeze({
  ipv4: Object.freeze([
    range('0.0.0.0/8', '"this network" (RFC 791)'),
    range('10.0.0.0/8', 'private use (RFC 1918)'),
    range('100.64.0.0/10', 'shared address space / CGN (RFC 6598)'),
    range('127.0.0.0/8', 'loopback (RFC 1122)'),
    range('169.254.0.0/16', 'link local, incl. cloud metadata (RFC 3927)'),
    range('172.16.0.0/12', 'private use (RFC 1918)'),
    range('192.0.0.0/24', 'IETF protocol assignments (RFC 6890)'),
    range('192.0.2.0/24', 'documentation TEST-NET-1 (RFC 5737)'),
    range('192.88.99.0/24', 'deprecated 6to4 relay anycast (RFC 7526)'),
    range('192.168.0.0/16', 'private use (RFC 1918)'),
    range('198.18.0.0/15', 'benchmarking (RFC 2544)'),
    range('198.51.100.0/24', 'documentation TEST-NET-2 (RFC 5737)'),
    range('203.0.113.0/24', 'documentation TEST-NET-3 (RFC 5737)'),
    range('224.0.0.0/4', 'multicast (RFC 5771)'),
    range('240.0.0.0/4', 'reserved (RFC 1112)'),
    range('255.255.255.255/32', 'limited broadcast (RFC 919)'),
  ]),
  ipv6: Object.freeze([
    range('::/128', 'unspecified (RFC 4291)'),
    range('::1/128', 'loopback (RFC 4291)'),
    range('::/96', 'IPv4-compatible, deprecated (RFC 4291)'),
    range('::ffff:0:0:0/96', 'IPv4-translated (RFC 6145)'),
    range('64:ff9b::/96', 'NAT64 well-known prefix (RFC 6052)'),
    range('64:ff9b:1::/48', 'local-use NAT64 (RFC 8215)'),
    range('100::/64', 'discard only (RFC 6666)'),
    range('2001::/23', 'IETF protocol assignments (RFC 2928)'),
    range('2001::/32', 'Teredo (RFC 4380)'),
    range('2001:db8::/32', 'documentation (RFC 3849)'),
    range('2002::/16', '6to4 (RFC 3056)'),
    range('3fff::/20', 'documentation (RFC 9637)'),
    range('5f00::/16', 'SRv6 SIDs (RFC 9602)'),
    range('fc00::/7', 'unique local (RFC 4193)'),
    range('fe80::/10', 'link-local unicast (RFC 4291)'),
    range('fec0::/10', 'site-local, deprecated (RFC 3879)'),
    range('ff00::/8', 'multicast (RFC 4291)'),
  ]),
});

const IPV4_BLOCKED = SPECIAL_PURPOSE_RANGES.ipv4.map((entry) => ipaddr.IPv4.parseCIDR(entry.cidr));
const IPV6_BLOCKED = SPECIAL_PURPOSE_RANGES.ipv6.map((entry) => ipaddr.IPv6.parseCIDR(entry.cidr));
/** Global unicast (RFC 4291 §2.4): every other IPv6 prefix is reserved or special. */
const IPV6_GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR('2000::/3');

function isBlockedIPv4(address: ipaddr.IPv4): boolean {
  // ipaddr.js names every special range; only its default `unicast` class may pass. This also
  // excludes the AS112 and AMT anycast blocks, from which no feed is ever served.
  if (address.range() !== 'unicast') return true;
  return IPV4_BLOCKED.some((cidr) => address.match(cidr));
}

function isBlockedIPv6(address: ipaddr.IPv6): boolean {
  if (!address.match(IPV6_GLOBAL_UNICAST)) return true;
  if (address.range() !== 'unicast') return true;
  return IPV6_BLOCKED.some((cidr) => address.match(cidr));
}

/**
 * Whether the safe client must refuse to connect to `address` (spec 03 §4.2). True unless the
 * address is a global unicast destination: every range of the pinned table, IPv6 outside
 * `2000::/3` (which covers IPv4-compatible `::a.b.c.d`), any address with a scope/zone ID
 * (`fe80::1%eth0`), and anything that is not a canonical IP literal (so `2130706433` or `0x7f.1`,
 * which only WHATWG URL parsing normalizes, fail closed here). IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * is judged by its embedded IPv4 address. Surrounding brackets (`[::1]`) are accepted.
 */
export function isBlockedAddress(address: string): boolean {
  const literal = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  // A zone ID only ever qualifies link-local or other non-global addresses.
  if (literal.includes('%')) return true;
  const family = isIP(literal);
  if (family === 0) return true;
  try {
    if (family === 4) return isBlockedIPv4(ipaddr.IPv4.parse(literal));
    const parsed = ipaddr.IPv6.parse(canonicalIPv6(literal));
    return parsed.isIPv4MappedAddress()
      ? isBlockedIPv4(parsed.toIPv4Address())
      : isBlockedIPv6(parsed);
  } catch {
    return true;
  }
}

/**
 * The all-hex RFC 5952 form of an IPv6 literal, via the WHATWG URL serializer. ipaddr.js parses the
 * deprecated IPv4-compatible form `::a.b.c.d` as IPv4-mapped `::ffff:a.b.c.d`, which would judge
 * `::93.184.216.34` by its embedded public IPv4 address although the kernel connects to the
 * IPv6 address `::5db8:d822`; the hex form is parsed without that shortcut.
 */
function canonicalIPv6(literal: string): string {
  return new URL(`http://[${literal}]/`).hostname.slice(1, -1);
}
