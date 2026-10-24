import { describe, expect, it } from 'vitest';

import {
  CALL_KINDS,
  DECISION_KINDS,
  KIND_AUTHORIZATIONS,
  NON_LIVE_KINDS,
  kindMatchesAuthorization,
} from '../src/call-kinds.js';

const AUTHORIZATION_TYPES = [
  'article',
  'suggest',
  'credential_probe',
  'eval',
  'card_draft',
  'model_probe',
] as const;

describe('call kind table', () => {
  it('pins the kinds in table order', () => {
    expect(CALL_KINDS).toEqual([
      'enrich',
      'match',
      'cluster',
      'suggest',
      'translate',
      'eval',
      'credential_probe',
      'card_draft',
      'model_probe',
    ]);
  });

  it('pins the decision, non-live and authorization sets', () => {
    expect(DECISION_KINDS).toEqual(['enrich', 'match', 'cluster', 'suggest']);
    expect(NON_LIVE_KINDS).toEqual(['eval', 'credential_probe', 'model_probe']);
    expect(NON_LIVE_KINDS).not.toContain('card_draft');
    expect(NON_LIVE_KINDS).not.toContain('translate');
    expect(KIND_AUTHORIZATIONS).toEqual([
      ['eval', 'eval'],
      ['credential_probe', 'credential_probe'],
      ['card_draft', 'card_draft'],
      ['model_probe', 'model_probe'],
    ]);
    expect(new Set(KIND_AUTHORIZATIONS.map(([, type]) => type)).size).toBe(4);
  });

  it('pairs every kind with every authorization type', () => {
    const own = new Map(KIND_AUTHORIZATIONS);
    for (const kind of CALL_KINDS) {
      for (const type of AUTHORIZATION_TYPES) {
        const ownType = own.get(kind);
        const ownerOfType = KIND_AUTHORIZATIONS.find(([, t]) => t === type)?.[0];
        let expected: boolean;
        if (ownType !== undefined) expected = type === ownType;
        else expected = ownerOfType === undefined;
        expect(kindMatchesAuthorization(kind, type), `${kind} under ${type}`).toBe(expected);
      }
    }
    for (const kind of ['enrich', 'match', 'cluster', 'suggest', 'translate'] as const) {
      expect(kindMatchesAuthorization(kind, 'article')).toBe(true);
      expect(kindMatchesAuthorization(kind, 'suggest')).toBe(true);
    }
  });

  it('refuses a probe authorization for a production kind and the reverse', () => {
    expect(kindMatchesAuthorization('enrich', 'credential_probe')).toBe(false);
    expect(kindMatchesAuthorization('translate', 'credential_probe')).toBe(false);
    expect(kindMatchesAuthorization('credential_probe', 'article')).toBe(false);
    expect(kindMatchesAuthorization('card_draft', 'model_probe')).toBe(false);
    expect(kindMatchesAuthorization('model_probe', 'eval')).toBe(false);
    expect(kindMatchesAuthorization('credential_probe', 'credential_probe')).toBe(true);
    expect(kindMatchesAuthorization('card_draft', 'card_draft')).toBe(true);
  });
});
