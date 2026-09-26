import type { LookupAddress, LookupOptions } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { createSafeConnector } from '../../src/http/connector.js';
import { SafeFetchError } from '../../src/http/errors.js';
import { resolveSafely, safeLookup, systemResolver, type Resolver } from '../../src/http/lookup.js';
import { mapResolver } from './helpers.js';

interface LookupOutcome {
  error: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family: number | undefined;
}

function lookup(
  resolver: Resolver,
  hostname: string,
  lookupOptions: LookupOptions,
  allowPrivate = false,
): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    safeLookup(resolver, { allowPrivate })(hostname, lookupOptions, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

const HOSTS = {
  'dual.example': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  'v4.example': '93.184.216.34',
  'private.example': ['93.184.216.34', '10.0.0.1'],
};

describe('spec 03 §4.2(b) safeLookup', () => {
  it('with {all: true} returns an array of every allowed address', async () => {
    const { resolver } = mapResolver(HOSTS);
    const outcome = await lookup(resolver, 'dual.example', { all: true });
    expect(outcome.error).toBeNull();
    expect(Array.isArray(outcome.address)).toBe(true);
    expect(outcome.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  it('without all returns the first address and its family', async () => {
    const { resolver } = mapResolver(HOSTS);
    const outcome = await lookup(resolver, 'dual.example', {});
    expect(outcome).toEqual({ error: null, address: '93.184.216.34', family: 4 });
  });

  it('honours the requested family', async () => {
    const { resolver } = mapResolver(HOSTS);
    expect(await lookup(resolver, 'dual.example', { family: 6 })).toMatchObject({
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
    });
    expect(await lookup(resolver, 'dual.example', { family: 'IPv4', all: true })).toMatchObject({
      address: [{ address: '93.184.216.34', family: 4 }],
    });
    const none = await lookup(resolver, 'v4.example', { family: 6 });
    expect(none.error).toBeInstanceOf(SafeFetchError);
    expect(none.error?.code).toBe('FEED_DNS_ERROR');
  });

  it('rejects when any resolved address is blocked', async () => {
    const { resolver } = mapResolver(HOSTS);
    const outcome = await lookup(resolver, 'private.example', { all: true });
    expect(outcome.error).toBeInstanceOf(SafeFetchError);
    expect(outcome.error?.code).toBe('FEED_BLOCKED_ADDRESS');
    expect(outcome.error?.message).not.toContain('10.0.0.1');
  });

  it('FETCH_ALLOW_PRIVATE lets private answers through', async () => {
    const { resolver } = mapResolver(HOSTS);
    const outcome = await lookup(resolver, 'private.example', { all: true }, true);
    expect(outcome.error).toBeNull();
    expect(outcome.address).toHaveLength(2);
  });

  it('validates IP-literal hostnames directly, without the resolver', async () => {
    const { resolver, calls } = mapResolver({});
    expect(await lookup(resolver, '93.184.216.34', { all: true })).toMatchObject({
      error: null,
      address: [{ address: '93.184.216.34', family: 4 }],
    });
    const blocked = await lookup(resolver, '::1', {});
    expect(blocked.error?.code).toBe('FEED_BLOCKED_ADDRESS');
    expect(await lookup(resolver, '::1', {}, true)).toMatchObject({ address: '::1', family: 6 });
    expect(calls).toEqual([]);
  });

  it('maps resolver failures and empty or invalid answers to FEED_DNS_ERROR', async () => {
    const failing: Resolver = () =>
      Promise.reject(Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' }));
    const failed = await lookup(failing, 'x.example', {});
    expect(failed.error?.code).toBe('FEED_DNS_ERROR');
    expect(failed.error?.message).toBe('DNS lookup failed (ESERVFAIL)');
    const uncoded = await lookup(() => Promise.reject(new Error('boom')), 'x.example', {});
    expect(uncoded.error?.message).toBe('DNS lookup failed');
    for (const answer of [[], [{ address: 'not-an-ip', family: 4 }], [null], 'nonsense']) {
      const outcome = await lookup(
        () => Promise.resolve(answer as unknown as Awaited<ReturnType<Resolver>>),
        'x.example',
        {},
      );
      expect(outcome.error?.code).toBe('FEED_DNS_ERROR');
    }
  });

  it('tolerates a missing options object', async () => {
    const { resolver } = mapResolver(HOSTS);
    const outcome = await lookup(resolver, 'v4.example', undefined as unknown as LookupOptions);
    expect(outcome).toEqual({ error: null, address: '93.184.216.34', family: 4 });
  });

  it('wraps unexpected failures of the resolution step as FEED_DNS_ERROR', async () => {
    const hostile = [
      {
        family: 4,
        get address(): string {
          throw new Error('getter bug');
        },
      },
    ];
    const outcome = await lookup(() => Promise.resolve(hostile as never), 'x.example', {});
    expect(outcome.error).toBeInstanceOf(SafeFetchError);
    expect(outcome.error?.code).toBe('FEED_DNS_ERROR');
  });

  it('the default resolver is the operating system (localhost, no network)', async () => {
    const answers = await systemResolver('localhost');
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(['127.0.0.1', '::1']).toContain(answer.address);
    const outcome = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeLookup()('localhost', {}, (error) => resolve(error));
    });
    expect(outcome?.code).toBe('FEED_BLOCKED_ADDRESS');
  });

  it('resolveSafely returns the validated answers', async () => {
    const { resolver } = mapResolver(HOSTS);
    await expect(resolveSafely('dual.example', resolver, false)).resolves.toHaveLength(2);
    await expect(resolveSafely('private.example', resolver, false)).rejects.toMatchObject({
      code: 'FEED_BLOCKED_ADDRESS',
    });
  });
});

describe('spec 03 §4.2 the safe connector', () => {
  const connect = (
    hostname: string,
    resolver: Resolver,
    dial?: Parameters<typeof createSafeConnector>[0]['dial'],
  ): Promise<Error | null> =>
    new Promise((resolve) => {
      const connector = createSafeConnector({
        resolver,
        allowPrivate: false,
        connectTimeoutMs: 1_000,
        dial,
      });
      connector({ hostname, host: hostname, protocol: 'http:', port: '' }, (error, socket) => {
        socket?.destroy();
        resolve(error);
      });
    });

  it('the dial seam still validates the real resolved addresses first', async () => {
    const dialed: string[] = [];
    const error = await connect(
      'internal.example',
      mapResolver({ 'internal.example': '10.0.0.5' }).resolver,
      (target) => {
        dialed.push(target.address);
        return { host: '127.0.0.1', port: 9 };
      },
    );
    expect(error).toMatchObject({ code: 'FEED_BLOCKED_ADDRESS' });
    expect(dialed).toEqual([]);
  });

  it('dial seam errors reach the callback', async () => {
    const error = await connect(
      'public.example',
      mapResolver({ 'public.example': '93.184.216.34' }).resolver,
      () => {
        throw new Error('dial failed in test');
      },
    );
    expect(error?.message).toBe('dial failed in test');
  });

  it('DNS failures in the seam path reach the callback', async () => {
    const error = await connect('nx.example', mapResolver({}).resolver, () => ({
      host: '127.0.0.1',
      port: 9,
    }));
    expect(error).toMatchObject({ code: 'FEED_DNS_ERROR' });
  });
});
