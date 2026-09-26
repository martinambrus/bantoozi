import { describe, expect, it } from 'vitest';

import { canonicalJson, normalizeText } from '../src/index.js';
import { canonicalSha256, cardTextHash, normCardText, sha256Hex } from '../src/server/index.js';

describe('normalizeText (spec 03 §6.1)', () => {
  it('strips Slovak and Czech diacritics and lower-cases', () => {
    expect(normalizeText('Žltý kôň úpel ďábelské ódy')).toBe('zlty kon upel dabelske ody');
    expect(normalizeText('Ľudovít Štúr: „Nárečja slovenskuo“!')).toBe(
      'ludovit stur narecja slovenskuo',
    );
    expect(normalizeText('Příliš žluťoučký kůň úpěl ďábelské ódy')).toBe(
      'prilis zlutoucky kun upel dabelske ody',
    );
    expect(normalizeText('ĽĹŔÁÄÔÓÚÝÉÍŇŤĎČŠŽ')).toBe('llraaoouyeintdcsz');
  });

  it('collapses non-alphanumeric runs to one space and trims', () => {
    expect(normalizeText('  EV -- battery   chemistry!!! (2026) ')).toBe(
      'ev battery chemistry 2026',
    );
    expect(normalizeText('a_b.c,d')).toBe('a b c d');
  });

  it('keeps non-Latin letters (Unicode letters, not ASCII \\w)', () => {
    expect(normalizeText('Привет, мир!')).toBe('привет мир');
    expect(normalizeText('東京 2026')).toBe('東京 2026');
    expect(normalizeText('Ελλάδα')).toBe('ελλαδα');
  });

  it('applies NFKD compatibility decomposition', () => {
    expect(normalizeText('ﬁnance ②')).toBe('finance 2');
  });
});

describe('canonicalJson (spec 05 §2)', () => {
  it('is stable under key order, recursively, with no whitespace', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps array order and omits undefined properties', () => {
    expect(canonicalJson([2, 1, 3])).toBe('[2,1,3]');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('rejects values that cannot round-trip', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes canonical JSON independently of key order', () => {
    expect(canonicalSha256({ x: 1, y: [1, 2] })).toBe(canonicalSha256({ y: [1, 2], x: 1 }));
  });
});

describe('cardTextHash (spec 05 §5.1)', () => {
  const base = {
    kind: 'interest' as const,
    title: 'EV batteries',
    interest: 'New battery chemistry for electric vehicles',
    not_for: 'Stock-price moves',
    examples_yes: ['Solid-state pilot line hits 1,000 cycles'],
    examples_no: [],
    visibility: 'shared' as const,
  };

  it('normalizes interest/not_for text (NFC, trim, whitespace, case)', () => {
    expect(normCardText('  New\tBattery   chemistry \n')).toBe('new battery chemistry');
    expect(
      cardTextHash({ ...base, interest: '  NEW battery   chemistry for electric VEHICLES ' }),
    ).toBe(cardTextHash(base));
    // NFC: a decomposed "é" equals the precomposed one.
    expect(cardTextHash({ ...base, interest: 'Café news' })).toBe(
      cardTextHash({ ...base, interest: 'Café news' }),
    );
  });

  it('ignores the title of interest cards but includes it for labels', () => {
    expect(cardTextHash({ ...base, title: 'Other name' })).toBe(cardTextHash(base));
    const label = { ...base, kind: 'label' as const };
    expect(cardTextHash({ ...label, title: 'Work' })).not.toBe(
      cardTextHash({ ...label, title: 'Home' }),
    );
    expect(cardTextHash({ ...label, title: 'Work' })).toBe(
      cardTextHash({ ...label, title: ' WORK ' }),
    );
    expect(cardTextHash(label)).not.toBe(cardTextHash(base));
  });

  it('includes the owner only for private cards', () => {
    const ownerA = '0190d4a7-0000-7000-8000-00000000000a';
    const ownerB = '0190d4a7-0000-7000-8000-00000000000b';
    expect(cardTextHash({ ...base, owner_user_id: ownerA })).toBe(cardTextHash(base));
    const forkA = cardTextHash({ ...base, visibility: 'private', owner_user_id: ownerA });
    const forkB = cardTextHash({ ...base, visibility: 'private', owner_user_id: ownerB });
    expect(forkA).not.toBe(forkB);
    expect(forkA).not.toBe(cardTextHash(base));
    expect(() => cardTextHash({ ...base, visibility: 'private' })).toThrow();
  });

  it('treats missing not_for/examples like empty ones and hashes examples as written', () => {
    const minimal = {
      kind: 'interest' as const,
      title: 't',
      interest: 'x y z',
      visibility: 'shared' as const,
    };
    expect(cardTextHash(minimal)).toBe(
      cardTextHash({ ...minimal, not_for: '', examples_yes: [], examples_no: null }),
    );
    expect(cardTextHash({ ...base, examples_yes: ['A'] })).not.toBe(
      cardTextHash({ ...base, examples_yes: ['a'] }),
    );
  });
});
