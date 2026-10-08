import { describe, expect, it } from 'vitest';

import { BUNDLES } from '../../src/features/onboarding/bundles.js';

// The query parameters the API refuses in a feed address (packages/feeds discover/feed-url.ts).
const CREDENTIAL_PARAMS = ['token', 'access_token', 'api_key', 'auth', 'password'];

const hostOf = (address: string) => new URL(address).hostname;

describe('starter bundles (spec 09 §4 step 2)', () => {
  it('are ten, with distinct ids', () => {
    expect(BUNDLES).toHaveLength(10);
    expect(new Set(BUNDLES.map((bundle) => bundle.id)).size).toBe(10);
    for (const bundle of BUNDLES) expect(bundle.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('include Slovak news, Czech news, Tech and Science', () => {
    expect(BUNDLES.map((bundle) => bundle.names.en)).toEqual(
      expect.arrayContaining(['Slovak news', 'Czech news', 'Tech', 'Science']),
    );
    expect(BUNDLES.map((bundle) => bundle.id)).toEqual(
      expect.arrayContaining(['slovak-news', 'czech-news', 'tech', 'science']),
    );
  });

  it('are named in English and in Slovak, each name once', () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
    for (const bundle of BUNDLES) {
      expect(bundle.names.en.trim(), `${bundle.id} in English`).not.toBe('');
      expect(bundle.names.sk.trim(), `${bundle.id} in Slovak`).not.toBe('');
      expect(bundle.names.en, `${bundle.id} in English`).toBe(bundle.names.en.trim());
      expect(bundle.names.sk, `${bundle.id} in Slovak`).toBe(bundle.names.sk.trim());
    }
    expect(new Set(BUNDLES.map((bundle) => bundle.names.en)).size).toBe(BUNDLES.length);
    expect(new Set(BUNDLES.map((bundle) => bundle.names.sk)).size).toBe(BUNDLES.length);
  });

  it('hold 3 to 8 distinct https addresses each', () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
    for (const bundle of BUNDLES) {
      expect(bundle.urls.length, bundle.id).toBeGreaterThanOrEqual(3);
      expect(bundle.urls.length, bundle.id).toBeLessThanOrEqual(8);
      expect(new Set(bundle.urls).size, `${bundle.id} repeats an address`).toBe(bundle.urls.length);
      for (const address of bundle.urls) {
        expect(URL.canParse(address), address).toBe(true);
        expect(new URL(address).protocol, address).toBe('https:');
        expect(address, address).toBe(address.trim());
      }
    }
  });

  it('name public websites only, without credentials or tokens in the address', () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
    for (const address of BUNDLES.flatMap((bundle) => bundle.urls)) {
      const url = new URL(address);
      expect(url.username + url.password, address).toBe('');
      expect(url.port, address).toBe('');
      expect(url.hash, address).toBe('');
      for (const name of CREDENTIAL_PARAMS) {
        expect(url.searchParams.has(name), `${address} has ${name}`).toBe(false);
      }
      expect(url.hostname, address).toContain('.');
      expect(url.hostname, address).not.toMatch(/^\d+\.\d+\.\d+\.\d+$|^\[|localhost$|\.local$/);
    }
  });

  it('share no address between bundles', () => {
    const all = BUNDLES.flatMap((bundle) => bundle.urls);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);
  });

  it('draw on more than one publisher each', () => {
    expect(BUNDLES.length).toBeGreaterThan(0);
    for (const bundle of BUNDLES) {
      expect(new Set(bundle.urls.map(hostOf)).size, bundle.id).toBeGreaterThanOrEqual(2);
    }
  });
});
