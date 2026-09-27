import { describe, expect, it } from 'vitest';

import { registrableDomain } from '../../src/canonical/registrable-domain.js';

describe('registrableDomain', () => {
  it('reduces a host to its registrable domain', () => {
    expect(registrableDomain('https://news.example.co.uk/feed.xml')).toBe('example.co.uk');
    expect(registrableDomain('https://www.sme.sk/')).toBe('sme.sk');
  });

  it('keeps a private-suffix site as its own domain', () => {
    expect(registrableDomain('https://someone.github.io/blog')).toBe('someone.github.io');
  });

  it('returns null for missing, unparsable, IP and bare-suffix inputs', () => {
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('not a url')).toBeNull();
    expect(registrableDomain('http://192.0.2.1/feed')).toBeNull();
    expect(registrableDomain('https://co.uk/')).toBeNull();
  });
});
