import { groupByParticipant, ownerParticipantKey, participantIndex } from '@bantoozi/db';
import { describe, expect, it } from 'vitest';

import {
  csrfMatches,
  csrfToken,
  hashSecret,
  isTokenShaped,
  issueToken,
  raterUrl,
} from '../src/rating-server/tokens.js';

/** M3a-T3 (spec 10 §2.2, §2.4): link tokens and participant grouping (pure). */

describe('rater tokens', () => {
  it('are 256-bit base64url values whose SHA-256 hash is stored', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const issued = issueToken(now, 30);
    expect(isTokenShaped(issued.token)).toBe(true);
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
    expect(issued.tokenHash).toBe(hashSecret(issued.token));
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.expiresAt.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(issueToken(now).token).not.toBe(issued.token);
  });

  it('build the private URL from EVAL_PUBLIC_URL', () => {
    expect(raterUrl('http://localhost:5180', 'abc')).toBe('http://localhost:5180/r?t=abc');
    expect(raterUrl('https://rate.example.test/', 'abc', 'facets')).toBe(
      'https://rate.example.test/facets?t=abc',
    );
  });

  it('derive a per-session CSRF token that other sessions cannot reuse', () => {
    const a = csrfToken('session-a');
    expect(csrfMatches('session-a', a)).toBe(true);
    expect(csrfMatches('session-b', a)).toBe(false);
    expect(csrfMatches('session-a', undefined)).toBe(false);
    expect(csrfMatches('session-a', `${a}x`)).toBe(false);
  });
});

describe('participants (one human, several topic profiles)', () => {
  const at = (s: string) => new Date(`2026-10-0${s}T00:00:00Z`);
  const raters = [
    { id: '3', participantKey: 'p-friend', createdAt: at('3') },
    { id: '2', participantKey: 'p-owner', createdAt: at('2') },
    { id: '1', participantKey: 'p-owner', createdAt: at('1') },
    { id: '10', participantKey: 'p-owner', createdAt: at('4') },
  ];

  it('groups contexts by participant key, the owner first', () => {
    const groups = groupByParticipant(raters);
    expect(groups.map((g) => [g.participantKey, g.raterIds])).toEqual([
      ['p-owner', ['1', '2', '10']],
      ['p-friend', ['3']],
    ]);
    expect(groups).toHaveLength(2);
    expect(ownerParticipantKey(raters)).toBe('p-owner');
    expect(ownerParticipantKey([])).toBeNull();
    expect(participantIndex(raters).get('10')).toBe('p-owner');
  });

  it('a science and a cooking profile of one human remain one participant', () => {
    const owner = [
      { id: '1', participantKey: 'p', createdAt: at('1') },
      { id: '2', participantKey: 'p', createdAt: at('1') },
    ];
    expect(groupByParticipant(owner)).toHaveLength(1);
  });
});
