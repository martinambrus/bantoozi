import type { OriginLimiter, OriginReservation } from '@bantoozi/shared';
import { startFixtureServer, type FixtureServer, FIXTURES_DIR } from '@bantoozi/testing';

import type { DialTarget } from '../../src/http/connector.js';
import type { ResolvedAddress, Resolver } from '../../src/http/lookup.js';
import {
  safeFetchWithInternals,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '../../src/http/safe-fetch.js';

export const USER_AGENT = 'BantooziBot/1.0 (+http://localhost/bot)';

/** Tests never use real DNS: a forgotten resolver fails as FEED_DNS_ERROR instead. */
export const noNetworkResolver: Resolver = (hostname) =>
  Promise.reject(new Error(`test attempted a real DNS lookup of ${hostname}`));

/** Minimal valid options; tests override what they exercise. */
export function options(overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return {
    purpose: 'feed',
    userAgent: USER_AGENT,
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
    resolver: noNetworkResolver,
    ...overrides,
  };
}

export interface RecordingResolver {
  resolver: Resolver;
  /** Hostnames asked for, in order. */
  calls: string[];
}

/** A resolver answering from a map (addresses as strings); unknown names fail like ENOTFOUND. */
export function mapResolver(map: Record<string, string | string[]>): RecordingResolver {
  const calls: string[] = [];
  const resolver: Resolver = (hostname) => {
    calls.push(hostname);
    const entry = map[hostname];
    if (entry === undefined) {
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
          code: 'ENOTFOUND',
        }),
      );
    }
    const answers: ResolvedAddress[] = (Array.isArray(entry) ? entry : [entry]).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    return Promise.resolve(answers);
  };
  return { resolver, calls };
}

/**
 * The SSRF test harness: a fixture server on a random loopback port plus the test-only dial seam.
 * Checks run on the real (public) resolved or literal addresses with FETCH_ALLOW_PRIVATE off; only
 * the socket of an already validated address is sent to the fixture server.
 */
export interface SeamHarness {
  fixture: FixtureServer;
  dialed: DialTarget[];
  fetch(url: string, overrides?: Partial<SafeFetchOptions>): Promise<SafeFetchResult>;
  close(): Promise<void>;
}

/** Public test names (documentation-free addresses that pass every check). */
export const PUBLIC_HOSTS: Record<string, string | string[]> = {
  'public.example': '93.184.216.34',
  'other.example': '93.184.216.35',
  'v6.example': '2606:2800:220:1:248:1893:25c8:1946',
  'internal.example': '10.0.0.5',
  'mixed.example': ['93.184.216.34', '192.168.1.10'],
};

export async function startSeamHarness(
  hosts: Record<string, string | string[]> = PUBLIC_HOSTS,
): Promise<SeamHarness> {
  const fixture = await startFixtureServer({ root: FIXTURES_DIR });
  const dialed: DialTarget[] = [];
  const { resolver } = mapResolver(hosts);
  return {
    fixture,
    dialed,
    fetch: (url, overrides = {}) =>
      safeFetchWithInternals(url, options({ resolver, ...overrides }), {
        dial: (target) => {
          dialed.push(target);
          return { host: '127.0.0.1', port: fixture.port };
        },
      }),
    close: () => fixture.close(),
  };
}

export interface LimiterCalls {
  reserve: { origin: string; leaseMs: number }[];
  release: { origin: string; token: string }[];
  block: { origin: string; until: Date }[];
}

/** A scripted in-memory `OriginLimiter` that records every call. */
export function fakeLimiter(
  script: (origin: string, attempt: number) => OriginReservation = () => ({
    status: 'granted',
    token: 'token',
  }),
): { limiter: OriginLimiter; calls: LimiterCalls } {
  const calls: LimiterCalls = { reserve: [], release: [], block: [] };
  let attempt = 0;
  const limiter: OriginLimiter = {
    reserve: (origin, { leaseMs }) => {
      calls.reserve.push({ origin, leaseMs });
      attempt += 1;
      return Promise.resolve(script(origin, attempt));
    },
    release: (origin, token) => {
      calls.release.push({ origin, token });
      return Promise.resolve();
    },
    block: (origin, until) => {
      calls.block.push({ origin, until });
      return Promise.resolve();
    },
  };
  return { limiter, calls };
}

/** Narrows a result for assertions (fails the test with the actual result otherwise). */
export function expectOk(result: SafeFetchResult): Extract<SafeFetchResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

export function expectFailure(result: SafeFetchResult): Extract<SafeFetchResult, { ok: false }> {
  if (result.ok) throw new Error(`expected a failure, got status ${result.status}`);
  return result;
}

export const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');
