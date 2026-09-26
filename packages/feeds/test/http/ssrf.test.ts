import ipaddr from 'ipaddr.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isBlockedAddress, SPECIAL_PURPOSE_RANGES } from '../../src/http/address.js';
import { createSafeConnector } from '../../src/http/connector.js';
import { SafeFetchError } from '../../src/http/errors.js';
import { safeFetch } from '../../src/http/safe-fetch.js';
import {
  expectFailure,
  expectOk,
  mapResolver,
  options,
  startSeamHarness,
  USER_AGENT,
  type SeamHarness,
} from './helpers.js';

/** The blocked ranges exactly as spec 03 §4.2 lists them (independent of the implementation). */
const SPEC_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const SPEC_IPV6_RANGES = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '2001:db8::/32',
  '2002::/16',
  '2001::/32',
];

function toAddress(value: bigint, length: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < length; i += 1) {
    bytes.unshift(Number((value >> BigInt(i * 8)) & 0xffn));
  }
  return ipaddr.fromByteArray(bytes).toString();
}

/** The first, a middle and the last address of a CIDR range. */
function samplesOf(cidr: string): string[] {
  const [network, bits] = ipaddr.parseCIDR(cidr);
  const bytes = network.toByteArray();
  const hostBits = BigInt(bytes.length * 8 - bits);
  const value = bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const first = (value >> hostBits) << hostBits;
  const last = first | ((1n << hostBits) - 1n);
  const middle = first + ((last - first) >> 1n) + 1n;
  return [...new Set([first, middle > last ? last : middle, last])].map((v) =>
    toAddress(v, bytes.length),
  );
}

const ALL_RANGES = [
  ...new Set([
    ...SPEC_IPV4_RANGES,
    ...SPEC_IPV6_RANGES,
    ...SPECIAL_PURPOSE_RANGES.ipv4.map((entry) => entry.cidr),
    ...SPECIAL_PURPOSE_RANGES.ipv6.map((entry) => entry.cidr),
  ]),
];
const RANGE_SAMPLES = ALL_RANGES.flatMap((cidr) =>
  samplesOf(cidr).map((address) => ({ cidr, address })),
);

describe('spec 03 §4.2 SSRF protection (FETCH_ALLOW_PRIVATE off)', () => {
  describe('§4.2(b) the injected resolver maps names into every blocked IPv4/IPv6 range', () => {
    it('samples cover every range of the spec list and of the pinned table', () => {
      for (const cidr of [...SPEC_IPV4_RANGES, ...SPEC_IPV6_RANGES]) {
        expect(RANGE_SAMPLES.some((sample) => sample.cidr === cidr)).toBe(true);
      }
      expect(RANGE_SAMPLES.length).toBeGreaterThan(90);
    });

    it.each(RANGE_SAMPLES)('rejects a name resolving to $address ($cidr)', async ({ address }) => {
      const { resolver, calls } = mapResolver({ 'evil.example': address });
      const result = expectFailure(
        await safeFetch('http://evil.example/feed', options({ resolver })),
      );
      expect(result.code).toBe('FEED_BLOCKED_ADDRESS');
      expect(calls).toEqual(['evil.example']);
      // The message never discloses what an internal name resolves to.
      expect(result.message).not.toContain(address);
    });

    it.each([
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      '::ffff:169.254.169.254',
      '::ffff:192.168.0.1',
      '::ffff:0.0.0.0',
    ])('rejects IPv4-mapped %s by its embedded IPv4 address', async (address) => {
      const { resolver } = mapResolver({ 'evil.example': address });
      const result = await safeFetch('https://evil.example/', options({ resolver }));
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
    });

    it.each([
      ['IPv4-compatible loopback', '::127.0.0.1'],
      ['IPv4-compatible public', '::93.184.216.34'],
      ['6to4 embedding loopback', '2002:7f00:1::1'],
      ['6to4 embedding a public address', '2002:5db8:d822::1'],
      ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
      ['NAT64 embedding loopback', '64:ff9b::7f00:1'],
      ['NAT64 embedding a public address', '64:ff9b::5db8:d822'],
      ['local-use NAT64', '64:ff9b:1::a00:1'],
      ['AWS IPv6 metadata (unique local)', 'fd00:ec2::254'],
      ['documentation 3fff::/20', '3fff::1'],
      ['site-local', 'fec0::1'],
      ['discard-only', '100::1'],
      ['IPv4 cloud metadata', '169.254.169.254'],
      ['limited broadcast', '255.255.255.255'],
    ])('rejects %s (%s)', async (_label, address) => {
      const { resolver } = mapResolver({ 'evil.example': address });
      const result = await safeFetch('http://evil.example/', options({ resolver }));
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
    });

    it('rejects when ANY answer is blocked, even if the first one is public', async () => {
      const { resolver } = mapResolver({ 'mixed.example': ['93.184.216.34', '10.0.0.1'] });
      const result = await safeFetch('http://mixed.example/', options({ resolver }));
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
    });

    it('rejects DNS answers with no usable address as FEED_DNS_ERROR', async () => {
      const empty = await safeFetch(
        'http://empty.example/',
        options({ resolver: () => Promise.resolve([]) }),
      );
      expect(empty).toMatchObject({ ok: false, code: 'FEED_DNS_ERROR' });
      const invalid = await safeFetch(
        'http://garbage.example/',
        options({ resolver: () => Promise.resolve([{ address: '2130706433', family: 4 }]) }),
      );
      expect(invalid).toMatchObject({ ok: false, code: 'FEED_DNS_ERROR' });
      const { resolver } = mapResolver({});
      const missing = await safeFetch('http://nxdomain.example/', options({ resolver }));
      expect(missing).toMatchObject({ ok: false, code: 'FEED_DNS_ERROR' });
      expect(expectFailure(missing).message).toContain('ENOTFOUND');
    });

    it('resolves through the operating system by default (localhost → loopback → blocked)', async () => {
      const result = await safeFetch('http://localhost/feed', {
        purpose: 'feed',
        userAgent: USER_AGENT,
        timeoutMs: 5_000,
        maxBytes: 1_000,
      });
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
    });
  });

  describe('§4.2(a) IP-literal URLs are validated directly, before connecting', () => {
    it.each([
      ['http://127.0.0.1/', 'http://127.0.0.1/'],
      ['http://[::1]/', 'http://[::1]/'],
      ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/'],
      ['http://2130706433/', 'http://127.0.0.1/'],
      ['http://0x7f.1/', 'http://127.0.0.1/'],
      ['http://0177.0.0.1/', 'http://127.0.0.1/'],
      ['http://0/', 'http://0.0.0.0/'],
      ['http://[::]/', 'http://[::]/'],
      ['http://169.254.169.254/latest/meta-data/', 'http://169.254.169.254/latest/meta-data/'],
      ['https://[fd00:ec2::254]/', 'https://[fd00:ec2::254]/'],
      ['http://[::127.0.0.1]/', 'http://[::7f00:1]/'],
    ])('rejects %s', async (url, normalized) => {
      const { resolver, calls } = mapResolver({});
      const result = expectFailure(await safeFetch(url, options({ resolver })));
      expect(result.code).toBe('FEED_BLOCKED_ADDRESS');
      expect(result.finalUrl).toBe(normalized);
      expect(calls).toEqual([]);
    });

    it('never opens a connection for a blocked literal (dial seam never called)', async () => {
      const harness = await startSeamHarness();
      try {
        for (const url of ['http://127.0.0.1/x', 'http://[::1]/x', 'http://2130706433/x']) {
          expect(await harness.fetch(url)).toMatchObject({ code: 'FEED_BLOCKED_ADDRESS' });
        }
        expect(harness.dialed).toEqual([]);
        expect(harness.fixture.requests).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it('the connector itself refuses blocked literal hosts (defence in depth)', async () => {
      const connector = createSafeConnector({
        resolver: mapResolver({}).resolver,
        allowPrivate: false,
        connectTimeoutMs: 1_000,
      });
      const error = await new Promise<Error | null>((resolve) => {
        connector(
          { hostname: '127.0.0.1', host: '127.0.0.1', protocol: 'http:', port: '' },
          (...args) => resolve(args[0]),
        );
      });
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).code).toBe('FEED_BLOCKED_ADDRESS');
    });
  });

  describe('§4.1 ports', () => {
    let harness: SeamHarness;
    beforeAll(async () => {
      harness = await startSeamHarness();
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(() => {
      harness.fixture.reset();
      harness.dialed.length = 0;
      harness.fixture.route('/feed', { body: '<rss/>' });
    });

    it.each([
      'http://public.example:22/feed',
      'http://public.example:6379/feed',
      'https://public.example:8000/feed',
    ])('rejects the disallowed port in %s without connecting', async (url) => {
      const result = expectFailure(await harness.fetch(url));
      expect(result.code).toBe('FEED_BLOCKED_ADDRESS');
      expect(result.message).toMatch(/port \d+ is not allowed/);
      expect(harness.dialed).toEqual([]);
    });

    it.each([
      ['http://public.example/feed', 80],
      ['http://public.example:443/feed', 443],
      ['http://public.example:8080/feed', 8080],
      ['http://public.example:8443/feed', 8443],
    ])('allows %s (port %i)', async (url, port) => {
      expectOk(await harness.fetch(url));
      expect(harness.dialed).toEqual([
        {
          hostname: 'public.example',
          address: '93.184.216.34',
          family: 4,
          port,
          protocol: 'http:',
        },
      ]);
    });
  });

  describe('§4.3 a public name that redirects to a private literal or name is rejected on that hop', () => {
    let harness: SeamHarness;
    beforeAll(async () => {
      harness = await startSeamHarness();
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(() => {
      harness.fixture.reset();
      harness.dialed.length = 0;
    });

    it.each([
      'http://127.0.0.1/secret',
      'http://[::1]/secret',
      'http://[::ffff:127.0.0.1]:8080/secret',
      'http://2130706433/secret',
      'http://0x7f.1/secret',
      'http://169.254.169.254/latest/meta-data/',
      'http://internal.example/secret',
      'http://mixed.example/secret',
    ])('public.example → %s', async (target) => {
      harness.fixture.redirect('/start', target, 302);
      const result = expectFailure(await harness.fetch('http://public.example/start'));
      expect(result.code).toBe('FEED_BLOCKED_ADDRESS');
      const to = new URL(target).href;
      expect(result.finalUrl).toBe(to);
      expect(result.redirects).toEqual([{ status: 302, from: 'http://public.example/start', to }]);
      // Only the public hop reached the (fixture) network; the private target got nothing.
      expect(harness.fixture.requests.map((request) => request.path)).toEqual(['/start']);
      expect(harness.dialed.map((target_) => target_.address)).toEqual(['93.184.216.34']);
    });

    it('a public IP literal redirecting to a private name is rejected as well', async () => {
      harness.fixture.redirect('/start', 'http://internal.example/', 301);
      const result = await harness.fetch('http://93.184.216.34/start');
      expect(result).toMatchObject({ ok: false, code: 'FEED_BLOCKED_ADDRESS' });
      expect(harness.dialed.map((target) => target.address)).toEqual(['93.184.216.34']);
    });

    it('a public → public redirect is followed, re-resolving on the new connection', async () => {
      harness.fixture.redirect('/start', 'http://other.example/feed', 301);
      harness.fixture.route('/feed', { body: '<rss/>' });
      const result = expectOk(await harness.fetch('http://public.example/start'));
      expect(result.finalUrl).toBe('http://other.example/feed');
      expect(harness.dialed.map((target) => [target.hostname, target.address])).toEqual([
        ['public.example', '93.184.216.34'],
        ['other.example', '93.184.216.35'],
      ]);
    });

    it('IPv6 public names are connectable through the seam', async () => {
      harness.fixture.route('/feed', { body: '<rss/>' });
      expectOk(await harness.fetch('http://v6.example/feed'));
      expect(harness.dialed).toMatchObject([
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
    });
  });

  describe('isBlockedAddress: only global unicast destinations pass', () => {
    it.each([
      '93.184.216.34',
      '1.1.1.1',
      '8.8.8.8',
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '126.255.255.255',
      '128.0.0.0',
      '169.253.255.255',
      '169.255.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '192.169.0.0',
      '198.17.255.255',
      '198.20.0.0',
      '223.255.255.255',
      '::ffff:93.184.216.34',
      '2606:4700:4700::1111',
      '2a00:1450:4001:80b::200e',
      '2001:200::1',
      '2001:db9::1',
      '2003::1',
      '3fff:1000::1',
      '[2606:4700:4700::1111]',
    ])('allows %s', (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    });

    it.each([
      'fe80::1%eth0',
      'fe80::1%1',
      '2606:4700:4700::1111%eth0',
      '2001:1ff:ffff::1',
      '1fff:ffff::1',
      '4000::1',
      '5f00::1',
      '2130706433',
      '0x7f.1',
      '127.1',
      '010.0.0.1',
      'localhost',
      '',
      '[::1]',
      '192.175.48.1',
      '192.52.193.1',
    ])('blocks %s', (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  });
});
