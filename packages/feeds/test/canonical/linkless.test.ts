import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LinklessIdentityInput } from '../../src/canonical/index.js';
import {
  LINKLESS_URL_KEY_PREFIX,
  linklessIdentity,
  linklessUrlKey,
} from '../../src/canonical/index.js';

const WITH_GUID: LinklessIdentityInput = {
  guid: 'tag:example.sk,2026-09-25:clanok-8812',
  title: 'Mestské zastupiteľstvo schválilo rozpočet',
  publishedAt: new Date('2026-09-25T08:30:00Z'),
  excerpt: 'Poslanci podporili návrh s úpravami.',
};

const WITHOUT_GUID: LinklessIdentityInput = { ...WITH_GUID, guid: null };

const UNDATED: LinklessIdentityInput = {
  guid: null,
  title: 'Týždenné poznámky',
  publishedAt: null,
  excerpt: null,
};

const UNDATED_WITH_EXCERPT: LinklessIdentityInput = { ...UNDATED, excerpt: 'Krátka aktualizácia.' };

/**
 * spec 03 §5 step 8, pinned literally: `urn:bantoozi:<feedId>:<sha256Hex(identity)>`, where identity
 * is the full GUID, else canonical JSON of `[title, published_at ISO string or null, excerpt]`.
 */
const PINNED: readonly (readonly [
  label: string,
  feedId: string,
  item: LinklessIdentityInput,
  identity: string,
  key: string,
])[] = [
  [
    'a GUID',
    '42',
    WITH_GUID,
    'tag:example.sk,2026-09-25:clanok-8812',
    'urn:bantoozi:42:c37d7a69bf780c658338427a7a3586e35cc6b6b9af56e8055a8dad67f6fe87ba',
  ],
  [
    'title, published_at and excerpt',
    '42',
    WITHOUT_GUID,
    '["Mestské zastupiteľstvo schválilo rozpočet","2026-09-25T08:30:00.000Z","Poslanci podporili návrh s úpravami."]',
    'urn:bantoozi:42:3b248d31fbf19b57747439e7fda1985f3d1b5dcf763a0b65b5d8b4fc7641fa55',
  ],
  [
    'a title with null published_at and excerpt',
    '7',
    UNDATED,
    '["Týždenné poznámky",null,null]',
    'urn:bantoozi:7:e9862d00fa2648a675bf7a6332bf3b7631373bbe6252f96ba7abb5e61bd3488f',
  ],
  [
    'a title and excerpt with null published_at',
    '7',
    UNDATED_WITH_EXCERPT,
    '["Týždenné poznámky",null,"Krátka aktualizácia."]',
    'urn:bantoozi:7:fc5a14c1e9d7212d740be504f2b45e0114d004a3e55c2f07b6233973d9c84b05',
  ],
];

describe('linkless identity keys (spec 03 §5 step 8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(PINNED)('pins the key of %s', (_label, feedId, item, identity, key) => {
    expect(linklessIdentity(item)).toBe(identity);
    expect(linklessUrlKey(feedId, item)).toBe(key);
  });

  it('uses the full GUID, whitespace and case included, however long', () => {
    const long = `urn:uuid:${'x'.repeat(4_000)}`;
    expect(linklessIdentity({ ...UNDATED, guid: long })).toBe(long);
    expect(linklessIdentity({ ...UNDATED, guid: ' Item-1 ' })).toBe(' Item-1 ');
    expect(linklessUrlKey('42', { ...UNDATED, guid: 'Item-1' })).not.toBe(
      linklessUrlKey('42', { ...UNDATED, guid: 'item-1' }),
    );
  });

  it('keeps the GUID identity when title, date and excerpt change', () => {
    const edited = { ...WITH_GUID, title: 'Opravený titulok', publishedAt: null, excerpt: null };
    expect(linklessUrlKey('42', edited)).toBe(linklessUrlKey('42', WITH_GUID));
  });

  it('falls back to the fields for an empty or whitespace-only GUID', () => {
    expect(linklessIdentity({ ...WITH_GUID, guid: '' })).toBe(linklessIdentity(WITHOUT_GUID));
    expect(linklessIdentity({ ...WITH_GUID, guid: ' \n\t' })).toBe(linklessIdentity(WITHOUT_GUID));
  });

  it('distinguishes items that differ in any identity field', () => {
    const keys = [
      WITHOUT_GUID,
      { ...WITHOUT_GUID, title: 'Iný titulok' },
      { ...WITHOUT_GUID, publishedAt: new Date('2026-09-25T08:30:01Z') },
      { ...WITHOUT_GUID, publishedAt: null },
      { ...WITHOUT_GUID, excerpt: null },
      { ...WITHOUT_GUID, excerpt: '' },
    ].map((item) => linklessUrlKey('42', item));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('scopes the identity to the feed', () => {
    expect(linklessUrlKey('43', WITH_GUID)).toBe(
      'urn:bantoozi:43:c37d7a69bf780c658338427a7a3586e35cc6b6b9af56e8055a8dad67f6fe87ba',
    );
    expect(linklessUrlKey('43', WITH_GUID)).not.toBe(linklessUrlKey('42', WITH_GUID));
  });

  it('normalizes published_at to UTC', () => {
    const local = { ...WITHOUT_GUID, publishedAt: new Date('2026-09-25T10:30:00+02:00') };
    expect(linklessUrlKey('42', local)).toBe(linklessUrlKey('42', WITHOUT_GUID));
  });

  it('never substitutes fetch time for a missing published_at', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T09:00:00Z'));
    const first = linklessUrlKey('7', UNDATED);
    vi.setSystemTime(new Date('2026-10-01T18:45:00Z'));
    expect(linklessUrlKey('7', UNDATED)).toBe(first);
    expect(first).toBe(
      'urn:bantoozi:7:e9862d00fa2648a675bf7a6332bf3b7631373bbe6252f96ba7abb5e61bd3488f',
    );
  });

  it('treats an invalid Date as an unknown published_at', () => {
    const invalid = { ...UNDATED, publishedAt: new Date(Number.NaN) };
    expect(linklessIdentity(invalid)).toBe('["Týždenné poznámky",null,null]');
  });

  it('builds urn:bantoozi:<feedId>:<64 hex> keys', () => {
    expect(LINKLESS_URL_KEY_PREFIX).toBe('urn:bantoozi:');
    expect(linklessUrlKey('9007199254740993', UNDATED)).toMatch(
      /^urn:bantoozi:9007199254740993:[0-9a-f]{64}$/,
    );
  });

  it.each(['', '0', '042', '-1', '4.2', '1e3', 'abc', '42:1', ' 42'])(
    'rejects the feed ID %j',
    (feedId) => {
      expect(() => linklessUrlKey(feedId, WITH_GUID)).toThrow(TypeError);
    },
  );
});
